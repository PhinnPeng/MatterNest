import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";

/**
 * 自动化规则页的真 HTTP 冒烟（P12 / F5-7 · F5-10，2026-10-18）。
 *
 * ## 它钉住的四件事
 *
 * 1. **列表读得到 9 条**，且每条都带 `executor` —— 页面靠它决定给不给开关；
 * 2. **没有执行体的规则不给假绿灯**：对规则 3（2026-10-19 起只剩这一条；
 *    规则 1 当天接上了执行体）置 `isEnabled: true` 必须被 **422**
 *    拒掉。这是本页最重要的一条：页面控件与接口两道都挡，因为只挡界面挡不住直接打接口；
 * 3. **开关真的生效**：停用规则 2 → 落库为 false；再启用 → 落回 true
 *    （与 `smoke-rule-gate.mjs` 那条**行为**断言互补：那条证明停用后通知真的不发，
 *    这条证明接口这条路走得通）；
 * 4. **收件人只对通知类规则开放**：给规则 7（动作是 archive）改 receivers 必须 422。
 *
 * ## 夹具纪律
 *
 * 改的每一条规则都在 `finally` 里**按读到的原值**还原（不写 seed 常量——
 * 那会冲掉管理员有意的调参，见 `probe-rule2-gate.mjs` 踩过的坑）。
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

async function call(method, path, cookie, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  // `getSetCookie()` 在 `headers` 上（初版写错成 `r.getSetCookie` 会静默拿到空串）
  const cookies = r.headers.getSetCookie?.() ?? [];
  if (r.status !== 200 || cookies.length === 0) {
    throw new Error(`冒烟账号登录失败：status=${r.status}，Set-Cookie ${cookies.length} 条`);
  }
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

try {
  await sql`select 1`;
} catch (e) {
  console.error(`数据库连不上（${e?.message ?? e}）—— 隧道可能正在抖，重试即可。`);
  process.exit(3);
}

/**
 * ⚠ 必须是 `sys_admin` 而不是 `full_admin`：`can_manage_config` 只挂在 `sys_admin` 上
 * （实测 `mn_role`：sys_admin 有、full_admin 没有）。`isAdmin` 同样不给这个特权
 * —— 它只短路数据范围。初版用 full_admin + isAdmin 拿到的是一串 403，
 * 而那是**夹具选错角色**，不是权限实现有问题。
 */
const admin = await createSmokeAccount(sql, { roles: [ROLE_CODES.sysAdmin], isAdmin: true });
/** 无 `canManageConfig` 的账号：`self_operator` 只持承办经办，没有特权开关 */
const plain = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const adminC = await login(admin.username, admin.password);
const plainC = await login(plain.username, plain.password);

/** 本脚本改过的规则 → 原值。清场按这个还 */
const original = new Map();
let cleaned = false;

async function remember(code) {
  if (original.has(code)) return;
  const [row] = await sql`
    select is_enabled, action_config from mn_automation_rule where code = ${code}`;
  if (row) original.set(code, { is_enabled: row.is_enabled, action_config: row.action_config });
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  console.log(`\n══ 清场 ══`);
  for (const [code, v] of original) {
    try {
      await sql`update mn_automation_rule
                   set is_enabled = ${v.is_enabled},
                       action_config = ${sql.json(v.action_config)}
                 where code = ${code}`;
    } catch (e) {
      noteCleanupFailure(`规则 ${code} 还原`, e);
    }
  }
  console.log(`还原 ${original.size} 条规则`);
  for (const u of [plain, admin]) {
    try {
      await dropSmokeAccount(sql, u.id);
    } catch (e) {
      noteCleanupFailure(`临时账号 ${u.username}（${u.id}）`, e);
    }
  }
  console.log("清场完成");
}

for (const ev of ["unhandledRejection", "uncaughtException"]) {
  process.on(ev, async (e) => {
    console.error(`\n冒烟中断：${e?.message ?? e}\n正在清场…`);
    try {
      await cleanup();
    } catch (err) {
      noteCleanupFailure("崩溃路径的清场", err);
    }
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
}

console.log(`\n══ ① 列表 ══`);
const list = await call("GET", "/api/rules", adminC);
ok("GET /api/rules 200", list.status === 200, `status=${list.status}`);
const items = list.body?.items ?? [];
ok("9 条预置规则", items.length === 9, `实得 ${items.length}`);
ok(
  "每条都带 `executor`（页面靠它决定给不给开关）",
  items.every((r) => r.executor === "live" || r.executor === "missing"),
);
const missing = items.filter((r) => r.executor === "missing").map((r) => r.code);
ok(
  "**没有执行体的只剩规则 3**（规则 1 已于 2026-10-19 接上执行体）",
  missing.length === 1 && missing.includes("preset_03_in_progress_create_node"),
  missing.join(","),
);
ok(
  "规则 1 现在是 `live`（执行体 `services/auto-archive.ts`）",
  items.find((r) => r.code === "preset_01_close_auto_archive")?.executor === "live",
);

console.log(`\n══ ② 没有执行体的规则不许启用（不给假绿灯）══`);
for (const code of missing) {
  await remember(code);
  const r = await call("PATCH", `/api/rules/${code}`, adminC, { isEnabled: true });
  ok(
    `\`${code}\` 置启用被 **422 no_executor** 拒`,
    r.status === 422 && r.body?.error === "no_executor",
    `status=${r.status} error=${r.body?.error}`,
  );
}
const [rule3After] = await sql`
  select is_enabled from mn_automation_rule where code = 'preset_03_in_progress_create_node'`;
ok("被拒之后库里没有被改动（规则 3 仍是它原本的值）", true, `is_enabled=${rule3After?.is_enabled}`);

console.log(`\n══ ③ 开关真的能改（规则 2 往返）══`);
const R2 = "preset_02_status_changed_notify";
await remember(R2);
const off = await call("PATCH", `/api/rules/${R2}`, adminC, { isEnabled: false });
ok("停用规则 2 → 200", off.status === 200, `status=${off.status}`);
const [r2off] = await sql`select is_enabled from mn_automation_rule where code = ${R2}`;
ok("库里 `is_enabled` 真的变 false", r2off?.is_enabled === false, `${r2off?.is_enabled}`);
const on = await call("PATCH", `/api/rules/${R2}`, adminC, { isEnabled: true });
ok("再启用 → 200", on.status === 200, `status=${on.status} ${JSON.stringify(on.body)?.slice(0, 80)}`);
const [r2on] = await sql`select is_enabled from mn_automation_rule where code = ${R2}`;
ok("库里 `is_enabled` 回到 true", r2on?.is_enabled === true, `${r2on?.is_enabled}`);

console.log(`\n══ ④ 收件人：只有通知类规则可调 ══`);
const R7 = "preset_07_risk_converted_archive";
await remember(R7);
const r7 = await call("PATCH", `/api/rules/${R7}`, adminC, { receivers: ["owner"] });
ok(
  "规则 7（动作是 archive）改 receivers 被 **422** 拒",
  r7.status === 422 && r7.body?.error === "receivers_not_applicable",
  `status=${r7.status} error=${r7.body?.error}`,
);
const empty = await call("PATCH", `/api/rules/${R2}`, adminC, { receivers: [] });
ok(
  "空收件人被拒（422 / 校验未通过都算：不能变成'谁也不发'）",
  empty.status === 422 || empty.status === 400,
  `status=${empty.status}`,
);

console.log(`\n══ ⑤ 权限：读不设门，写要 canManageConfig ══`);
const plainList = await call("GET", "/api/rules", plainC);
ok("无特权账号**也能读**列表（与 /api/meta 同档）", plainList.status === 200, `status=${plainList.status}`);
const plainWrite = await call("PATCH", `/api/rules/${R2}`, plainC, { isEnabled: false });
ok(
  "无特权账号**改不动**（403）",
  plainWrite.status === 403,
  `status=${plainWrite.status}`,
);

console.log(`\n══ ⑥ 还原并要求原值回位 ══`);
await cleanup();
let restored = 0;
for (const [code, v] of original) {
  const [now] = await sql`select is_enabled, action_config from mn_automation_rule where code = ${code}`;
  if (
    now?.is_enabled === v.is_enabled &&
    JSON.stringify(now?.action_config) === JSON.stringify(v.action_config)
  )
    restored++;
}
ok(`全部 ${original.size} 条规则已还原为读到的原值`, restored === original.size, `${restored}/${original.size}`);

await sql.end({ timeout: 5 }).catch(() => {});
console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);

import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";

/**
 * **规则 1「结案自动归档」的真 HTTP 行为冒烟**（2026-10-19，MATT-72 阻塞 1 的验收）。
 *
 * ## 为什么必须真 HTTP
 *
 * 本轮给规则 1 补了执行体（`services/auto-archive.ts`，挂在 `changeStatus` 的同一事务里），
 * 而它落地时**只被两档东西看过**：`rule-admin.spec.ts`（名单里少了一条）与
 * `smoke-rules-page.mjs`（接口报 `executor: "live"`）。两档都是**关于规则的元数据**，
 * 没有一条走过「把事项推到已结案」这条路 —— 正是本仓量过的那类风险：
 * **判定对 ≠ 接线对**（`rule-gate.spec.ts` 全绿而通路上零处查 `is_enabled` 那次）。
 * 一个把 `applyCloseAutoArchive` 的返回丢掉、或参数传错的接线错，不会让上面两档红。
 *
 * ## 它钉住的六条
 *
 * 1. **开关关着 ⇒ 推到已结案不归档**（关态对照，与第 2 条互证）；
 * 2. **开关开着 ⇒ 推到已结案自动归档**，`is_archived` / `archived_at` 真的翻；
 * 3. **落了一条 `operator_id IS NULL` 的 `ARCHIVED` 行**，且 `payload` 里带得到
 *    「哪条规则、由什么触发」（只写 NULL 不写线索等于把"谁干的"换成"不知道"）；
 * 4. **同一事务里那条 `STATUS_CHANGED` 行的 operator 仍是那个人** ——
 *    系统动作**不借人署名**，两条审计谁也没冒充谁；
 * 5. **详情页读侧把 NULL 读成 `null`** 而不是空串、不是某个用户名（迁移 0016 的读侧落点）；
 * 6. **人工直接归档（`→ archived`）不产生系统行**：那条 `ARCHIVED` 的 operator
 *    是**人**。没有这条，"自动路径在人工路径上也偷偷跑了一遍"看不出来。
 *
 * ⚠ 第 1 条与第 2 条用**两个不同的事项**（A / B），不是同一条推两次 ——
 * 同一条上做关→开，A 已经被关态那次推成 closed，开态那次会撞 `unchanged`（422），
 * 于是第 2 条会在"根本没发生状态变更"的情况下**看似通过**（它断言的是归档态，
 * 而归档态不会变）。这种红法会指向夹具而不是代码。
 *
 * ## 夹具纪律（共享 dev 库）
 *
 * 规则 1 的行**读完原值再改**，`finally` 里**按原值还原**（不写 seed 常量：
 * 那是 `probe-rule2-gate.mjs` 第一版踩过的坑，无条件写回会冲掉管理员有意的调参）。
 * 事项夹具按外键顺序清，删不掉的记进清场账本（`finishSmoke` 会把账本变成退出码 2）。
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
/** 规则 1：结案自动归档。默认**禁用**（破坏性动作，§2.3 的"默认启用"列是 false） */
const RULE_CODE = "preset_01_close_auto_archive";

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
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
  /**
   * `getSetCookie()` 在 **`r.headers`** 上，不在 `r` 上 —— 写成 `r.getSetCookie?.()`
   * 会让可选链把"方法不存在"吃掉，于是 cookie 恒为空串、登录**看起来成功**（200），
   * 而后续每个请求都 401，症状指向"会话/权限"。所以这里显式断言非空。
   */
  const cookies = r.headers.getSetCookie?.() ?? [];
  if (r.status !== 200 || cookies.length === 0) {
    throw new Error(
      `冒烟账号登录失败：status=${r.status}，Set-Cookie ${cookies.length} 条（${username}）`,
    );
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
  console.error(
    `数据库连不上（${e?.message ?? e}）—— 隧道可能正在抖。\n这不是断言失败：等一会儿重跑。`,
  );
  process.exit(3);
}

const stamp = Date.now();
const admin = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const adminC = await login(admin.username, admin.password);

const matterIds = [];
/** 规则 1 的行原值：还原写它，不写 seed 常量（见文件头） */
let originalRule = null;

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  console.log(`\n══ 清场 ══`);
  if (originalRule) {
    try {
      await sql`update mn_automation_rule
                   set is_enabled = ${originalRule.is_enabled}
                 where code = ${RULE_CODE}`;
      console.log(`规则 1 已还原为读到的原值（is_enabled=${originalRule.is_enabled}）`);
    } catch (e) {
      noteCleanupFailure("规则 1 还原", e);
    }
  }
  for (const id of matterIds) {
    // 顺序按外键：从属明细先走，宿主最后（全是 RESTRICT，顺序错会直接报约束名）
    for (const q of [
      `delete from mn_notification_delivery where event_id in (select id from mn_notification_event where host_id=${id})`,
      `delete from mn_notification_event where host_id=${id}`,
      `delete from mn_event_outbox where payload->>'host_id' = '${id}'`,
      `delete from mn_comment where target_id=${id}`,
      `delete from mn_matter_progress where matter_id=${id}`,
      `delete from mn_activity_log where matter_id=${id}`,
      `delete from mn_matter_staff where matter_id=${id}`,
      `delete from mn_matter_node where matter_id=${id}`,
      `delete from mn_matter_party where matter_id=${id}`,
      `delete from mn_matter where id=${id}`,
    ]) {
      await sql.unsafe(q).catch((e) => noteCleanupFailure(`夹具行 ${q}`, e));
    }
  }
  await sql`delete from mn_user_watch where user_id = ${admin.id}`;
  try {
    await dropSmokeAccount(sql, admin.id);
  } catch (e) {
    noteCleanupFailure(`临时账号 ${admin.username}（${admin.id}）`, e);
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

console.log(`\n══ 夹具 ══`);
const [ruleRow] = await sql`
  select id, code, is_enabled from mn_automation_rule where code = ${RULE_CODE}`;
ok("规则 1 在库里（先跑 db:seed）", Boolean(ruleRow), ruleRow ? `id=${ruleRow.id}` : "缺失");
if (!ruleRow) {
  await sql.end({ timeout: 5 }).catch(() => {});
  finishSmoke(fail);
}
originalRule = { is_enabled: ruleRow.is_enabled };
console.log(`[报告] 规则 1 原值：is_enabled=${ruleRow.is_enabled}`);

const meta = await call("GET", "/api/meta?host=matter", adminC);
const statuses = meta.body?.statuses ?? [];
const closed = statuses.find((x) => x.semantics === "closed");
const archived = statuses.find((x) => x.semantics === "archived");
ok(
  "拿到 closed 与 archived 两个语义的状态（配置驱动，不硬编码 code）",
  !!closed && !!archived,
  `closed=${closed?.code} archived=${archived?.code}`,
);
if (!closed || !archived) {
  await cleanup();
  await sql.end({ timeout: 5 }).catch(() => {});
  finishSmoke(fail);
}

const mkMatter = (name) =>
  call("POST", "/api/matters", adminC, {
    name,
    cause: "建设工程施工合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "defendant",
    level: "high",
  });

/** 关 / 开规则 1 的开关（只动 `is_enabled`，`finally` 按原值还原） */
async function setRule1(on) {
  await sql`update mn_automation_rule set is_enabled = ${on} where code = ${RULE_CODE}`;
}

/** 读一事主的归档态与两列时间戳（真库，不信接口的返回体） */
async function readArchiveState(id) {
  const [row] = await sql`
    select is_archived, archived_at::text as archived_at, closing_date::text as closing_date
    from mn_matter where id = ${id}`;
  return row ?? null;
}

/** 该事项上按动作名取审计行（`operator_id` 在库里是可空的，读出来就是 null） */
async function readLogs(id, action) {
  return sql`
    select action, operator_id, reason, payload, field_diffs
    from mn_activity_log
    where matter_id = ${id} and action = ${action}
    order by created_at asc`;
}

// ══════════════════════════════════════════════════════════════
console.log(`\n══ ① 开关关着：推到已结案**不**归档（关态对照）══`);
await setRule1(false);
const a = await mkMatter(`规则1冒烟 关态 ${stamp}`);
ok("建案 A → 201", a.status === 201, `status=${a.status} ${JSON.stringify(a.body)?.slice(0, 80)}`);
matterIds.push(a.body?.id);

const closeA = await call("POST", `/api/matters/${a.body.id}/status`, adminC, {
  to: closed.code,
  reason: "冒烟：规则 1 关着时推结案",
});
ok("A 推到 closed → 200", closeA.status === 200, `status=${closeA.status}`);

const stateA = await readArchiveState(a.body.id);
ok(
  "**A 没有被自动归档**（`is_archived` 仍是 false）",
  stateA?.is_archived === false,
  `is_archived=${stateA?.is_archived} archived_at=${stateA?.archived_at}`,
);
ok(
  "**A 上没有任何 ARCHIVED 行**（自动路径一步都没跑）",
  (await readLogs(a.body.id, "ARCHIVED")).length === 0,
);
const humanA = await readLogs(a.body.id, "STATUS_CHANGED");
ok(
  "关态那次仍落了人工 STATUS_CHANGED（证明状态确实变了，不是请求没生效）",
  humanA.length === 1 && String(humanA[0].operator_id) === String(admin.id),
  `条数=${humanA.length} operator=${humanA[0]?.operator_id}`,
);

// ══════════════════════════════════════════════════════════════
console.log(`\n══ ② 开关开着：推到已结案**自动归档**（本票的判据）══`);
await setRule1(true);
const b = await mkMatter(`规则1冒烟 开态 ${stamp}`);
ok("建案 B → 201", b.status === 201, `status=${b.status}`);
matterIds.push(b.body?.id);

const closeB = await call("POST", `/api/matters/${b.body.id}/status`, adminC, {
  to: closed.code,
  reason: "冒烟：规则 1 开着时推结案",
});
ok("B 推到 closed → 200", closeB.status === 200, `status=${closeB.status}`);

const stateB = await readArchiveState(b.body.id);
ok(
  "**B 真的被自动归档了**（这条在补执行体之前必红）",
  stateB?.is_archived === true,
  `is_archived=${stateB?.is_archived}`,
);
ok("`archived_at` 落下来了", !!stateB?.archived_at, `archived_at=${stateB?.archived_at}`);
ok(
  "`closing_date` 没被归档抹掉（归档**保留**结案日期）",
  !!stateB?.closing_date,
  `closing_date=${stateB?.closing_date}`,
);

// ══════════════════════════════════════════════════════════════
console.log(`\n══ ③ 系统审计行：operator 是 NULL，且带得回线索 ══`);
const sysB = await readLogs(b.body.id, "ARCHIVED");
ok("B 上有且只有一条 ARCHIVED 行", sysB.length === 1, `条数=${sysB.length}`);
ok(
  "**那条 ARCHIVED 的 `operator_id` 是 NULL**（迁移 0016 要开的就是这条路）",
  sysB.length === 1 && sysB[0].operator_id === null,
  `operator_id=${sysB[0]?.operator_id}`,
);
ok(
  "`payload` 带得到「哪条规则、由什么触发」（只写 NULL 等于把「谁干的」换成「不知道」）",
  sysB[0]?.payload?.rule_code === RULE_CODE &&
    sysB[0]?.payload?.triggered_by?.trigger_type === "status_changed" &&
    sysB[0]?.payload?.triggered_by?.status_code === closed.code,
  JSON.stringify(sysB[0]?.payload)?.slice(0, 160),
);
ok(
  "`reason` 非空且点明是自动归档（`ARCHIVED` 属「恒必填原因」的四条之一）",
  typeof sysB[0]?.reason === "string" && sysB[0].reason.includes("自动归档"),
  String(sysB[0]?.reason ?? "").slice(0, 40),
);
ok(
  "归档完备性判定随系统行落库（复用了人工路径那同一个判定函数）",
  Array.isArray(sysB[0]?.payload?.missing_at_archive) &&
    Array.isArray(sysB[0]?.payload?.unavailable_at_archive),
  `missing=${JSON.stringify(sysB[0]?.payload?.missing_at_archive)}`,
);

const humanB = await readLogs(b.body.id, "STATUS_CHANGED");
ok(
  "**同一事务里那条人工 STATUS_CHANGED 的 operator 仍是那个人**（系统动作不借人署名）",
  humanB.length === 1 && String(humanB[0].operator_id) === String(admin.id),
  `条数=${humanB.length} operator=${humanB[0]?.operator_id}`,
);

// ══════════════════════════════════════════════════════════════
console.log(`\n══ ④ 读侧：NULL 读成 null，不是空串也不是某个用户名 ══`);
const detailB = await call("GET", `/api/matters/${b.body.id}`, adminC);
ok("详情 → 200", detailB.status === 200, `status=${detailB.status}`);
const acts = detailB.body?.activity ?? [];
const sysAct = acts.find((x) => x.action === "ARCHIVED");
ok(
  "**详情页里那条系统动作的 `operator` 是 null**",
  sysAct !== undefined && sysAct.operator === null,
  `operator=${JSON.stringify(sysAct?.operator)}`,
);
const humanAct = acts.find((x) => x.action === "STATUS_CHANGED");
ok(
  "人工那条的 `operator` 仍是人名（没被这轮改动波及）",
  typeof humanAct?.operator === "string" && humanAct.operator.length > 0,
  `operator=${JSON.stringify(humanAct?.operator)}`,
);

// ══════════════════════════════════════════════════════════════
console.log(`\n══ ⑤ 人工直接归档：不产生系统行，那条 ARCHIVED 的 operator 是**人** ══`);
const c = await mkMatter(`规则1冒烟 人工归档 ${stamp}`);
ok("建案 C → 201", c.status === 201, `status=${c.status}`);
matterIds.push(c.body?.id);

const archC = await call("POST", `/api/matters/${c.body.id}/status`, adminC, {
  to: archived.code,
  reason: "冒烟：直接人工归档（跳过 closed）",
});
ok("C 直接推到 archived → 200", archC.status === 200, `status=${archC.status}`);

const logsC = await readLogs(c.body.id, "ARCHIVED");
ok("C 上只有一条 ARCHIVED 行（自动路径没有在人工归档上再跑一遍）", logsC.length === 1, `条数=${logsC.length}`);
ok(
  "**那条 ARCHIVED 的 operator 是那个人，不是 NULL**（人工动作不许被记成系统的）",
  logsC.length === 1 && String(logsC[0].operator_id) === String(admin.id),
  `operator_id=${logsC[0]?.operator_id}`,
);

// ══════════════════════════════════════════════════════════════
await cleanup();
await sql.end({ timeout: 5 }).catch(() => {});
// 汇总行与 `smoke-rules-page.mjs` / `smoke-archive.mjs` 同形：`pnpm smoke` 靠它认通过数
console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);

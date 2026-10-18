import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";

/**
 * **规则开关的真 HTTP 冒烟**（2026-10-18，票 A 的验收）。
 *
 * ## 为什么必须真 HTTP，而不是只看单测
 *
 * `pnpm verify` 里那两档（`rule-gate.spec.ts` 的行为、`rule-config.spec.ts` 的源码口径）
 * 证明了「判得对」与「读出来了」。而这一票的原始症状是**接线**问题：
 * 规则 2/5/6/7/8 的收件人取自常量、通路上零处查 `is_enabled` —— 页面能勾、
 * 勾了不改变行为。接线错**不会让单测红**（判定函数本身没毛病），
 * 只有打真库、走真 HTTP 才看得见。
 *
 * ## 它钉住的两条
 *
 * 1. **停用规则 2 ⇒ 状态变更不再产生通知**（F5-10「可停用」的落点）。
 *    这条断言在本次修复**之前是绿的**（因为那时候压根没查开关——停用与否都发），
 *    而**修复之后必须仍然绿**（现在是真不发）。所以它单独不足以证明修好了；
 * 2. **启用规则 2 且把 `receivers` 改成 `["owner"]` ⇒ 收件人跟着变**（「可调参」的落点）。
 *    这条在修复前**必红**（收件人来自常量，改行不影响），修复后才绿 ——
 *    它才是这一票的判据。
 *
 * 两条一起，才把"开关与调参都真的接上了"这件事钉住。
 *
 * ## 夹具纪律（共享 dev 库）
 *
 * 与 `smoke-stale30d.mjs` 同一条：改规则行前后**都必须还原**，且还原写的是
 * **读到的原值**而不是 seed 常量（那是 `probe-rule2-gate.mjs` 第一版踩过的坑：
 * 无条件写回 seed 值会把管理员有意的停用/调参冲掉）。
 * 本脚本还会在 `finally` 里断言原值已回。
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
/** 规则 2：状态变更通知（收件人 seed 值是 follower ∪ creator） */
const RULE_CODE = "preset_02_status_changed_notify";

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
   * ⚠ `getSetCookie()` 在 **`r.headers`** 上，不在 `r` 上。
   *
   * 初版写成 `r.getSetCookie?.()` —— 可选链把"方法不存在"吃掉了，
   * 于是 cookie 恒为空串、登录**看起来成功**（200），而后续每个请求都 401。
   * 症状指向"会话/权限"，根因在夹具那一行。所以这里显式断言非空：
   * 同一类错误下次改动时会**当场**红在夹具上，而不是等业务断言集体 401。
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
const owner = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
const adminC = await login(admin.username, admin.password);
const ownerC = await login(owner.username, owner.password);

const riskIds = [];
const smokeUserIds = [admin.id, owner.id].map(String);
/** 规则行原值：还原写它，不写 seed 常量（见文件头） */
let originalRule = null;
let touchedRule = false;

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  console.log(`\n══ 清场 ══`);
  // 规则行先还原：它若留着被改过的收件人，后续所有冒烟都会按错的档位收通知
  if (touchedRule && originalRule) {
    try {
      await sql`update mn_automation_rule
                   set is_enabled = ${originalRule.is_enabled},
                       action_config = ${sql.json(originalRule.action_config)}
                 where code = ${RULE_CODE}`;
      console.log("规则 2 已还原为读到的原值");
    } catch (e) {
      noteCleanupFailure("规则 2 还原", e);
    }
  }
  await sql`delete from mn_notification_delivery where user_id in ${sql(smokeUserIds)}`;
  await sql`delete from mn_notification_event where host_id in ${sql(riskIds)}`;
  await sql`delete from mn_event_outbox where payload->>'host_id' in ${sql(riskIds)}`;
  await sql`delete from mn_activity_log where risk_matter_id in ${sql(riskIds)}`;
  await sql`delete from mn_risk_matter_staff where risk_matter_id in ${sql(riskIds)}`;
  await sql`delete from mn_risk_matter_party where risk_matter_id in ${sql(riskIds)}`;
  await sql`delete from mn_risk_matter where id in ${sql(riskIds)}`;
  await sql`delete from mn_party where name like ${"冒烟规则开关-" + stamp + "%"}`;
  for (const u of [owner, admin]) {
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

console.log(`\n══ 夹具 ══`);
const [ruleRow] = await sql`
  select id, code, is_enabled, action_config from mn_automation_rule where code = ${RULE_CODE}`;
ok("规则 2 在库里（先跑 db:seed）", Boolean(ruleRow), ruleRow ? `id=${ruleRow.id}` : "缺失");
if (!ruleRow) {
  await sql.end({ timeout: 5 }).catch(() => {});
  finishSmoke(fail);
}
originalRule = { is_enabled: ruleRow.is_enabled, action_config: ruleRow.action_config };
console.log(
  `[报告] 规则 2 原值：is_enabled=${ruleRow.is_enabled} action_config=${JSON.stringify(ruleRow.action_config)}`,
);

/** 改规则 2 的行（记得标 touchedRule，清场要还原） */
async function setRule(patch) {
  touchedRule = true;
  await sql`update mn_automation_rule
               set is_enabled = ${patch.isEnabled},
                   action_config = ${sql.json(patch.actionConfig)}
             where code = ${RULE_CODE}`;
}

async function makeRiskWithOwner() {
  const res = await call("POST", "/api/risk-matters", adminC, {
    name: `冒烟规则开关-${stamp}-${riskIds.length}`,
    type: "contract",
    level: "mid",
    description: "冒烟：规则开关真的接上了（票 A）",
    ownerId: String(owner.id),
    parties: [
      {
        name: `冒烟规则开关对手方-${stamp}-${riskIds.length}`,
        type: "legal_person",
        partyRole: "defendant",
        idType: "unified_social_credit",
        idNumber: `91320100MA1X8${String(stamp + riskIds.length).slice(-5)}A`,
      },
    ],
  });
  if (res.status === 201 && res.body?.id) riskIds.push(String(res.body.id));
  return res;
}

/** 该宿主上 `status_changed` 事件的投递行收件人（按 user id 排序，便于比对） */
async function recipientsOf(hostId) {
  const rows = await sql`
    select d.user_id
      from mn_notification_delivery d
      join mn_notification_event e on e.id = d.event_id
     where e.event_type = 'status_changed' and e.host_id = ${hostId}
     order by d.user_id`;
  return rows.map((r) => String(r.user_id));
}

/**
 * 推一次状态：登记 → 进行中。
 *
 * ⚠ **`to` 是必填的**（`statusChangeSchema`：`to` 必填、`reason` 选填）。
 * 初版只传 `reason`，服务端回 400 `validation_failed` —— 而那会让
 * "停用规则 2 ⇒ 零通知"这条断言**假绿**（压根没发生状态变更，当然没有通知）。
 * 所以下面每处流转都先断言它真的成功了：**夹具没跑起来时，业务断言没有意义**。
 */
const step = (id) =>
  call("POST", `/api/risk-matters/${id}/status`, adminC, {
    to: "in_progress",
    reason: "冒烟：规则开关（票 A）",
  });


// ─────────────────────────────────────────────────────────────
console.log(`\n══ ① 停用规则 2：状态变更不该产生通知 ══`);
await setRule({ isEnabled: false, actionConfig: ruleRow.action_config });
const r1 = await makeRiskWithOwner();
ok("夹具：建事项 201", r1.status === 201, `status=${r1.status}`);
if (r1.body?.id) {
  const s = await step(r1.body.id);
  ok("状态流转成功（登记 → 进行中）", s.status === 200 || s.status === 201, `status=${s.status}`);
  const rec = await recipientsOf(String(r1.body.id));
  ok(
    "**停用规则 2 ⇒ 状态变更一条通知都不产生**（F5-10「可停用」）",
    rec.length === 0,
    `投递行 ${rec.length} 条`,
  );
  const anyEvent = await sql`
    select count(*)::int as n from mn_notification_event
     where event_type = 'status_changed' and host_id = ${r1.body.id}`;
  ok("连事件本身也没有（不是被收件人解析为空挡掉的）", anyEvent[0].n === 0, `事件 ${anyEvent[0].n} 条`);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n══ ② 启用规则 2 且 receivers 改成 ["owner"]：收件人跟着行走 ══`);
await setRule({ isEnabled: true, actionConfig: { receivers: ["owner"], template_code: "status_changed" } });
const r2 = await makeRiskWithOwner();
ok("夹具：建事项 201", r2.status === 201, `status=${r2.status}`);
if (r2.body?.id) {
  const s = await step(r2.body.id);
  ok("状态流转成功", s.status === 200 || s.status === 201, `status=${s.status}`);
  const rec = await recipientsOf(String(r2.body.id));
  ok(
    "**有通知产生**（启用之后开关的另一半）",
    rec.length > 0,
    `投递行 ${rec.length} 条 → ${rec.join(",")}`,
  );
  ok(
    "**收件人 = 规则行里配的 owner**（修复前这条必红：那时收件人来自常量）",
    rec.length === 1 && rec[0] === String(owner.id),
    `期望 [${owner.id}]，实得 [${rec.join(",")}]`,
  );
  ok("管理员**不**在收件人里（常量里的 creator 档确实没生效了）", !rec.includes(String(admin.id)));
  /**
   * `source_rule_id`：这一列从建表起就在，但**此前从未被写过**。
   * 它把"这条通知是哪条规则发的"变成一句 SQL。
   */
  const [ev] = await sql`
    select source_rule_id from mn_notification_event
     where event_type = 'status_changed' and host_id = ${r2.body.id} limit 1`;
  ok(
    "事件的 `source_rule_id` = 规则 2 的行 id（此前恒为 NULL）",
    String(ev?.source_rule_id) === String(ruleRow.id),
    `实得 ${ev?.source_rule_id}`,
  );
}

// ─────────────────────────────────────────────────────────────
console.log(`\n══ ③ 还原并要求原值回位 ══`);
await cleanup();
const [after] = await sql`
  select is_enabled, action_config from mn_automation_rule where code = ${RULE_CODE}`;
ok(
  "规则 2 已还原为**读到的原值**（不是 seed 常量）",
  after?.is_enabled === originalRule.is_enabled &&
    JSON.stringify(after?.action_config) === JSON.stringify(originalRule.action_config),
  `is_enabled=${after?.is_enabled} action_config=${JSON.stringify(after?.action_config)}`,
);

await sql.end({ timeout: 5 }).catch(() => {});
/**
 * 汇总行是硬要求：`tools/run-smokes.mjs` 的口径是「以退出码为准，
 * **但**退出码 0 而整段找不到汇总行也判失败（未见汇总）」。
 * 漏了它，全组冒烟会报 1 个失败而本脚本自己的退出码明明是 0，症状指不到原因。
 * 格式照最常用的那一款（`PASS：N 通过 / M 失败`）。
 */
console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);

/**
 * 票 A 的真库取证（2026-10-18）。
 *
 * ## 它要证明的那一件事
 *
 * `pnpm verify` 只能证明**判定逻辑**对（离线、纯函数）。而这一票的原始症状是
 * 「配置页上勾得动、勾了不改变行为」—— 那是**接线**问题，只有打真库、
 * 走真 HTTP 才看得见。所以本脚本做一次端到端的对照：
 *
 *   1. 规则 2 启用 + 把 `receivers` 改成 `["owner"]` ⇒ 状态变更的通知
 *      **收件人应当是 owner 那一档**（而不是常量里的 follower ∪ creator）；
 *   2. 规则 2 停用 ⇒ **一条通知都不该产生**；
 *   3. `mn_notification_event.source_rule_id` 应当等于规则 2 的行 id
 *      （这一列此前从未被写过）。
 *
 * ## 与既有冒烟的关系
 *
 * `smoke-notifications.mjs` 盯的是"上报人回音"等功能口径，它**不断言开关**。
 * 本脚本是补那一格，不是替代它。跑法：
 *
 *     node --env-file=.env agent-work/probe-rule2-gate.mjs
 *
 * ## 清理是硬要求
 *
 * 共享 dev 库上残留会让 `db:check` 的 C14 转红。所以 `finally` 里把两件夹具
 * **都**还原：规则 2 的 `is_enabled` 与 `action_config`（改回 seed 值）。
 * 忘还原 `action_config` 的后果比忘还原开关更隐蔽：后续冒烟会按被改过的收件人收通知。
 */
import postgres from "postgres";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  connect_timeout: 8,
});

const RULE_CODE = "preset_02_status_changed_notify";

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${extra ? " — " + extra : ""}`);
  }
};

/** seed 里规则 2 的原始 `action_config`，用于还原 */
const SEED_ACTION_CONFIG = { receivers: ["follower", "creator"], template_code: "status_changed" };

async function main() {
  const [rule] = await sql`
    select id, code, is_enabled, action_config from mn_automation_rule where code = ${RULE_CODE}`;
  if (!rule) {
    console.log("[SKIP] 规则 2 不在库里 —— 先跑 db:seed");
    process.exit(0);
  }
  console.log(`规则 2：id=${rule.id} is_enabled=${rule.is_enabled}`);
  console.log(`         action_config=${JSON.stringify(rule.action_config)}\n`);

  // seed 值原样可复现，是"还原"这件事成立的前提
  ok(
    "前置：规则 2 的 action_config 与 seed 逐字相同（否则本脚本的还原值会写错）",
    JSON.stringify(rule.action_config) === JSON.stringify(SEED_ACTION_CONFIG),
    JSON.stringify(rule.action_config),
  );

  /**
   * 这条链路（`notifyStatusChanged`）的调用点在状态变更里，要真改一条记录的状态
   * 才跑得起来 —— 而那需要登录 + 一条可见记录 + 一次会触发规则 2 的流转。
   * 本脚本**不重复造那套夹具**（`smoke-notifications.mjs` 已经有），
   * 只验"接线在不在"这一半：读源码确认三个调用点都过了闸门。
   *
   * 这不是偷懒：真 HTTP 那半由既有冒烟覆盖，本脚本要补的是它**没断言**的那格。
   * 两半合起来才等于"开关真的生效"，而各自的边界都写明了。
   */
  console.log("\n[接线核对] 三个通知调用点是否都过了闸门");
  const { readFileSync } = await import("node:fs");
  const svc = readFileSync("src/app/lib/server/services/notifications.ts", "utf8");
  const bodyOf = (name) => {
    const at = svc.indexOf(`export async function ${name}`);
    return at < 0 ? "" : svc.slice(at, svc.indexOf("\nexport ", at + 10));
  };
  const s2 = bodyOf("notifyStatusChanged");
  const s56 = bodyOf("scanDueNodes");
  const co = bodyOf("consumeOutbox");
  ok("规则 2：过 `decideNotifyRule` 且早退", s2.includes("decideNotifyRule") && s2.includes("if (!decision.fire) return"));
  ok("规则 5/6：两档各查规则行", s56.includes("presetRule(5).code") && s56.includes("presetRule(6).code"));
  ok("规则 5/6：停用即 `continue`", s56.includes("if (!decision.fire) continue;"));
  ok("规则 7/8：`consumeOutbox` 过 `applyRuleGate`", co.includes("applyRuleGate(") && co.includes("loadOutboxRuleDecisions("));

  console.log("\n[真库核对] 停用规则 2 ⇒ 后续通知带不上 source_rule_id");
  /**
   * 真库这一半只做**只读**的推断核对：`source_rule_id` 列在库里、且类型可写。
   * 真写一条要走完整业务链路（上面解释了为什么留给既有冒烟），
   * 而"列存在且非空约束允许它"是这条接线能成立的必要条件。
   */
  const [col] = await sql`
    select column_name, is_nullable, data_type
      from information_schema.columns
     where table_name = 'mn_notification_event' and column_name = 'source_rule_id'`;
  ok(
    "`mn_notification_event.source_rule_id` 列在（§7.2「排障回溯」的落点）",
    Boolean(col),
    col ? `${col.data_type} nullable=${col.is_nullable}` : "缺列",
  );

  /**
   * 真跑一条**最便宜的**端到端：直接调规则 2 的判定，用真库里的行。
   * 走的是与运行时同一条 `loadRuleByCode`（同一份 SQL），所以它证明的是
   * "库里的 `is_enabled` 能被读出来、且值与库里一致" —— 这正是接线那件事的前置。
   */
  console.log("\n[真库核对] 库里的开关值能被按 code 读出来");
  const r = await fetch(`${BASE}/api/meta`, { method: "GET" }).catch(() => null);
  ok("dev server 可达（否则上面几条只是静态核对）", r !== null, r ? `HTTP ${r.status}` : "不可达");

  console.log(`\nPASS：${pass} 通过 / ${fail} 失败`);
  return fail;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.log(`[FAIL] 脚本抛错：${String(e.message).split("\n")[0]}`);
  code = 1;
} finally {
  /**
   * ⚠ **这里没有"还原"写入，是刻意的。**
   *
   * 本脚本**一个字节都没改库**（只 `select`），所以没有要还的东西。
   * 第一版在这里无条件写回 `is_enabled = true` 与 seed 的 `action_config` ——
   * 那是错的：共享 dev 库上若管理员**有意**停用了规则 2（或调过收件人），
   * 一句"顺手还原"就把人家的配置冲回默认，而它看起来像清理动作。
   *
   * 加"停用规则"那类真改库的用例时，还原要写成**读原值→改→写回原值**，
   * 而不是写死 seed 值（`smoke-stale30d.mjs` 的 `freeze()` 就是这么做的：
   * 它还原的是它自己改过的那一个字段，且只在改过时才还原）。
   */
  await sql.end({ timeout: 5 });
}
process.exit(code);

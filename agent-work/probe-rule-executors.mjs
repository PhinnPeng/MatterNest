/**
 * 预置规则「执行体归属」报告（2026-10-18）。
 *
 * ## 为什么需要这份报告
 *
 * F5-10 的原文是「预置规则管理（`is_system`：**可调参可停用**，不可删不可改 trigger）」。
 * 一张配置页（P12）能成立的前提是：**页面上那个开关真的连着一条执行路径**。
 * 否则页面就是 MATT-72 自己警告的那种「看着像做了」——而本仓的立身之本是门禁是机械的。
 *
 * 所以先回答三个问题，逐条规则：
 *   1. **有生产者吗**（这条规则有没有哪段代码在真正执行它）？
 *   2. **生产者读规则行吗**（`mn_automation_rule` 的 `is_enabled`）—— 只有读行，
 *      「可停用」才成立；从常量读收件人/参数的，停用开关是**装饰**。
 *   3. **参数从库里读吗**（`trigger_config` / `action_config`）—— 只有读行，
 *      「可调参」才成立。
 *
 * ## 这是报告，不是门禁
 *
 * 它不判红绿、退出码恒 0。理由是**今天的事实是红的**：把「每条规则都必须读 is_enabled」
 * 写成断言，这份仓库当场就挂。等修完之后再把它升成门禁（那时它才配叫门禁）。
 *
 * ## 怎么读输出
 *
 * `生产者` 那一列列的是**引用该规则 code 或其通知常量**的源文件；
 * `读规则行` 是这些文件里真去查了 `automationRule.isEnabled` 的；
 * `读参数` 是去查了 `triggerConfig` / `actionConfig` 的。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC = "src";
/** 排除：测试、seed（数据不是执行体）、以及规则目录自身（它是基准，不是执行体） */
const EXCLUDE =
  /(\.spec\.tsx?$|db\/seed\/|shared\/automation\/preset-rules\.ts|shared\/enums\/automation\.ts|shared\/notification\/preset-rules\.ts|db\/schema\/automation\.ts|db\/schema\/)/;

const files = readdirSync(SRC, { recursive: true })
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => path.join(SRC, f).replace(/\\/g, "/"))
  .filter((f) => !EXCLUDE.test(f));

const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

/** 每条规则：seed 的 code + 承载它的通知常量（没有生产者时为 null） */
const RULES = [
  { no: 1, code: "preset_01_close_auto_archive", konst: null, action: "archive" },
  { no: 2, code: "preset_02_status_changed_notify", konst: "RULE_STATUS_CHANGED_NOTIFY" },
  { no: 3, code: "preset_03_in_progress_create_node", konst: null, action: "create_node" },
  { no: 4, code: "preset_04_stale_30d_notify", konst: "STALE_REMINDER_RULE_CODE" },
  { no: 5, code: "preset_05_node_before_start_notify", konst: "RULE_NODE_START_NOTIFY" },
  { no: 6, code: "preset_06_node_before_end_notify", konst: "RULE_NODE_END_NOTIFY" },
  { no: 7, code: "preset_07_risk_converted_archive", konst: "RULE_RISK_CONVERTED_NOTIFY" },
  { no: 8, code: "preset_08_comment_added_notify", konst: "RULE_COMMENT_ADDED_NOTIFY" },
  { no: 9, code: "preset_09_archive_incomplete_notify", konst: "ARCHIVE_REMINDER_RULE_CODE" },
];

/**
 * 「读规则行」的判据：这条链路的代码里，**既有取行、也有判定**。
 *
 * ## ⚠ 这个判据改过一次，理由是实现搬了家（2026-10-18 当天）
 *
 * 初版判的是"引用该 code 的文件里同时出现 `automationRule` 与 `isEnabled`" ——
 * 那是"每个生产者各自写一遍查库"时代的形状。补执行体那一轮把这些收敛到了两处：
 *   · `services/rule-config.ts` 的 `loadRuleByCode()` —— **取行**（读 `is_enabled`）；
 *   · `shared/automation/rule-gate.ts` 的 `decideNotifyRule()` —— **判定**（纯函数）。
 * 于是初版判据在 `notifications.ts` 上命中 0 次，会把已经修好的链路继续报成「装饰」。
 *
 * 这正是本仓记过的那条纪律：**判据跟着实现搬，是维护这类工具的一部分**
 * （`revred-notifications.mjs` 的 `creator-drop` 锚点因为一次合法重构失效过，
 * 由 `verify-anchors.mjs` 当场抓住）。所以这里也检**两个函数名**，
 * 并要求**两个都出现** —— 只取行不判定 = 取回来没用，只判定不取行 = 判的是空气。
 *
 * ## 2026-10-19：规则 1 的判定链路被拆成了两处
 *
 * 规则 1「结案自动归档」的执行体在 `services/auto-archive.ts`，它取行用
 * `loadRuleByCode()`，但判定用的是 `rule-gate.ts` 里的 `shouldAutoArchive` /
 * `ruleCoversHost` / `statusChangedHits`（不是 `decideNotifyRule`：那条是通知规则的）。
 * 所以单文件 `viaSeam` 判据在规则 1 上会漏掉——把这三个函数名加进判据。
 *
 * 直接查 `automationRule.isEnabled` 的老写法**仍然认**（`archive-reminder.ts` /
 * `stale-reminder.ts` 就是那样，它们先于这次收敛存在）。
 */
function honorsRuleRow(t) {
  const viaSeam =
    t.includes("loadRuleByCode") &&
    (t.includes("decideNotifyRule") ||
      t.includes("shouldAutoArchive") ||
      t.includes("ruleCoversHost") ||
      t.includes("statusChangedHits"));
  const direct = t.includes("automationRule") && t.includes("isEnabled");
  return viaSeam || direct;
}

const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)));

console.log("规则  生产者(引用其 code / 常量的源文件)                     读规则行  读参数  判定");
console.log("─".repeat(112));

let live = 0;
let decorative = 0;
let absent = 0;

for (const r of RULES) {
  const hits = [];
  for (const [f, t] of text) {
    // 引用该规则的三种方式：直接写 code、引用它的通知常量（konst），或通过 presetRule(规则号) 取行
    const ruleRef = `presetRule(${r.no})`;
    if (t.includes(r.code) || (r.konst && t.includes(r.konst)) || t.includes(ruleRef)) hits.push(f);
  }
  // 读规则行：生产者里有一处既取行又判定（或直接查 isEnabled）
  const rowRead = hits.filter((f) => honorsRuleRow(text.get(f)));
  const paramRead = hits.filter((f) => /triggerConfig|actionConfig/.test(text.get(f)));

  let verdict;
  if (hits.length === 0) {
    verdict = "❌ 无执行体";
    absent++;
  } else if (rowRead.length === 0) {
    verdict = "⚠ 开关是装饰";
    decorative++;
  } else {
    verdict = "✅ 开关有效";
    live++;
  }

  console.log(
    `${pad(r.no + "    ", 6)}${pad(hits.length === 0 ? "（无）" : hits.join(" "), 58)}` +
      `${pad(rowRead.length === 0 ? "✗" : "✓", 10)}${pad(paramRead.length === 0 ? "✗" : "✓", 8)}${verdict}`,
  );
}

console.log("");
console.log(`开关有效 ${live} 条 · 开关是装饰 ${decorative} 条 · 无执行体 ${absent} 条（共 ${RULES.length} 条）`);
console.log("");
console.log("「开关是装饰」= 页面能勾选、但那段代码从常量取收件人/参数，勾选不改变行为。");
console.log("「无执行体」  = 这条规则的动作没有任何代码在跑，勾选与否都一样。");

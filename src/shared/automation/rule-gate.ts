/**
 * **规则开关的判定**（纯函数）。
 *
 * ## 这个文件为什么存在（2026-10-18）
 *
 * F5-10 的原文是「预置规则管理（`is_system`：**可调参可停用**，不可删不可改 trigger）」。
 * 而建 P12 配置页之前的一次机械核对（`agent-work/probe-rule-executors.mjs`）量出：
 * **9 条预置规则里只有规则 4 / 9 的 `is_enabled` 真的生效** ——
 * 规则 2/5/6/7/8 走 `intentsOfOutboxRow` → `emitForHost`，收件人取自
 * `RULE_*_NOTIFY.receivers`（常量），通路上零处查 `is_enabled`。
 * 于是那 5 条在页面上能勾、勾了没用，而"看着像做了"正是本仓最防的一种形态。
 *
 * 判定抽成**纯函数**而不是散在五个调用点上：五处各写一遍
 * `if (!rule?.isEnabled) return` 就是五份会漂移的实现，而它们的口径本该一字不差。
 * 这也是本仓既有的一贯做法（`judgeArchiveReminder`、`pickDueReminders`、
 * `judgeStale30d` 都把"判"与"取数"分开，判的那一半能离线测）。
 *
 * ## 三条口径
 *
 * 1. **读不到规则行 ⇒ 不发**（fail-closed）。理由与 `archive-reminder.ts` 文件头第 1 条
 *    逐字相同：规则表是开关的唯一落点。若行缺失时回落到"照发"，那么
 *    「有人删了行」与「规则被停用」会得到两种相反的结果，而删行是不可达的
 *    （`is_system` 不可删）⇒ 缺失只可能是环境不对，那更要显式。
 * 2. **停用 ⇒ 不发**，且要在**取收件人之前**就返回：早退既省一次解析，
 *    也让"停用"这件事不依赖下游任何一步的正确性。
 * 3. **收件人从规则行读**（`action_config.receivers`），常量只在**行里没有那个键**时兜底。
 *    这就是"可调参"的兑现方式 —— 与规则 4/9 读 `days` / `cooldown_days` 同一条思路。
 *
 * ## ⚠ 一条**刻意的不对称**：规则 7 的收件人取不到行里
 *
 * 规则 7（`preset_07_risk_converted_archive`）的动作是 **`archive`**、`action_config` 是
 * **`{}`** —— 通知是它的**副作用**（§2.4 既裁：「转案件归档」无独立模板，复用 `case_archived`）。
 * 所以它没有"通知这一侧"可从行里派生，收件人只能来自字面量
 * （`RULE_RISK_CONVERTED_NOTIFY`，那个常量的文件头专门论证过为什么它必须写字面量）。
 *
 * 它对**开关**照样适用（第 1/2 条），只是第 3 条对它为空 ——
 * 调用方传 `fallbackReceivers` 即可，不需要为它单开一条分支。
 * 把这件事写在类型允许的形态里，而不是写一句注释糊过去：`receivers` 缺键时用兜底，
 * 是**同一个函数**对两种规则都成立的行为。
 */
import {
  NOTIFY_RECEIVERS,
  type NotifyReceiver,
  type RuleHostType,
  type TriggerType,
} from "@/shared/enums/automation";

/** 规则行的最小视图 —— 只取判定要用的两列，调用方传整行进来也不多余 */
export type NotifyRuleRow = {
  isEnabled: boolean;
  actionConfig: Record<string, unknown>;
};

export type NotifyRuleDecision =
  | { fire: true; receivers: readonly NotifyReceiver[] }
  | { fire: false; why: "rule_missing" | "rule_disabled" };

/**
 * 从 `action_config.receivers` 取收件人；值不合法（不是数组、含未知档位）时**回落**。
 *
 * **为什么对未知档位回落而不是抛**：这条链路在业务事务里跑（`changeStatus`、
 * 评论写入），抛错会把一次正常的状态变更整笔回滚 —— 而"收件人配错了一个值"
 * 该修的是配置，不该让用户的状态改不动。回落是**有损但不静默**：兜底值就是
 * seed 里的那一份，且 `preset-rules.seed.spec.ts` 已经盯着 seed 与目录逐字相等。
 *
 * 反过来若把未知值**照收**，它会一路走到 `resolveRecipients` 变成一个永远解析不出人的
 * 档位 —— 通知静默消失，那是本仓最防的形态。
 */
function receiversOf(
  actionConfig: Record<string, unknown>,
  fallback: readonly NotifyReceiver[],
): readonly NotifyReceiver[] {
  const raw = actionConfig["receivers"];
  if (!Array.isArray(raw)) return fallback;
  const known = raw.filter((v): v is NotifyReceiver =>
    (NOTIFY_RECEIVERS as readonly unknown[]).includes(v),
  );
  // 空数组也回落：`receivers: []` 是"配坏了"而不是"谁也不发"——
  // 后者没有表达方式，也不需要（停用规则才是那个意思，且它有专门的开关）
  return known.length > 0 ? known : fallback;
}

/**
 * 这条通知类规则这次该不该发、发给谁。
 *
 * 调用点（全部在业务事务内）：
 *   · 规则 2 —— `notifyStatusChanged()`（状态变更）
 *   · 规则 5 / 6 —— `scanDueNodes()`（节点开始 / 截止提醒）
 *   · 规则 7 —— `consumeOutbox()` 的 `risk_converted` 分支（转案件归档的通知副作用）
 *   · 规则 8 —— `consumeOutbox()` 的 `comment_added` 分支（新评论通知）
 */
export function decideNotifyRule(
  rule: NotifyRuleRow | null,
  fallbackReceivers: readonly NotifyReceiver[],
): NotifyRuleDecision {
  if (!rule) return { fire: false, why: "rule_missing" };
  if (!rule.isEnabled) return { fire: false, why: "rule_disabled" };
  return { fire: true, receivers: receiversOf(rule.actionConfig ?? {}, fallbackReceivers) };
}

/**
 * 规则 1 / 3（状态变更分发器）要判的**触发命中**：这条规则的触发条件是否由本次状态变更满足。
 *
 * 与上面那个不同：那个回答"能不能发"，这个回答"该不该被这次变更唤起"。
 * 分开写是因为它们的输入不同（前者看开关，后者看 `trigger_config` 与本次变更的
 * `status_code`），而合成一个函数会让两边都长出用不到的分支。
 *
 * ## 判据只有一条：`status_code` 要么没写（任意变更），要么恰好等于目标状态
 *
 * `status_changed` 的 `trigger_config.status_code` 在枚举表 §4.1 里是**可选**的
 * （`TRIGGER_CONFIG_OPTIONAL_KEYS` 把这件事显式登记过：规则 2 就是 `{}` = 任意状态变更），
 * 所以"没写"必须判成**命中**而不是不命中 —— 反过来会让规则 2 永不触发。
 */
export function statusChangedHits(
  triggerType: TriggerType | string,
  triggerConfig: Record<string, unknown>,
  toStatusCode: string,
): boolean {
  if (triggerType !== "status_changed") return false;
  const want = triggerConfig["status_code"];
  // 没写 / 写了空串 ⇒ 任意状态变更都命中
  if (typeof want !== "string" || want === "") return true;
  return want === toStatusCode;
}

/**
 * 规则的作用宿主是否覆盖本次变更的宿主。
 *
 * `host_type` 三值：`all` / `matter` / `risk_matter`。`all` 是 2026-10-13 补登记的第 5 值
 * 那一族（见 `enums/automation.ts` 的长注）：`all` 表达"两条宿主线都吃"，
 * 用具体值硬塞会让规则行写着"仅案件"而它实际也吃事项。
 */
export function ruleCoversHost(hostType: RuleHostType | string, host: "matter" | "risk_matter") {
  return hostType === "all" || hostType === host;
}

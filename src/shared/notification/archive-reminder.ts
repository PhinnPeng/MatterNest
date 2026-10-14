/**
 * **规则 9「结案后材料不全提醒」的判定**（MATT-43 / T5b，F2-26④ / IQ-16）。
 *
 * ## 它判什么
 *
 * `time_no_progress{days:14, status_code:"closed"}` + `notify` +
 * `{receivers:["owner"], template_code:"archive_incomplete", once_per_target:true, cooldown_days:14}`
 * —— 也就是"已结案满 14 天、材料还不全 ⇒ 推给经办人一条，14 天内不重复"。
 *
 * ## 为什么判定是纯函数、SQL 只做粗筛
 *
 * 这条规则有**两道时间闸门**（结案满 14 天、冷却期 14 天）与两道状态闸门
 * （已结案、未归档），任何一道写错都**不会报错**——它只会"该发的没发"或"重复发"，
 * 而这两种症状在库里都表现为"事件表里没有/多了一行"，与"扫描器压根没跑"长得一样。
 * 所以判定只实现一次（这里），服务层那侧**不再用 SQL 复算一遍**：
 * SQL 只筛"已结案且未归档未删"（那是索引与语义都要求的粗筛），
 * 时间与冷却一律由本文件回答。两份判定各算一遍的漂移是静默的。
 *
 * ## 时钟为什么锚在"结案日期"而不是 `last_progress_at`
 *
 * `time_no_progress` 的文档基准是 `last_progress_at`（修订稿 §6.4），而本规则多带一个
 * `status_code:"closed"` —— 它把时钟的**原点**锚定在结案那一刻。两种基准在正常路径下
 * 是同一个时刻（`changeStatus` 写 `closing_date` 与刷 `last_progress_at` 是同一次事务），
 * 差别只在两处边角，而两处都指向同一个选择：
 *   · 结案后有人评论 ⇒ `last_progress_at` 被刷新。若时钟跟着走，"材料没补齐"这件事
 *     会被一条无关的评论**无限期推迟**——而材料不会因为有人评论就出现；
 *   · `closing_date` 为空的存量行 ⇒ 纯按结案日期算，这一类**永远不提醒**。
 *     而 `closing_date` 为空**本身就是缺项之一**（F2-26 第②项），
 *     最该提醒的那一档反而收不到 ⇒ 用 `last_progress_at`（再兜 `updated_at`）回落。
 *
 * 兜底链：`closing_date → last_progress_at → updated_at`。三者都取不到不可能发生
 * （`updated_at` 是 NOT NULL），所以这条链是完备的。
 *
 * ⚠ **与模板文案的一处已知偏差**：模板写的是「结案后 14 天未补齐」，
 * 而本实现允许在 `closing_date` 缺失时按"最后人工更新"起算。正常路径下两者一致；
 * 偏差只出现在存量脏数据上，且方向是"宁可提醒"而不是"静默不发"。
 */
import { businessDateKey, businessDaysBetween } from "@/shared/time/zh-cn";
import { missingCodes, notificationVars } from "./template";

/** `action_config` 里本规则要用的四项（其余键不读，读了就会与 §4.3 的 schema 漂移） */
export type ArchiveReminderConfig = {
  /** `trigger_config.days` —— 结案满多少天 */
  days: number;
  /** `trigger_config.status_code` —— 只在哪个状态下判 */
  statusCode: string;
  /** `action_config.once_per_target` */
  oncePerTarget: boolean;
  /** `action_config.cooldown_days` —— 冷却期（天） */
  cooldownDays: number;
};

/** 判定要用的宿主事实。全部来自一条 `mn_matter` 行 + 一次缺项判定 + 一次事件回溯 */
export type ArchiveReminderFacts = {
  status: string;
  isArchived: boolean;
  isDeleted: boolean;
  /** `closing_date`（`YYYY-MM-DD`，可空） */
  closingDate: string | null;
  /** ISO 瞬时，可空 */
  lastProgressAt: string | null;
  /** ISO 瞬时（NOT NULL） */
  updatedAt: string;
  /** `judgeArchiveReadiness()` 的 `missing`（**判定键**，不是 B5 码） */
  missing: readonly string[];
  /** 同目标同事件类型的最近一条事件时间（ISO）；从未发过是 null */
  lastNotifiedAt: string | null;
};

/**
 * 不发的**原因**。写成枚举而不是 `false`：
 * "该发而没发"是这条规则的失败形态，而排障时"没发"与"为什么没发"是两件事。
 * 冒烟直接断言这些原因，所以它们不是日志装饰。
 */
export type ArchiveReminderReason =
  "due" | "deleted" | "not_closed" | "archived" | "no_missing" | "too_early" | "cooldown";

export type ArchiveReminderDecision = {
  due: boolean;
  reason: ArchiveReminderReason;
  /** 距"结案锚点"过去了几个业务日（`too_early` 时它 < `days`）。锚点缺失时为 null */
  daysClosed: number | null;
  /** 距上次同类提醒过去了几个业务日（从未发过是 null） */
  daysSinceLastNotify: number | null;
};

/** 结案锚点：`closing_date → last_progress_at → updated_at`（见文件头那段） */
function anchorOf(facts: ArchiveReminderFacts): string | null {
  return facts.closingDate ?? facts.lastProgressAt ?? facts.updatedAt ?? null;
}

/**
 * 判一条案件这次该不该发。
 *
 * `now` 显式传入（不读时钟）：扫描器一次扫描里所有判定共用同一个 `now`，
 * 否则同一次扫描里前后两条案件的时间基准会差几毫秒，而"满 14 天"是个**日界**判定——
 * 跨零点的那一次扫描会出现"同一批里一条 due、一条 not_due"的假象。
 */
export function judgeArchiveReminder(
  facts: ArchiveReminderFacts,
  config: ArchiveReminderConfig,
  now: string | Date,
): ArchiveReminderDecision {
  const daysSinceLastNotify =
    facts.lastNotifiedAt === null ? null : businessDaysBetween(facts.lastNotifiedAt, now);

  // 闸门顺序 = 由便宜到贵，也由"绝不会变"到"这次才成立"
  if (facts.isDeleted)
    return { due: false, reason: "deleted", daysClosed: null, daysSinceLastNotify };
  if (facts.status !== config.statusCode)
    return { due: false, reason: "not_closed", daysClosed: null, daysSinceLastNotify };
  // 归档是终态：材料问题已经以"写明原因"结清，再提醒就是让用户去改一条只读记录
  if (facts.isArchived)
    return { due: false, reason: "archived", daysClosed: null, daysSinceLastNotify };

  const anchor = anchorOf(facts);
  const daysClosed = anchor === null ? null : businessDaysBetween(anchor, now);

  if (facts.missing.length === 0)
    return { due: false, reason: "no_missing", daysClosed, daysSinceLastNotify };
  if (daysClosed === null || daysClosed < config.days)
    return { due: false, reason: "too_early", daysClosed, daysSinceLastNotify };
  /**
   * 冷却期：`once_per_target` 的兑现方式。
   *
   * `cooldown_days = 14` 的语义是"距上一条同类提醒不足 14 天就不再发"，
   * 所以第 14 天发第一条、第 15–27 天静默、第 28 天再发一条（材料仍未补齐时）。
   * 这与"只发一次、之后永远沉默"是**不同的产品行为**，而票面 AC 写的是
   * 「`once_per_target` 生效：14 天内不重复推」——按冷却期实现才与那句话逐字相符。
   * `once_per_target=false` 时冷却期不参与（§4.3：`cooldown_days` 只在 `once_per_target=true` 时有意义）。
   */
  if (
    config.oncePerTarget &&
    config.cooldownDays >= 1 &&
    daysSinceLastNotify !== null &&
    daysSinceLastNotify < config.cooldownDays
  ) {
    return { due: false, reason: "cooldown", daysClosed, daysSinceLastNotify };
  }
  return { due: true, reason: "due", daysClosed, daysSinceLastNotify };
}

/**
 * 事件 payload。
 *
 * `missing` 走 `missingCodes()` 转成 B5 码：模板的 `{missing}` 只认那一套
 * （直接塞判定键会在中文界面里渲染出 `closingDate`）。原始判定键另存一份
 * `missing_keys`，排障时不必反查映射表。
 */
export function archiveReminderPayload(args: {
  code: string;
  name: string;
  missing: readonly string[];
  daysClosed: number | null;
}): Record<string, unknown> {
  return {
    code: args.code,
    name: args.name,
    missing: missingCodes(args.missing),
    missing_keys: [...args.missing],
    // 模板没有 `{days}` 占位符；它是给排障与后续报表用的（"第几天发的"是可观测的口径）
    days_closed: args.daysClosed,
  };
}

/**
 * 供排障与断言：这条规则的 `missing` 最终会渲染成什么中文。
 *
 * 它**走的就是生产那条渲染路径**（`missingCodes` → `notificationVars`），
 * 不自己再拼一遍中文——两份渲染口径的漂移同样是静默的。
 */
export function archiveReminderMissingText(missing: readonly string[]): string {
  return notificationVars({ missing: missingCodes(missing) })["missing"] ?? "";
}

/**
 * 扫描用的业务日窗口下界（`YYYY-MM-DD`，Asia/Shanghai）。
 *
 * 它只用于**日志与断言**（"这次扫描看的是哪一天"），不参与判定——
 * 判定在 `judgeArchiveReminder` 里按业务日差现算，避免"窗口算错 ⇒ 静默漏发"。
 */
export function archiveReminderWindowDate(now: string | Date, days: number): string {
  const shifted = new Date(Date.parse(String(now)) - days * 86_400_000);
  return businessDateKey(shifted);
}

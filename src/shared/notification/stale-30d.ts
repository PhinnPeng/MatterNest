/**
 * **规则 4「长期未更新提醒」的判定**（MATT-61 / T4e，IQ-9 / Q37）。
 *
 * ## 它判什么
 *
 * `time_no_progress{days:30}` + `notify` +
 * `{receivers:["owner"], template_code:"stale_30d", once_per_target:true, cooldown_days:30}`
 * —— 也就是"一条案件距上次人工投入满 30 天 ⇒ 推给经办人一条，30 天内不重复"。
 *
 * ## 时钟锚点为什么是 `last_progress_at` 本身，而不是规则 9 那条兜底链
 *
 * 规则 9 的锚点是 `closing_date → last_progress_at → updated_at` 三档兜底，因为它的语义
 * 是"结案**后**材料没补齐"——原点必须在结案那一刻。规则 4 的语义是"**没人动过它**"，
 * 而 `closing_date` 被写上是**结案动作**的结果，不是"有人处理过案件"的证据：
 * 一条结案后无人过问的案件，`closing_date` 是齐的、材料是齐的，规则 9 不响（缺项为空），
 * 若规则 4 也跟着 `closing_date` 走，那它就永远不会响——**而"结案后没人管"恰恰是它最该响的那一档**。
 *
 * 所以本文件只认 `last_progress_at`（修订稿 §6.4 给 `time_no_progress` 定的基准），
 * 兜底只剩 `updated_at`（NOT NULL，理论上取不到不可能发生）：
 *   · `last_progress_at` 为空 = MATT-59 之前建的存量行（那一列只在建案时写过一次初值，
 *     也可能被更早的数据置空），此时按"最后被改过的时间"算，方向是"宁可提醒"；
 *   · `updated_at` 会被**任何**写入刷新（含系统动作），所以它只是让存量数据不至于永久沉默，
 *     不是"投入"的证据 —— 这与 `addProgress` 里"软删不算投入"是同一条口径。
 *
 * ## 为什么**没有**状态闸门（这一条与规则 9 显式不同，别照抄）
 *
 * `trigger_config` 只有 `{days:30}`，没有 `status_code` —— 那是规则目录里两条规则落在
 * 不同触发域的依据（`preset-rules.ts` 的注），加一道状态闸门就等于把域改了。
 * 而目录里**已经写明**双档是刻意接受的：
 * 「closed 案件 14 天先收『补材料』、30 天再收『无进展』——语义不同（归档驱动 vs 停滞驱动）」。
 * 换句话说：**已结案未归档且 30 天没人动**正是本规则要响的场景，不是要排除的噪声。
 *
 * 唯一排除的仍是归档（终态）：材料问题已经以"写明原因"结清，再提醒就是让用户去改一条只读记录。
 *
 * ## 为什么判定是纯函数、SQL 只做粗筛
 *
 * 与规则 9 同一条理由（`shared/notification/archive-reminder.ts` 文件头）：
 * 这道闸门写错**不会报错**，只会"该发的没发"或"重复发"，而这两种症状在库里都表现为
 * "事件表里没有/多了一行"，与"扫描器压根没跑"长得一样。所以判定只实现一次（这里），
 * 服务层那侧**不再用 SQL 复算一遍**。
 */
import { businessDateKey, businessDaysBetween } from "@/shared/time/zh-cn";

/** `trigger_config` / `action_config` 里本规则要用的三项（其余键不读） */
export type Stale30dConfig = {
  /** `trigger_config.days` —— 距上次投入满多少天 */
  days: number;
  /** `action_config.once_per_target` */
  oncePerTarget: boolean;
  /** `action_config.cooldown_days` —— 冷却期（天） */
  cooldownDays: number;
};

/** 判定要用的宿主事实。全部来自一条 `mn_matter` 行 + 一次事件回溯 */
export type Stale30dFacts = {
  isArchived: boolean;
  isDeleted: boolean;
  /** ISO 瞬时，可空（存量行可能为空，见文件头） */
  lastProgressAt: string | null;
  /** ISO 瞬时（NOT NULL），仅作兜底锚点 */
  updatedAt: string;
  /** 同目标同事件类型的最近一条事件时间（ISO）；从未发过是 null */
  lastNotifiedAt: string | null;
};

/** 不发的**原因**（写成枚举而不是 `false`：排障时"没发"与"为什么没发"是两件事） */
export type Stale30dReason = "due" | "deleted" | "archived" | "too_early" | "cooldown";

export type Stale30dDecision = {
  due: boolean;
  reason: Stale30dReason;
  /** 距"上次投入"过去了几个业务日（`too_early` 时它 < `days`）。锚点缺失时为 null */
  daysStale: number | null;
  /** 距上次同类提醒过去了几个业务日（从未发过是 null） */
  daysSinceLastNotify: number | null;
  /** 这次用的锚点（ISO 瞬时）。它不是日志装饰——通知正文的 `{last}` 就取它 */
  anchorAt: string | null;
};

/** 锚点：`last_progress_at → updated_at`（见文件头，为什么没有 `closing_date`） */
export function staleAnchorOf(facts: Stale30dFacts): string | null {
  return facts.lastProgressAt ?? facts.updatedAt ?? null;
}

/**
 * 判一条案件这次该不该发。
 *
 * `now` 显式传入（不读时钟）：扫描器一次扫描里所有判定共用同一个 `now`，
 * 否则同一次扫描里前后两条案件的时间基准会差几毫秒，而"满 30 天"是个**日界**判定——
 * 跨零点的那一次扫描会出现"同一批里一条 due、一条 not_due"的假象（与规则 9 同一条理由）。
 */
export function judgeStale30d(
  facts: Stale30dFacts,
  config: Stale30dConfig,
  now: string | Date,
): Stale30dDecision {
  const daysSinceLastNotify =
    facts.lastNotifiedAt === null ? null : businessDaysBetween(facts.lastNotifiedAt, now);

  // 闸门顺序 = 由便宜到贵，也由"绝不会变"到"这次才成立"
  if (facts.isDeleted)
    return { due: false, reason: "deleted", daysStale: null, daysSinceLastNotify, anchorAt: null };
  if (facts.isArchived)
    return { due: false, reason: "archived", daysStale: null, daysSinceLastNotify, anchorAt: null };

  const anchorAt = staleAnchorOf(facts);
  const daysStale = anchorAt === null ? null : businessDaysBetween(anchorAt, now);

  if (daysStale === null || daysStale < config.days)
    return { due: false, reason: "too_early", daysStale, daysSinceLastNotify, anchorAt };

  /**
   * 冷却期：`once_per_target` 的兑现方式，语义与规则 9 逐字相同 ——
   * `cooldown_days = 30` 是"距上一条同类提醒不足 30 天就不再发"，
   * 所以第 30 天发第一条、第 31–59 天静默、第 60 天再发一条（仍然没人管时）。
   * 这与"只发一次、之后永远沉默"是**不同的产品行为**，而票面 AC 写的是
   * 「`once_per_target` / `cooldown_days` 生效」——按冷却期实现才与那句话相符。
   * `once_per_target=false` 时冷却期不参与（§4.3：`cooldown_days` 只在它为 true 时有意义）。
   */
  if (
    config.oncePerTarget &&
    config.cooldownDays >= 1 &&
    daysSinceLastNotify !== null &&
    daysSinceLastNotify < config.cooldownDays
  ) {
    return { due: false, reason: "cooldown", daysStale, daysSinceLastNotify, anchorAt };
  }
  return { due: true, reason: "due", daysStale, daysSinceLastNotify, anchorAt };
}

/**
 * 事件 payload。
 *
 * ⚠ `last_progress_at` 这个键名**不是**自由选择：`notificationVars()` 里
 * 模板的 `{last}` 取的就是它（`template.ts:176`，过 `formatBusinessTime` 转业务时区）。
 * 写成 `last` 或 `at` 都不会报错，只会让正渲染出「自 — 后无任何人工更新」——
 * 一个读起来通顺、却把事实抹掉的句子。所以这里存**UTC 瞬时**，渲染层负责转时区。
 */
export function stale30dPayload(args: {
  code: string;
  name: string;
  /** 锚点（ISO 瞬时，可空） */
  anchorAt: string | null;
  daysStale: number | null;
}): Record<string, unknown> {
  return {
    code: args.code,
    name: args.name,
    last_progress_at: args.anchorAt,
    // 模板没有 `{days}` 占位符（`stale_30d` 的文案把 30 天写死在标题里）；
    // 它是给排障与后续报表用的（"第几天发的"是可观测的口径），与规则 9 的 `days_closed` 同形
    days_stale: args.daysStale,
  };
}

/**
 * 扫描用的业务日窗口下界（`YYYY-MM-DD`，Asia/Shanghai）。
 *
 * 只用于**日志与断言**（"这次扫描看的是哪一天"），不参与判定——
 * 判定在 `judgeStale30d` 里按业务日差现算，避免"窗口算错 ⇒ 静默漏发"（与规则 9 同形）。
 */
export function stale30dWindowDate(now: string | Date, days: number): string {
  const shifted = new Date(Date.parse(String(now)) - days * 86_400_000);
  return businessDateKey(shifted);
}

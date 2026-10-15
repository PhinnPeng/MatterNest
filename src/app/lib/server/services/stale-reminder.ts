import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  judgeStale30d,
  stale30dPayload,
  type Stale30dConfig,
  type Stale30dReason,
} from "@/shared/notification/stale-30d";
import { scheduledDedupeKey } from "@/shared/notification/dedupe";
import { RULE_STALE_30D_NOTIFY } from "@/shared/notification/preset-rules";
import type { NotifyReceiver } from "@/shared/enums/automation";
import { businessDateKey } from "@/shared/time/zh-cn";
import { getDb } from "../db/client";
import { automationRule, matter, notificationEvent } from "../db/schema";
import { insertNotificationEvent, loadHostFacts, resolveRecipients } from "./notifications";

/**
 * **规则 4「长期未更新提醒」的扫描器**（MATT-61 / T4e，IQ-9 / Q37）。
 *
 * ## 与规则 9 的关系：同一个形状，**不是**同一条规则
 *
 * 两条同为 `time_no_progress` + `notify`，靠 `trigger_config` 落在不同触发域
 * （`{days:30}` vs `{days:14,status_code:"closed"}`）。扫描器因此照 `services/archive-reminder.ts`
 * 的形状写（读规则行 → 粗筛 → 纯函数判 → 落事件），但**判定不共用**：
 * 规则 9 的时钟锚在结案、规则 4 的锚在"上次投入"（见 `shared/notification/stale-30d.ts` 的文件头）。
 * 两处判定合并成一个"带参数的通用停滞扫描器"看起来更省，代价是**任一规则的口径改动
 * 都会动到另一条**，而它们的语义分歧恰恰是刻意的（归档驱动 vs 停滞驱动）。
 *
 * ## 四个"静默失败"的位置（与规则 9 同一份清单，逐条说明为什么这么写）
 *
 * 1. **规则行读不到 ⇒ 不发**（fail-closed）。规则表是开关的唯一落点，若行缺失时回落到
 *    代码常量，"有人删了行"与"规则被停用"会得到两种相反的结果。返回 `ruleFound:false`
 *    让冒烟能把它与"停用"分开断言。
 * 2. **参数从库里读，不从常量读**（F5-10「可调参」的兑现方式）。常量只在行里缺那个键时兜底。
 * 3. **SQL 只做粗筛，时间判定全交给纯函数。** 见 `shared/notification/stale-30d.ts` 文件头。
 * 4. **`last_run_at` 每次都写。** 它是"扫描器真的跑了"的唯一可观测证据——
 *    没有它时"零事件"分不清是"没人该收"还是"扫描器没被调用"。
 *    而"写好了但没人调用"正是本票最该警惕的形态（票面点名的 `no-wiring`）。
 *
 * ## 粗筛为什么**不**带状态、也不碰时间列
 *
 * 状态：规则 4 没有 `status_code`（域里没有它），已结案未归档照样在范围内——
 * 目录里那句"closed 案件 14 天补材料、30 天无进展"是刻意接受的双档。
 * 时间：本查询不碰 `last_progress_at`，否则就是**第二份**"满 30 天"的实现，
 * 而两份实现的漂移是静默的（规则 9 文件头第 3 条同一条理由）。
 */
/** 规则 4 在 seed 里的 `code`。它是幂等锚，也是本扫描器认领规则行的唯一依据 */
export const STALE_REMINDER_RULE_CODE = "preset_04_stale_30d_notify";

/** 单次扫描的候选上限（与规则 9 同一个量级：一期案件 30–80/年） */
export const STALE_SCAN_LIMIT = 200;

/** 兜底参数：只在规则行缺那个键时用到（见文件头第 2 条） */
const FALLBACK_DAYS = 30;
const FALLBACK_COOLDOWN_DAYS = 30;

/** 跳过原因 = 纯判定的原因 + 两个**只在服务层才知道**的原因 */
export type StaleScanSkipReason = Stale30dReason | "no_recipient" | "host_missing";

export type StaleScanSkip = { matterId: string; reason: StaleScanSkipReason };

export type StaleScanResult = {
  /** 规则行在不在。`false` ⇒ 下面所有计数都是 0，且**没有**提醒发出 */
  ruleFound: boolean;
  /** 规则启用没有。`false` ⇒ 停用，扫描到此为止 */
  enabled: boolean;
  /** 粗筛出来的候选数（未归档、未删） */
  scanned: number;
  /** 这次真的落了几条事件 */
  events: number;
  /** 被 `dedupe_key` 吸收的条数（同一天重扫是正常路径） */
  merged: number;
  /** 未发出的候选及其原因（排障与断言都用它） */
  skipped: StaleScanSkip[];
  /** 扫描用的业务日（`YYYY-MM-DD`，Asia/Shanghai） */
  dateKey: string;
};

/** 从规则行的 jsonb 里取参数（缺键走兜底，值不合法也走兜底——不让一条坏配置把扫描卡死） */
function configOf(
  triggerConfig: Record<string, unknown>,
  actionConfig: Record<string, unknown>,
): Stale30dConfig & { receivers: readonly NotifyReceiver[] } {
  const days = Number(triggerConfig["days"]);
  const cooldownDays = Number(actionConfig["cooldown_days"]);
  const receivers = Array.isArray(actionConfig["receivers"])
    ? (actionConfig["receivers"] as unknown[]).map(String)
    : [];
  return {
    days: Number.isFinite(days) && days >= 1 ? days : FALLBACK_DAYS,
    oncePerTarget: actionConfig["once_per_target"] === true,
    cooldownDays:
      Number.isFinite(cooldownDays) && cooldownDays >= 1 ? cooldownDays : FALLBACK_COOLDOWN_DAYS,
    receivers: (receivers.length > 0
      ? receivers
      : RULE_STALE_30D_NOTIFY.receivers) as readonly NotifyReceiver[],
  };
}

/**
 * 跑一遍规则 4。**幂等**：同一天重扫由 `dedupe_key` 吸收，冷却期由纯函数挡。
 *
 * 由 `pump-gate.ts` 的 `pumpOnce()` 调用（与 outbox / 节点扫描 / 规则 9 同一个轮询点）。
 * ⚠ 新增扫描器必须加进那里，否则它会变成"写好了但没人调用"——
 * 那种形态与"没人该收"在库里长得一模一样（零事件）。
 */
export async function scanStale30d(now: Date = new Date()): Promise<StaleScanResult> {
  const db = await getDb();
  const dateKey = businessDateKey(now);
  const empty: StaleScanResult = {
    ruleFound: false,
    enabled: false,
    scanned: 0,
    events: 0,
    merged: 0,
    skipped: [],
    dateKey,
  };

  const [rule] = await db
    .select({
      id: automationRule.id,
      isEnabled: automationRule.isEnabled,
      triggerConfig: automationRule.triggerConfig,
      actionConfig: automationRule.actionConfig,
    })
    .from(automationRule)
    .where(
      and(eq(automationRule.code, STALE_REMINDER_RULE_CODE), sql`NOT ${automationRule.isDeleted}`),
    )
    .limit(1);
  if (!rule) return empty;

  // ⚠ 停用后**不再产生提醒**，而且连扫描都不做：这条早退就是那条 AC 的落点
  if (!rule.isEnabled) return { ...empty, ruleFound: true, enabled: false };

  const config = configOf(
    (rule.triggerConfig ?? {}) as Record<string, unknown>,
    (rule.actionConfig ?? {}) as Record<string, unknown>,
  );

  /**
   * **粗筛**：未归档、未删（不碰状态、不碰时间，理由见文件头最后一段）。
   *
   * 纯函数那一层会再判一次 `archived` / `deleted`，与这里重看是**刻意**的两层：
   * 这里管候选集规模（也让"已归档/已软删的记录根本不进扫描"成为结构性事实），
   * 那里管业务口径并产出可排障的原因（与规则 9 同一条分层理由）。
   */
  const candidates = await db
    .select({
      id: matter.id,
      isArchived: matter.isArchived,
      isDeleted: matter.isDeleted,
      lastProgressAt: matter.lastProgressAt,
      updatedAt: matter.updatedAt,
    })
    .from(matter)
    .where(and(eq(matter.isArchived, false), sql`NOT ${matter.isDeleted}`))
    .limit(STALE_SCAN_LIMIT);

  const result: StaleScanResult = {
    ruleFound: true,
    enabled: true,
    scanned: candidates.length,
    events: 0,
    merged: 0,
    skipped: [],
    dateKey,
  };

  /**
   * 上次同类提醒的时间：**一条分组查询取完**，不在循环里逐条查。
   * 循环里查 N 次的问题不是慢，是"第一条命中后改变了后面的输入"这类隐蔽耦合，
   * 而这里要的恰恰是"扫描开始那一刻的快照"（与规则 9 同一条理由）。
   */
  const ids = candidates.map((c) => c.id);
  const lastNotifyByTarget = new Map<string, string>();
  if (ids.length > 0) {
    const rows = await db
      .select({
        targetId: notificationEvent.targetId,
        lastAt: sql<string>`max(${notificationEvent.createdAt})`,
      })
      .from(notificationEvent)
      .where(
        and(
          eq(notificationEvent.eventType, "stale_30d"),
          eq(notificationEvent.targetType, "matter"),
          inArray(notificationEvent.targetId, ids),
          isNotNull(notificationEvent.createdAt),
        ),
      )
      .groupBy(notificationEvent.targetId);
    for (const r of rows) lastNotifyByTarget.set(String(r.targetId), r.lastAt);
  }

  for (const c of candidates) {
    const decision = judgeStale30d(
      {
        isArchived: c.isArchived,
        isDeleted: c.isDeleted,
        lastProgressAt: c.lastProgressAt,
        updatedAt: c.updatedAt,
        lastNotifiedAt: lastNotifyByTarget.get(String(c.id)) ?? null,
      },
      config,
      now,
    );
    if (!decision.due) {
      result.skipped.push({ matterId: String(c.id), reason: decision.reason });
      continue;
    }

    const facts = await loadHostFacts(db, "matter", c.id);
    if (!facts) {
      result.skipped.push({ matterId: String(c.id), reason: "host_missing" });
      continue;
    }
    const res = await db.transaction(async (tx) => {
      const recipients = await resolveRecipients(tx, "matter", c.id, facts, config.receivers);
      if (recipients.length === 0) return { eventId: null as bigint | null, merged: false };
      return insertNotificationEvent(tx, {
        eventType: "stale_30d",
        // E30：系统动作没有 actor，规则以 operator=SYSTEM 执行（权限草案 §8）
        sourceType: "auto_rule",
        sourceRuleId: rule.id,
        host: "matter",
        hostId: c.id,
        targetType: "matter",
        targetId: c.id,
        batchId: randomUUID(),
        dedupeKey: scheduledDedupeKey({
          eventType: "stale_30d",
          targetId: c.id,
          dateKey,
        }),
        payload: stale30dPayload({
          code: facts.code,
          name: facts.name,
          anchorAt: decision.anchorAt,
          daysStale: decision.daysStale,
        }),
        recipients,
      });
    });
    if (res.merged) result.merged++;
    else if (res.eventId !== null) result.events++;
    // 判定说该发、但收件人解析结果为空（例如 owner 已被清空）：这是**另一档**，
    // 与"还没满 30 天所以不发"混在一个原因里会让排障指向错误的方向
    else result.skipped.push({ matterId: String(c.id), reason: "no_recipient" });
  }

  /** `last_run_at`：零事件时它是"扫描器确实跑过"的唯一证据（见文件头第 4 条） */
  await db
    .update(automationRule)
    .set({ lastRunAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(automationRule.id, rule.id));

  return result;
}

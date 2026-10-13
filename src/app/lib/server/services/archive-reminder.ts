import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  archiveReminderPayload,
  judgeArchiveReminder,
  type ArchiveReminderConfig,
  type ArchiveReminderReason,
} from "@/shared/notification/archive-reminder";
import { scheduledDedupeKey } from "@/shared/notification/dedupe";
import { RULE_ARCHIVE_INCOMPLETE_NOTIFY } from "@/shared/notification/preset-rules";
import type { NotifyReceiver } from "@/shared/enums/automation";
import { businessDateKey } from "@/shared/time/zh-cn";
import { getDb } from "../db/client";
import { automationRule, matter, notificationEvent } from "../db/schema";
import { judgeArchiveReadiness } from "./archive-readiness";
import { insertNotificationEvent, loadHostFacts, resolveRecipients } from "./notifications";

/**
 * **规则 9「结案后材料不全提醒」的扫描器**（MATT-43 / T5b，F2-26④ / IQ-16）。
 *
 * ## 为什么它住自己的文件，而不是并进 `services/notifications.ts`
 *
 * 那个文件是通知管线的**通用**部分（outbox、投递、收件人、通知中心），已经 1200+ 行；
 * 而本文件是**一条规则**的作业逻辑：读规则行 → 找候选 → 判定 → 落事件。
 * 它与通用管线的接口只有三个函数（`loadHostFacts` / `resolveRecipients` /
 * `insertNotificationEvent`），都是已经导出的，所以这里能单向依赖它。
 *
 * ## 这条链路上"静默失败"的四个位置，逐个说明为什么这么写
 *
 * 1. **规则行读不到 ⇒ 不发。** 这是**故意**的 fail-closed：规则表是开关的唯一落点
 *    （票面 AC「规则可停用；停用后不再产生提醒」），若行缺失时回落到代码里的常量，
 *    那么"有人删了行"与"规则被停用"就会得到两种相反的结果，而删行是不可达的
 *    （`is_system` 不可删）。返回 `ruleFound:false` 让冒烟能把它与"停用"分开断言。
 * 2. **参数从库里读，不从常量读。** `days` / `cooldown_days` / `receivers` 全部来自
 *    规则行——"可调参"（F5-10）的兑现方式就是这个。常量只在**行里没有那个键**时兜底，
 *    而"行里没有"本身由 `preset-rules.seed.spec.ts` 挡在 seed 之外。
 * 3. **SQL 只做粗筛，时间判定全交给纯函数。** 见 `shared/notification/archive-reminder.ts`
 *    的文件头：两份判定各算一遍，漂移是静默的。
 * 4. **`last_run_at` 每次都写。** 它是"扫描器真的跑了"的**唯一可观测证据**——
 *    没有它时"零事件"分不清是"没人该收"还是"扫描器没被调用"。
 *    这也是本票最该警惕的失败形态（票面末段点名）。
 *
 * ## 与规则 4 的关系
 *
 * 两条规则同为 `time_no_progress` + `notify`，靠 `trigger_config` 落在不同触发域
 * （`{days:30}` vs `{days:14,status_code:"closed"}`）。规则 4 的扫描器**不在本票范围**
 * （`stale_30d` 至今没有生产者，见 `notification/preset-rules.ts` 的注）。
 */
/** 规则 9 在 seed 里的 `code`。它是幂等锚，也是本扫描器认领规则行的唯一依据 */
export const ARCHIVE_REMINDER_RULE_CODE = "preset_09_archive_incomplete_notify";

/** 单次扫描的候选上限。够大（一期案件 30–80/年）也够小（一次读请求内跑完） */
export const ARCHIVE_SCAN_LIMIT = 200;

/** 兜底参数：只在规则行缺那个键时用到（见文件头第 2 条） */
const FALLBACK_DAYS = 14;
const FALLBACK_COOLDOWN_DAYS = 14;

/**
 * 跳过原因 = 纯判定的原因 + 两个**只在服务层才知道**的原因。
 *
 * 后两个不能并进 `ArchiveReminderReason`：那是纯函数能看见的世界
 * （它不知道"收件人解析结果为空"与"宿主行没了"）。
 */
export type ArchiveScanSkipReason = ArchiveReminderReason | "no_recipient" | "host_missing";

export type ArchiveScanSkip = { matterId: string; reason: ArchiveScanSkipReason };

export type ArchiveScanResult = {
  /** 规则行在不在。`false` ⇒ 下面所有计数都是 0，且**没有**提醒发出 */
  ruleFound: boolean;
  /** 规则启用没有。`false` ⇒ 停用，扫描到此为止 */
  enabled: boolean;
  /** 粗筛出来的候选数（已结案、未归档、未删） */
  scanned: number;
  /** 这次真的落了几条事件 */
  events: number;
  /** 被 `dedupe_key` 吸收的条数（同一天重扫是正常路径） */
  merged: number;
  /** 未发出的候选及其原因（排障与断言都用它） */
  skipped: ArchiveScanSkip[];
  /** 扫描用的业务日（`YYYY-MM-DD`，Asia/Shanghai） */
  dateKey: string;
};

/** 从规则行的 jsonb 里取参数（缺键走兜底，值不合法也走兜底——不让一条坏配置把扫描卡死） */
function configOf(
  triggerConfig: Record<string, unknown>,
  actionConfig: Record<string, unknown>,
): ArchiveReminderConfig & { receivers: readonly NotifyReceiver[] } {
  const days = Number(triggerConfig["days"]);
  const cooldownDays = Number(actionConfig["cooldown_days"]);
  const statusCode = triggerConfig["status_code"];
  const receivers = Array.isArray(actionConfig["receivers"])
    ? (actionConfig["receivers"] as unknown[]).map(String)
    : [];
  return {
    days: Number.isFinite(days) && days >= 1 ? days : FALLBACK_DAYS,
    statusCode: typeof statusCode === "string" && statusCode !== "" ? statusCode : "closed",
    oncePerTarget: actionConfig["once_per_target"] === true,
    cooldownDays:
      Number.isFinite(cooldownDays) && cooldownDays >= 1 ? cooldownDays : FALLBACK_COOLDOWN_DAYS,
    receivers: (receivers.length > 0
      ? receivers
      : RULE_ARCHIVE_INCOMPLETE_NOTIFY.receivers) as readonly NotifyReceiver[],
  };
}

/**
 * 跑一遍规则 9。**幂等**：同一天重扫由 `dedupe_key` 吸收，冷却期由纯函数挡。
 *
 * 由 `GET /api/notifications` 触发（与 outbox / 节点扫描同一个轮询点）。
 */
export async function scanArchiveIncomplete(now: Date = new Date()): Promise<ArchiveScanResult> {
  const db = await getDb();
  const dateKey = businessDateKey(now);
  const empty: ArchiveScanResult = {
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
      and(
        eq(automationRule.code, ARCHIVE_REMINDER_RULE_CODE),
        sql`NOT ${automationRule.isDeleted}`,
      ),
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
   * **粗筛**：已结案、未归档、未删。
   *
   * ## 两层闸门（反向红实测出来的分层，别把它读成重复代码）
   *
   * 状态与归档这两件事在链路上各有**两层**：
   *   · SQL 这一层（本查询）—— 管候选集规模，也让"已归档/已软删的记录根本不进扫描"
   *     成为一条结构性事实；
   *   · 纯函数那一层（`judgeArchiveReminder`）—— 管业务口径，产出 `not_closed` /
   *     `archived` 这些**可排障的原因**。
   *
   * 代价是单独摘掉任何一层都可能**不红**（另一层还挡着）。`revred-rule9.mjs` 里
   * 状态那个模式因此写了两处锚点、归档那个模式换到单测门上——那是工具的事，
   * 不是这里的缺陷：两层各自都成立，且第二层给得出原因。
   *
   * ⚠ 时间判定**不在这里**（本查询不碰 `closing_date` / `last_progress_at`）：
   * 两次实现同一个"满 14 天"的漂移是静默的，见 `shared/notification/archive-reminder.ts`。
   */
  const candidates = await db
    .select({
      id: matter.id,
      code: matter.internalCode,
      name: matter.name,
      status: matter.status,
      isArchived: matter.isArchived,
      isDeleted: matter.isDeleted,
      closingDate: matter.closingDate,
      lastProgressAt: matter.lastProgressAt,
      updatedAt: matter.updatedAt,
    })
    .from(matter)
    .where(
      and(
        eq(matter.status, config.statusCode),
        eq(matter.isArchived, false),
        sql`NOT ${matter.isDeleted}`,
      ),
    )
    .limit(ARCHIVE_SCAN_LIMIT);

  const result: ArchiveScanResult = {
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
   * 循环里查 N 次的问题不是慢，是"第一条命中后改变了后面的输入"这类隐蔽耦合——
   * 而这里要的恰恰是"扫描开始那一刻的快照"。
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
          eq(notificationEvent.eventType, "archive_incomplete"),
          eq(notificationEvent.targetType, "matter"),
          inArray(notificationEvent.targetId, ids),
          isNotNull(notificationEvent.createdAt),
        ),
      )
      .groupBy(notificationEvent.targetId);
    for (const r of rows) lastNotifyByTarget.set(String(r.targetId), r.lastAt);
  }

  for (const c of candidates) {
    // 缺项判定**只实现一次**（T5a 的 `judgeArchiveReadiness`）——
    // 本票不重写那三项校验，只消费它的结论
    const readiness = await judgeArchiveReadiness(db, String(c.id));
    const decision = judgeArchiveReminder(
      {
        status: c.status,
        isArchived: c.isArchived,
        isDeleted: c.isDeleted,
        closingDate: c.closingDate,
        lastProgressAt: c.lastProgressAt,
        updatedAt: c.updatedAt,
        missing: readiness?.missing ?? [],
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
        eventType: "archive_incomplete",
        // E30：系统动作没有 actor，规则以 operator=SYSTEM 执行（权限草案 §8）
        sourceType: "auto_rule",
        sourceRuleId: rule.id,
        host: "matter",
        hostId: c.id,
        targetType: "matter",
        targetId: c.id,
        // 定时类没有"一次业务操作"的批次号：`event_batch_id` 在这里只用于排障分组，
        // 聚合语义由 `dedupe_key` 的业务日承担（与 `scanDueNodes` 同一条理由）
        batchId: randomUUID(),
        dedupeKey: scheduledDedupeKey({
          eventType: "archive_incomplete",
          targetId: c.id,
          dateKey,
        }),
        payload: archiveReminderPayload({
          code: facts.code,
          name: facts.name,
          missing: readiness?.missing ?? [],
          daysClosed: decision.daysClosed,
        }),
        recipients,
      });
    });
    if (res.merged) result.merged++;
    else if (res.eventId !== null) result.events++;
    // 判定说该发、但收件人解析结果为空（例如 owner 已被清空）：这是**另一档**，
    // 与"材料齐备所以不发"混在一个原因里会让排障指向错误的方向
    else result.skipped.push({ matterId: String(c.id), reason: "no_recipient" });
  }

  /**
   * `last_run_at`：**零事件时它是"扫描器确实跑过"的唯一证据**（见文件头第 4 条）。
   * 写在最后：中途抛错时它不会前进，于是"卡住了"与"跑过了但没人该收"也能分开。
   */
  await db
    .update(automationRule)
    .set({ lastRunAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(automationRule.id, rule.id));

  return result;
}

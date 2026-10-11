/**
 * `mn_event_outbox`：业务事务 → 异步投递的**唯一交接点**（映射矩阵 §4.1）。
 *
 * 为什么必须有这张表：规则 7「转案件后自动归档事项」若在转案件事务里同步执行，
 * 会出两种错——① 读到尚未提交的另一行（自己的未提交写入互相不可见）；
 * ② 它自己失败把整次转换一起回滚，用户看到"转案件失败"，但案件其实建了又删了。
 * 两者都不是"重试一下"能解决的。
 *
 * 投递语义是**至少一次**（扫 `published_at IS NULL`，成功打时间戳），所以
 * **消费侧必须去重**：`mn_notification_event.dedupe_key` 唯一 + `AUTO_RULE_SKIPPED` 记跳过。
 * 这里不提供 exactly-once，别在别处假设有。
 *
 * `batch_id` 兼任权限草案 §7.1 的 `event_batch_id` 聚合键：一次转换生成 N 个案件，
 * 它们发出的通知要聚合成一条，否则用户会被 N 条同源通知淹没。
 *
 * 一期只建表、不实现消费侧（消费属 M5/T4）。建而不用的理由：
 * 缺了它，转案件事务就**没有**合法的出口——而绕过它直发通知等于把上面两种错重新引进来。
 *
 * 表形状照映射矩阵 §4.1 给出的 DDL 逐字落地，那里的字段与类型即本文件的依据。
 */
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { id } from "./common";

export const eventOutbox = pgTable(
  "mn_event_outbox",
  {
    id: id(),
    /** 领域事件名，如 `risk_converted`。值域随业务线落地，尚未进枚举表 */
    eventType: varchar("event_type", { length: 40 }).notNull(),
    /** 一次业务动作的批次号；权限草案 §7.1 的通知聚合键就是它 */
    batchId: uuid("batch_id").notNull(),
    payload: jsonb("payload").notNull(),
    /** NULL = 待投递。非 NULL = 已投递（至少一次，故幂等由消费侧负责） */
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
    attempts: integer("attempts").notNull().default(0),
    lastError: varchar("last_error", { length: 500 }),
  },
  (t) => [
    // 投递器的主查询形状：只扫未投递的。partial index 让它不随历史增长变慢。
    index("ix_outbox_pending")
      .on(t.id)
      .where(sql`${t.publishedAt} is null`),
  ],
);

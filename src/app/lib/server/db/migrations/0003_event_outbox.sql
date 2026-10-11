-- 0003：mn_event_outbox（2026-10-11，映射矩阵 §4.1）
--
-- 转案件事务原本**没有合法的通知出口**：规则 7（转案件后自动归档）要么在事务内
-- 同步执行（读到未提交行 / 自身失败把整次转换回滚），要么绕过 outbox 直发通知
-- （同样两种错）。所以 T2 先把这张交接表建出来——**建而不实现消费侧**
-- （消费属 M5/T4），缺了它转案件就只能选那两条错路之一。
--
-- 表形状照映射矩阵 §4.1 给出的 DDL 逐字落地。两条语义写在这里，免得日后被"优化"掉：
--   · 投递是**至少一次**（扫 published_at IS NULL）。所以消费侧必须靠
--     mn_notification_event.dedupe_key 唯一 + AUTO_RULE_SKIPPED 去重——
--     这张表不提供 exactly-once。
--   · batch_id 兼任权限草案 §7.1 的 event_batch_id 聚合键：一次转换生成 N 个
--     案件，若不聚合，用户会收到 N 条同源通知然后开始屏蔽通知（G3 反例）。
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mn_event_outbox" (
  "id" bigint PRIMARY KEY,
  "event_type" varchar(40) NOT NULL,
  "batch_id" uuid NOT NULL,
  "payload" jsonb NOT NULL,
  "published_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" varchar(500)
);
--> statement-breakpoint
-- 投递器的主查询形状：只扫未投递的。partial index 让它不随历史增长变慢，
-- 且历史行不进索引——这是它用 partial 而不是全量索引的全部理由。
CREATE INDEX IF NOT EXISTS "ix_outbox_pending" ON "mn_event_outbox" ("id") WHERE "published_at" IS NULL;
-- 0002：T0 裁定对齐底座——扩三处 CHECK（2026-10-11）
--
-- 背景：意图对齐轮 IQ-5/6/7/11/12/13/16 的裁定已回写文档（枚举表 v5），本迁移把**值域**
-- 补到与文档、代码注册表一致，让 `enum-check` 三向转绿。
--
-- 为什么是"扩"而不是"换"：枚举表 §5.3 废弃流程规定**禁止从 CHECK 删值**——
-- 历史行仍需能反查中文名，且删值是破坏性迁移。所以：
--   · `customer_complaint` 与 `non_litigation` **留在 CHECK 里**，只是禁止新写入、
--     前端不展示（代码侧用 `*_WRITABLE` 收窄写路径，见 `business.ts`）。
--   · 本文件只做 `DROP CONSTRAINT` + `ADD CONSTRAINT` 的等价替换，把**并集**写进去。
--
-- ① `ck_mn_risk_matter_source`（E16）：新增 `external_dispute`（对外纠纷/投诉），
--    替换律所口径的 `customer_complaint` 作为可写值；旧值保留供历史行反查。
-- ② `ck_mn_activity_action`（§3）：新增 `EXPORT`（IQ-12 明文/脱敏导出统一留痕，
--    payload 记 `plain` 布尔与行数、不含内容）、`PARTY_MERGED`（F3-9 合并，
--    IQ-7）、`BULK_IMPORT`（F7-4 导入汇总，IQ-11）。
--    `SENSITIVE_FIELD_READ` **保留在 CHECK 里**（§5.3），但一期不再写入——作废的是
--    "展示层明文要逐次审计"这个行为，不是这个历史值。
-- ③ E29 `notification_event.event_type` 新增第 8 值 `archive_incomplete`：
--    **该表尚未建库**（注册表 E29 标 `pending-table`），故此处只做**登记**，
--    等表落地那张迁移建 CHECK 时直接写全 8 值。本行不产生 DDL。
--
-- 排序说明：`DROP CONSTRAINT IF EXISTS` 在 ADD 之前，保证重放不因约束缺失而失败。
--> statement-breakpoint
ALTER TABLE "mn_risk_matter" DROP CONSTRAINT IF EXISTS "ck_mn_risk_matter_source";
--> statement-breakpoint
ALTER TABLE "mn_risk_matter" ADD CONSTRAINT "ck_mn_risk_matter_source" CHECK (source IS NULL OR source IN ('business_report','external_dispute','customer_complaint','lawyer_letter','internal_check','other'));
--> statement-breakpoint
ALTER TABLE "mn_activity_log" DROP CONSTRAINT IF EXISTS "ck_mn_activity_action";
--> statement-breakpoint
ALTER TABLE "mn_activity_log" ADD CONSTRAINT "ck_mn_activity_action" CHECK (action IN ('MATTER_CREATED','MATTER_UPDATED','MATTER_DELETED','RISK_CREATED','RISK_UPDATED','RISK_DELETED','NODE_CREATED','NODE_UPDATED','NODE_DELETED','PROGRESS_CREATED','PROGRESS_UPDATED','PROGRESS_DELETED','EXPENSE_CREATED','EXPENSE_UPDATED','EXPENSE_DELETED','PARTY_CREATED','PARTY_UPDATED','PARTY_DELETED','COMMENT_CREATED','COMMENT_UPDATED','COMMENT_DELETED','ATTACHMENT_UPLOADED','ATTACHMENT_DELETED','STATUS_CHANGED','ARCHIVED','UNARCHIVED','OWNER_CHANGED','CONVERTED_TO_CASE','UNCONVERT','NODE_COMPLETED','NODE_CANCELLED','STAFF_CHANGED','ROLE_CHANGED','USER_ACTIVATED','SENSITIVE_FIELD_READ','ACCESS_DENIED_WRITE','EXPORT','AUTO_RULE_EXECUTED','AUTO_RULE_SKIPPED','AUTO_RULE_FAILED','REMINDER_SENT','REMINDER_FAILED','PARTY_MERGED','BULK_IMPORT'));
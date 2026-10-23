-- 0023：案件材料（宿主级附件）—— 名称、描述、scope 与编辑审计（2026-10-23）--
--
-- 现有附件只有一条窄缝：上传先落草稿（`comment_id IS NULL`），唯一"确认"动作是
-- 发一条评论。案件详情页需要独立的材料模块（上传 / 作废 / 编辑 / 按状态查看），
-- 所以新增 `scope` 把两种用途分开：
--   · `comment` —— 评论附件（默认，历史行全部落在这里）
--   · `host`    —— 宿主级材料，上传即归属，不挂评论
-- `display_name` / `description` 是模块要的「附件名称 / 描述」；名称留空时回退 `file_name`。
--
-- 顺手修一处漂移：`ck_mn_attachment_owner_type` 还停在 0018 的六值，
-- 而 schema 侧已随 TARGET_TYPES 演化出 `risk_matter_progress`（迁移 0021）。
-- 重建后两者对齐。
--
-- 审计新增 `ATTACHMENT_UPDATED`（编辑名称/描述），否则改过的材料没有留痕。
ALTER TABLE "mn_attachment" ADD COLUMN "display_name" varchar(255);--> statement-breakpoint
ALTER TABLE "mn_attachment" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "mn_attachment" ADD COLUMN "scope" varchar(16) DEFAULT 'comment' NOT NULL;--> statement-breakpoint
ALTER TABLE "mn_attachment" ADD CONSTRAINT "ck_mn_attachment_scope" CHECK (scope IN ('comment','host'));--> statement-breakpoint
ALTER TABLE "mn_attachment" DROP CONSTRAINT IF EXISTS "ck_mn_attachment_owner_type";--> statement-breakpoint
ALTER TABLE "mn_attachment" ADD CONSTRAINT "ck_mn_attachment_owner_type" CHECK (owner_type IN ('matter','risk_matter','matter_node','risk_matter_node','matter_progress','risk_matter_progress','matter_expense'));--> statement-breakpoint
CREATE INDEX "ix_mn_attachment_owner_all" ON "mn_attachment" USING btree ("owner_type","owner_id","scope","is_deleted");--> statement-breakpoint
ALTER TABLE "mn_activity_log" DROP CONSTRAINT IF EXISTS "ck_mn_activity_action";--> statement-breakpoint
ALTER TABLE "mn_activity_log" ADD CONSTRAINT "ck_mn_activity_action" CHECK (action IN ('MATTER_CREATED','MATTER_UPDATED','MATTER_DELETED','RISK_CREATED','RISK_UPDATED','RISK_DELETED','NODE_CREATED','NODE_UPDATED','NODE_DELETED','PROGRESS_CREATED','PROGRESS_UPDATED','PROGRESS_DELETED','EXPENSE_CREATED','EXPENSE_UPDATED','EXPENSE_DELETED','PARTY_CREATED','PARTY_UPDATED','PARTY_DELETED','COMMENT_CREATED','COMMENT_UPDATED','COMMENT_DELETED','ATTACHMENT_UPLOADED','ATTACHMENT_DELETED','ATTACHMENT_UPDATED','STATUS_CHANGED','ARCHIVED','UNARCHIVED','OWNER_CHANGED','CONVERTED_TO_CASE','UNCONVERT','NODE_COMPLETED','NODE_CANCELLED','STAFF_CHANGED','ROLE_CHANGED','USER_ACTIVATED','USER_STATUS_CHANGED','CREDENTIAL_CHANGED','SENSITIVE_FIELD_READ','EXPORT','AUTO_RULE_EXECUTED','AUTO_RULE_SKIPPED','AUTO_RULE_FAILED','REMINDER_SENT','REMINDER_FAILED','PARTY_MERGED','BULK_IMPORT'));
--> statement-breakpoint
-- DOWN（前滚优先，但人要看得懂丢了什么）：
--   ALTER TABLE mn_attachment DROP COLUMN scope, DROP COLUMN display_name, DROP COLUMN description;
--   DROP INDEX ix_mn_attachment_owner_all;
--   重建 ck_mn_attachment_owner_type 为 0018 的六值、重建 ck_mn_activity_action **去掉**
--   ATTACHMENT_UPDATED（若已经写过该动作的审计行，重建 CHECK 会直接失败——那正是"别回退"的信号）。
--   ⇒ 材料名称/描述与用途区分全部丢失；已作废的材料回退后仍按旧口径对读侧不可见。


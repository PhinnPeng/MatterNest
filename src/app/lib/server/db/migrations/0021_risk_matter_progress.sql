-- 事项进展（2026-10-23）
--
-- §6.3 原本明写「不给事项加进展表」，处置过程走事项评论。用户裁定事项也要一张
-- 结构化的办理记录，评论退回它本来的角色（对话）。两张进展表由 `progressTable`
-- 工厂产出，列集合由 `enum-check.spec.ts` 的 ISO_PAIRS 逐列比对。
--
-- `last_progress_at` 只为详情页读数，**不接**规则 4「30 天无更新」：
-- 那条规则按 IQ-9 / Q37 仍只扫案件。写入与进展同一事务（与案件侧同一条口径）。
-- 事项进展的审计要落 `target_type='risk_matter_progress'`（E03 扩域）。
-- 与迁移 0006 加 `app_user` 同一做法：先删后建，宿主列约束不变
-- （进展动作总是带 `risk_matter_id`，仍满足「业务对象必须有宿主」）。
ALTER TABLE "mn_activity_log" DROP CONSTRAINT IF EXISTS "ck_mn_activity_target_type";--> statement-breakpoint
ALTER TABLE "mn_activity_log" ADD CONSTRAINT "ck_mn_activity_target_type" CHECK (target_type IN ('matter','risk_matter','matter_node','risk_matter_node','matter_progress','risk_matter_progress','matter_expense','app_user'));--> statement-breakpoint
CREATE TABLE "mn_risk_matter_progress" (
	"id" bigint PRIMARY KEY NOT NULL,
	"risk_matter_id" bigint NOT NULL,
	"node_id" bigint,
	"progress_type" varchar(24) NOT NULL,
	"content" text NOT NULL,
	"progress_date" date NOT NULL,
	"next_plan" text,
	"author_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_risk_matter_progress_type" CHECK (progress_type IN ('routine','court_action','counterparty','client_feedback','internal_decision','material_filing'))
);
--> statement-breakpoint
ALTER TABLE "mn_risk_matter" ADD COLUMN "last_progress_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_progress" ADD CONSTRAINT "mn_risk_matter_progress_risk_matter_id_mn_risk_matter_id_fk" FOREIGN KEY ("risk_matter_id") REFERENCES "public"."mn_risk_matter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_progress" ADD CONSTRAINT "mn_risk_matter_progress_node_id_mn_risk_matter_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."mn_risk_matter_node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_progress" ADD CONSTRAINT "mn_risk_matter_progress_author_id_mn_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_progress_host" ON "mn_risk_matter_progress" USING btree ("risk_matter_id","progress_date") WHERE NOT is_deleted;--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_progress_scan" ON "mn_risk_matter_progress" USING btree ("risk_matter_id","created_at") WHERE NOT is_deleted;

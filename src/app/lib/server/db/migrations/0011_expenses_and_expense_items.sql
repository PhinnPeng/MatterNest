-- 0011：费用（US-41）与费用项目配置（MATT-47 / T9，2026-10-15）
--
-- 三张表一起建，因为它们互相咬合：费用行**必须**指到一个费用项目（`item_id` NOT NULL），
-- 所以配置表不能晚一步。三张的权威出处逐条列在下面，字段名不发明。
--
-- ## ① `mn_expense_item_config` —— 费用项目配置（基线 7.6 / master F5-4）
--
-- 基线 7.6 原文：「费用项目配置：名称、编码、是否启用、排序（仅支出）」。
-- 形状照 `mn_risk_level_config` / `mn_tag`（另外两张配置表）：code 唯一、`is_system`
-- 区分预置与自建、`is_enabled` 是停用位（**配置表不软删**，`common.ts` 的
-- `createdOnlyColumns` 就是给这类表用的）。
--
-- 配置**页**（P16 `/settings/expense-items`）归 M5，本迁移只建表 + seed（见
-- `seed/0004_expense_item_config.sql`）：本票的费用录入是**只读**消费这份配置的。
--
-- ## ② `mn_matter_expense` + `mn_risk_matter_expense` —— 费用同构表对
--
-- 为什么是同构一对而不是案件侧一张：修订稿 §1「业务从属关系按宿主拆表，真外键」，
-- 运行时从属表一律成对（`*_node` / `*_party` / `*_staff` 三对已在库），
-- 而 `MATT-8` 的 `ISO_PAIRS` 契约测试逐对校验列集合 —— 只建一侧会让"两条 SQL
-- 各扫自己表"那类跨宿主查询在结构上不成立。两张表的列由 `hosts.ts` 的
-- `expenseTable()` 工厂产出，本文件里的字面量必须与它逐字一致（契约测试读的就是这里）。
--
-- 列口径（基线 4.6：「字段：费用项目、金额、发生日期、状态、备注、附件」）：
--   · `item_id`   → 费用项目，真外键到配置表（RESTRICT：被引用的项目不许删）；
--   · `amount`    → 金额，`numeric(18,2)`，**禁 float**（修订稿 §12.2）。
--                   没有 `currency` 列：一期 E27 只有 CNY，而宿主（案件/事项）各自带
--                   `currency`，费用与宿主同币种。另立一列会让"合计"必须按币种分组，
--                   而一期没有第二种币种可分组 —— 那是给一个不存在的问题加复杂度；
--   · `occurred_date` → 发生日期，`date` 而非 `timestamptz`（§12.2：日历日期跨时区会漂一天）；
--   · `status`    → E20 三值 `pending_pay` / `paid` / `void`，**不含 `approved`**
--                   （第一期无审批流，`approved` 位留二期 —— 加进来就是给二期挖坑）；
--   · `remark`    → 备注；
--   · 附件：基线 4.6 列了"附件"，但 `mn_attachment` 一期**未建**（MinIO 服务账号未开通，
--     见 `collab.ts` 头注），所以这里**不留附件列** —— 留一个指向不存在表的列，
--     只会让后来的人以为附件已经能挂。
--
-- 审计列用 `auditColumns`（软删 + 四个时间/人列）而不是 `createdOnlyColumns`：
-- 费用是可改可删的**业务明细**（与 `*_node` / `matter_progress` 同级），
-- 而"撤销转案件"的前置判定要能排除已软删的行（见 `risks.ts` 的 `unconvertFromCase`）。
--
-- 索引：宿主 + 发生日期（详情页列表与 `SUM` 都走它）、`item_id`（按项目分组的反查）。
-- 两张表的宿主外键都取 **RESTRICT**，与 `mn_matter_progress` / `mn_matter_node` 一致
-- （宿主是软删的，硬删带费用的宿主本来就不该发生）。
--
-- DOWN（前滚优先，但人要看得懂丢了什么）：
--   DROP TABLE "mn_risk_matter_expense"; DROP TABLE "mn_matter_expense";
--   DROP TABLE "mn_expense_item_config";
--   ⇒ **数据全丢**：费用是用户录入的业务事实，回退后没有第二处副本。
--      真要回退，先把两张费用表 `COPY … TO` 出去再删。
--> statement-breakpoint

-- ① 费用项目配置。`is_system` 的行由 seed 持有（可停用、不可删），与另外两张配置表同口径。
CREATE TABLE "mn_expense_item_config" (
	"id" bigint PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(50) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_expense_item_code" ON "mn_expense_item_config" USING btree ("code");
--> statement-breakpoint

-- ② 案件侧费用。列顺序与事项侧逐字一致（唯一差异是宿主外键列名），ISO 契约测试按此判定。
CREATE TABLE "mn_matter_expense" (
	"id" bigint PRIMARY KEY NOT NULL,
	"matter_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"amount" numeric(18,2) NOT NULL,
	"occurred_date" date NOT NULL,
	"status" varchar(16) DEFAULT 'pending_pay' NOT NULL,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_matter_expense_status" CHECK (status IN ('pending_pay','paid','void')),
	CONSTRAINT "ck_mn_matter_expense_amount" CHECK (amount >= 0)
);
--> statement-breakpoint

-- ③ 事项侧费用（同构的另一半）。
CREATE TABLE "mn_risk_matter_expense" (
	"id" bigint PRIMARY KEY NOT NULL,
	"risk_matter_id" bigint NOT NULL,
	"item_id" bigint NOT NULL,
	"amount" numeric(18,2) NOT NULL,
	"occurred_date" date NOT NULL,
	"status" varchar(16) DEFAULT 'pending_pay' NOT NULL,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_risk_matter_expense_status" CHECK (status IN ('pending_pay','paid','void')),
	CONSTRAINT "ck_mn_risk_matter_expense_amount" CHECK (amount >= 0)
);
--> statement-breakpoint

-- ④ 索引：宿主列表 / 合计走 `(宿主, 发生日期)`，按项目分组反查走 `item_id`。
--    partial（`NOT is_deleted`）与 `ix_mn_matter_progress_host` 同口径：列表恒带未删过滤。
CREATE INDEX "ix_mn_matter_expense_host" ON "mn_matter_expense" USING btree ("matter_id","occurred_date") WHERE NOT is_deleted;
--> statement-breakpoint
CREATE INDEX "ix_mn_matter_expense_item" ON "mn_matter_expense" USING btree ("item_id");
--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_expense_host" ON "mn_risk_matter_expense" USING btree ("risk_matter_id","occurred_date") WHERE NOT is_deleted;
--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_expense_item" ON "mn_risk_matter_expense" USING btree ("item_id");
--> statement-breakpoint

-- ⑤ 外键。宿主侧 RESTRICT（同 progress/node），配置侧 RESTRICT（被引用的项目不许删）。
ALTER TABLE "mn_matter_expense" ADD CONSTRAINT "mn_matter_expense_matter_id_mn_matter_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."mn_matter"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mn_matter_expense" ADD CONSTRAINT "mn_matter_expense_item_id_mn_expense_item_config_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."mn_expense_item_config"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mn_risk_matter_expense" ADD CONSTRAINT "mn_risk_matter_expense_risk_matter_id_mn_risk_matter_id_fk" FOREIGN KEY ("risk_matter_id") REFERENCES "public"."mn_risk_matter"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mn_risk_matter_expense" ADD CONSTRAINT "mn_risk_matter_expense_item_id_mn_expense_item_config_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."mn_expense_item_config"("id") ON DELETE restrict ON UPDATE no action;

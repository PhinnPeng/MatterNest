-- 自动化规则表（MATT-43 / T5b，结构依据 `docs/PRD-phase1-design-revision-r1.md` §2.1 + §2.3）
--
-- ## 为什么这一票要建这张表
--
-- 票面 AC 第一条是「规则 9 进 seed，触发域唯一性由 **DB 约束**保证」。
-- 而 `mn_automation_rule` 此前**只存在于文档里**：修订稿 §2.3 定了 9 条规则、§2.1 定了
-- `scope_key` 与 partial unique index，但没有任何一条迁移建过这张表
-- （`shared/enums/index.ts` 的 STRUCT_REGISTRY 从 T0 起就登记着
-- `automation_rule.trigger_type` / `action_type`，一直是"值域在代码里、表还没建"的状态）。
-- 所以"规则 9 进 seed"这件事的**前提**就是这条迁移。
--
-- ## 三条口径，写在这里免得被"简化"掉
--
-- 1. **唯一索引是 partial（`WHERE is_enabled`），不是普通唯一键。**
--    停用的规则不占位（§2.1 原话：「停用规则不占位，可随时回滚」）——
--    否则"停用规则 9、改好参数、再启用"这条路会被自己的旧行挡住。
-- 2. **作用域是 `(scope_key, action_type)`，不是 `(scope_key)`。**
--    同域**不同动作**天然允许并存（§2.1：`scope_key` 不含动作）。
--    合成一列会让"同一触发条件下既要归档又要通知"变成非法。
-- 3. **`trigger_config` / `action_config` 是 jsonb，值域靠服务层校验 + 单测**（枚举表 §4.4 的
--    8 条向量）。不给它们写 CHECK 不是偷懒：jsonb 内部的键集与取值域在 DDL 里表达不了，
--    而 E33（`trigger_config.event`）在注册表里的 `landing` 就是 `in-jsonb`——
--    这条登记与"DB 守不住"是同一件事的两种说法。
--
-- 规则引用 `code` 不引用 id（§2.4 末行）：seed 必须能跨环境逐字重放，
-- 所以 `code` 上有一条唯一约束，seed 的幂等也挂在它上面。
--
-- ⚠ `trigger_target_type` 的值域比 §2.1 那行**多一个 `all`**：§2.3 的规则 1/2/5/6/8
-- `host_type = 'all'`、触发实体写的是"宿主"，四值域表达不了"触发实体是两条宿主线"。
-- 理由与登记方式见 `src/shared/enums/automation.ts` 的 `TRIGGER_TARGET_TYPES`。
CREATE TABLE IF NOT EXISTS "mn_automation_rule" (
	"id" bigint PRIMARY KEY NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(100) NOT NULL,
	"host_type" varchar(16) NOT NULL,
	"trigger_type" varchar(24) NOT NULL,
	"trigger_target_type" varchar(24) NOT NULL,
	"trigger_config" jsonb DEFAULT '{}' NOT NULL,
	"extra_condition" jsonb,
	"action_type" varchar(24) NOT NULL,
	"action_config" jsonb DEFAULT '{}' NOT NULL,
	"scope_key" varchar(32) NOT NULL,
	"priority" integer DEFAULT 10 NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_automation_rule_host_type" CHECK (host_type IN ('all','matter','risk_matter')),
	CONSTRAINT "ck_mn_automation_rule_trigger_type" CHECK (trigger_type IN ('status_changed','time_no_progress','node_before_start','node_before_end','event_occurred')),
	CONSTRAINT "ck_mn_automation_rule_trigger_target" CHECK (trigger_target_type IN ('all','matter','risk_matter','matter_node','risk_matter_node')),
	CONSTRAINT "ck_mn_automation_rule_action_type" CHECK (action_type IN ('archive','notify','create_node','assign_staff','update_field')),
	CONSTRAINT "ck_mn_automation_rule_priority" CHECK (priority >= 0),
	CONSTRAINT "uk_mn_automation_rule_code" UNIQUE ("code"),
	CONSTRAINT "mn_automation_rule_created_by_mn_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
-- 触发域唯一性：同域同动作至多一条**启用**规则（§2.1）。这就是票面 AC 第一条要的那个约束。
-- 规则 4（`time_no_progress{days:30}` + notify）与规则 9（`{days:14,status_code:"closed"}` + notify）
-- 能同时在线，全靠这条索引按 `scope_key` 判定而不是按 `trigger_type`。
CREATE UNIQUE INDEX IF NOT EXISTS "ux_mn_automation_rule_enabled_action" ON "mn_automation_rule" USING btree ("scope_key","action_type") WHERE "is_enabled";

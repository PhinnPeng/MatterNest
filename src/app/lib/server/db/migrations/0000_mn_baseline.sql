CREATE TABLE "mn_status_config" (
	"id" bigint PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(50) NOT NULL,
	"color" varchar(20) NOT NULL,
	"host_type" varchar(16) NOT NULL,
	"semantics" varchar(24) DEFAULT 'custom' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_initial_status" boolean DEFAULT false NOT NULL,
	"next_status_codes" text[] DEFAULT '{}' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"is_archive_status" boolean GENERATED ALWAYS AS (semantics = 'archived') STORED,
	CONSTRAINT "ck_status_host_type" CHECK (host_type IN ('matter','risk_matter')),
	CONSTRAINT "ck_status_semantics" CHECK (semantics IN ('open','in_progress','closed','archived','custom'))
);
--> statement-breakpoint
CREATE TABLE "mn_app_user" (
	"id" bigint PRIMARY KEY NOT NULL,
	"username" varchar(64) NOT NULL,
	"display_name" varchar(50) NOT NULL,
	"password_hash" varchar(256),
	"is_enabled" boolean DEFAULT true NOT NULL,
	"activation_status" varchar(16) DEFAULT 'active' NOT NULL,
	"token_version" bigint DEFAULT 1 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_app_user_activation" CHECK (activation_status IN ('pending','active'))
);
--> statement-breakpoint
CREATE TABLE "mn_app_user_role" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"role_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mn_auth_session" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"auth_via" varchar(16) DEFAULT 'local' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mn_auth_session_auth_via" CHECK (auth_via IN ('local','yunzhijia'))
);
--> statement-breakpoint
CREATE TABLE "mn_role" (
	"id" bigint PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(50) NOT NULL,
	"data_scope" varchar(20) DEFAULT 'participating' NOT NULL,
	"can_unarchive" boolean DEFAULT false NOT NULL,
	"can_read_plain" boolean DEFAULT false NOT NULL,
	"can_manage_user" boolean DEFAULT false NOT NULL,
	"can_manage_config" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mn_role_data_scope" CHECK (data_scope IN ('all','participating','owned'))
);
--> statement-breakpoint
CREATE TABLE "mn_node_type_config" (
	"id" bigint PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(50) NOT NULL,
	"host_type" varchar(16) NOT NULL,
	"time_type" varchar(12) DEFAULT 'point' NOT NULL,
	"offset_days" integer DEFAULT 0 NOT NULL,
	"preset_on_create" boolean DEFAULT false NOT NULL,
	"default_remind_days" integer[] DEFAULT '{}' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_node_type_host" CHECK (host_type IN ('matter','risk_matter')),
	CONSTRAINT "ck_mn_node_type_time" CHECK (time_type IN ('point','range'))
);
--> statement-breakpoint
CREATE TABLE "mn_risk_level_config" (
	"id" bigint PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(50) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mn_tag" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"host_type" varchar(16) NOT NULL,
	"color" varchar(20) DEFAULT 'slate' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mn_tag_host" CHECK (host_type IN ('matter','risk_matter'))
);
--> statement-breakpoint
CREATE TABLE "mn_matter" (
	"id" bigint PRIMARY KEY NOT NULL,
	"internal_code" varchar(32) NOT NULL,
	"case_no" varchar(100) NOT NULL,
	"name" varchar(200) NOT NULL,
	"cause" varchar(200) NOT NULL,
	"case_type" varchar(24) NOT NULL,
	"procedure" varchar(28) NOT NULL,
	"litigation_role" varchar(28) NOT NULL,
	"court" varchar(200),
	"amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"level" varchar(32) NOT NULL,
	"tag_ids" bigint[] DEFAULT '{}' NOT NULL,
	"owner_id" bigint NOT NULL,
	"status" varchar(32) NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" bigint,
	"filing_date" date,
	"closing_date" date,
	"last_progress_at" timestamp with time zone,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_matter_case_type" CHECK (case_type IN ('civil_commercial','criminal','administrative','non_litigation')),
	CONSTRAINT "ck_mn_matter_procedure" CHECK (procedure IN ('first_instance','second_instance','retrial_review','retrial','arbitration','execution','execution_objection','bankruptcy','other')),
	CONSTRAINT "ck_mn_matter_role" CHECK (litigation_role IN ('plaintiff','defendant','third_party','applicant','respondent','appellant','appellee','petitioner','respondent_petition','executant','other')),
	CONSTRAINT "ck_mn_matter_amount" CHECK (amount >= 0),
	CONSTRAINT "ck_mn_matter_currency" CHECK (currency IN ('CNY'))
);
--> statement-breakpoint
CREATE TABLE "mn_matter_node" (
	"id" bigint PRIMARY KEY NOT NULL,
	"matter_id" bigint NOT NULL,
	"node_type_id" bigint NOT NULL,
	"name" varchar(128) NOT NULL,
	"time_type" varchar(12) DEFAULT 'point' NOT NULL,
	"start_time" timestamp with time zone,
	"end_time" timestamp with time zone,
	"is_time_confirmed" boolean DEFAULT false NOT NULL,
	"deadline_time" timestamp with time zone GENERATED ALWAYS AS (COALESCE(end_time, start_time)) STORED,
	"remind_days" integer[] DEFAULT '{7,3,1}' NOT NULL,
	"status" varchar(16) DEFAULT 'not_started' NOT NULL,
	"source_kind" varchar(12) DEFAULT 'manual' NOT NULL,
	"source_ref" varchar(64),
	"owner_id" bigint,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"remark" text,
	"completed_at" timestamp with time zone,
	"completed_by" bigint,
	"cancel_reason" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_matter_node_status" CHECK (status IN ('not_started','in_progress','completed','cancelled')),
	CONSTRAINT "ck_mn_matter_node_source_kind" CHECK (source_kind IN ('manual','preset','rule')),
	CONSTRAINT "ck_mn_matter_node_time_shape" CHECK ((time_type = 'range' AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time >= start_time)
            OR (time_type = 'point' AND end_time IS NULL)
            OR (start_time IS NULL AND end_time IS NULL)),
	CONSTRAINT "ck_mn_matter_node_cancel_reason" CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "mn_matter_party" (
	"id" bigint PRIMARY KEY NOT NULL,
	"matter_id" bigint NOT NULL,
	"party_id" bigint NOT NULL,
	"party_role" varchar(28) NOT NULL,
	"represented" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mn_matter_party_role" CHECK (party_role IN ('plaintiff','defendant','third_party','applicant','respondent','appellant','appellee','petitioner','respondent_petition','executant','other'))
);
--> statement-breakpoint
CREATE TABLE "mn_matter_progress" (
	"id" bigint PRIMARY KEY NOT NULL,
	"matter_id" bigint NOT NULL,
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
	CONSTRAINT "ck_mn_matter_progress_type" CHECK (progress_type IN ('routine','court_action','counterparty','client_feedback','internal_decision','material_filing'))
);
--> statement-breakpoint
CREATE TABLE "mn_matter_staff" (
	"id" bigint PRIMARY KEY NOT NULL,
	"matter_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"staff_role" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mn_matter_staff_role" CHECK (staff_role IN ('owner','co_owner','follower'))
);
--> statement-breakpoint
CREATE TABLE "mn_party" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"type" varchar(24) NOT NULL,
	"id_type" varchar(28),
	"id_number" varchar(64),
	"contact" varchar(100),
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_party_type" CHECK (type IN ('natural_person','legal_person','unincorporated_org')),
	CONSTRAINT "ck_mn_party_id_type" CHECK (id_type IS NULL OR id_type IN ('id_card','unified_social_credit','passport','hk_mo_tw_permit','military_id','foreign_residence','other'))
);
--> statement-breakpoint
CREATE TABLE "mn_risk_matter" (
	"id" bigint PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(200) NOT NULL,
	"type" varchar(28) NOT NULL,
	"level" varchar(32) NOT NULL,
	"source" varchar(28),
	"description" text NOT NULL,
	"measure" text,
	"amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"owner_id" bigint NOT NULL,
	"discover_date" date NOT NULL,
	"status" varchar(32) NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" bigint,
	"tag_ids" bigint[] DEFAULT '{}' NOT NULL,
	"conversion_status" integer DEFAULT 0 NOT NULL,
	"converted_at" timestamp with time zone,
	"converted_by" bigint,
	"converted_case_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_risk_matter_type" CHECK (type IN ('contract','labor_dispute','ip','corporate_governance','debt','compliance','litigation_derived','other')),
	CONSTRAINT "ck_mn_risk_matter_source" CHECK (source IS NULL OR source IN ('business_report','customer_complaint','lawyer_letter','internal_check','other')),
	CONSTRAINT "ck_mn_risk_matter_conversion" CHECK (conversion_status IN (0, 1)),
	CONSTRAINT "ck_mn_risk_matter_amount" CHECK (amount >= 0),
	CONSTRAINT "ck_mn_risk_matter_currency" CHECK (currency IN ('CNY'))
);
--> statement-breakpoint
CREATE TABLE "mn_risk_matter_case" (
	"id" bigint PRIMARY KEY NOT NULL,
	"risk_matter_id" bigint NOT NULL,
	"matter_id" bigint NOT NULL,
	"copied_fields" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mn_risk_matter_node" (
	"id" bigint PRIMARY KEY NOT NULL,
	"risk_matter_id" bigint NOT NULL,
	"node_type_id" bigint NOT NULL,
	"name" varchar(128) NOT NULL,
	"time_type" varchar(12) DEFAULT 'point' NOT NULL,
	"start_time" timestamp with time zone,
	"end_time" timestamp with time zone,
	"is_time_confirmed" boolean DEFAULT false NOT NULL,
	"deadline_time" timestamp with time zone GENERATED ALWAYS AS (COALESCE(end_time, start_time)) STORED,
	"remind_days" integer[] DEFAULT '{7,3,1}' NOT NULL,
	"status" varchar(16) DEFAULT 'not_started' NOT NULL,
	"source_kind" varchar(12) DEFAULT 'manual' NOT NULL,
	"source_ref" varchar(64),
	"owner_id" bigint,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"remark" text,
	"completed_at" timestamp with time zone,
	"completed_by" bigint,
	"cancel_reason" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_risk_matter_node_status" CHECK (status IN ('not_started','in_progress','completed','cancelled')),
	CONSTRAINT "ck_mn_risk_matter_node_source_kind" CHECK (source_kind IN ('manual','preset','rule')),
	CONSTRAINT "ck_mn_risk_matter_node_time_shape" CHECK ((time_type = 'range' AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time >= start_time)
            OR (time_type = 'point' AND end_time IS NULL)
            OR (start_time IS NULL AND end_time IS NULL)),
	CONSTRAINT "ck_mn_risk_matter_node_cancel_reason" CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "mn_risk_matter_party" (
	"id" bigint PRIMARY KEY NOT NULL,
	"risk_matter_id" bigint NOT NULL,
	"party_id" bigint NOT NULL,
	"party_role" varchar(28) NOT NULL,
	"represented" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mn_risk_matter_party_role" CHECK (party_role IN ('plaintiff','defendant','third_party','applicant','respondent','appellant','appellee','petitioner','respondent_petition','executant','other'))
);
--> statement-breakpoint
CREATE TABLE "mn_risk_matter_staff" (
	"id" bigint PRIMARY KEY NOT NULL,
	"risk_matter_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"staff_role" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mn_risk_matter_staff_role" CHECK (staff_role IN ('owner','co_owner','follower'))
);
--> statement-breakpoint
CREATE TABLE "mn_activity_log" (
	"id" bigint PRIMARY KEY NOT NULL,
	"target_type" varchar(24) NOT NULL,
	"target_id" bigint NOT NULL,
	"matter_id" bigint,
	"risk_matter_id" bigint,
	"operator_id" bigint NOT NULL,
	"action" varchar(40) NOT NULL,
	"field_diffs" jsonb,
	"payload" jsonb,
	"reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mn_activity_action" CHECK (action IN ('MATTER_CREATED','MATTER_UPDATED','MATTER_DELETED','RISK_CREATED','RISK_UPDATED','RISK_DELETED','NODE_CREATED','NODE_UPDATED','NODE_DELETED','PROGRESS_CREATED','PROGRESS_UPDATED','PROGRESS_DELETED','EXPENSE_CREATED','EXPENSE_UPDATED','EXPENSE_DELETED','PARTY_CREATED','PARTY_UPDATED','PARTY_DELETED','COMMENT_CREATED','COMMENT_UPDATED','COMMENT_DELETED','ATTACHMENT_UPLOADED','ATTACHMENT_DELETED','STATUS_CHANGED','ARCHIVED','UNARCHIVED','OWNER_CHANGED','CONVERTED_TO_CASE','UNCONVERT','NODE_COMPLETED','NODE_CANCELLED','STAFF_CHANGED','ROLE_CHANGED','USER_ACTIVATED','SENSITIVE_FIELD_READ','ACCESS_DENIED_WRITE','AUTO_RULE_EXECUTED','AUTO_RULE_SKIPPED','AUTO_RULE_FAILED','REMINDER_SENT','REMINDER_FAILED')),
	CONSTRAINT "ck_mn_activity_target_type" CHECK (target_type IN ('matter','risk_matter','matter_node','risk_matter_node','matter_progress','matter_expense')),
	CONSTRAINT "ck_mn_activity_host" CHECK (matter_id IS NOT NULL OR risk_matter_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "mn_code_seq" (
	"day_key" date NOT NULL,
	"prefix" varchar(8) NOT NULL,
	"value" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_mn_code_seq" PRIMARY KEY("day_key","prefix")
);
--> statement-breakpoint
CREATE TABLE "mn_comment" (
	"id" bigint PRIMARY KEY NOT NULL,
	"target_type" varchar(24) NOT NULL,
	"target_id" bigint NOT NULL,
	"parent_id" bigint,
	"body" text NOT NULL,
	"mention_ids" bigint[] DEFAULT '{}' NOT NULL,
	"author_id" bigint NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_mn_comment_target_type" CHECK (target_type IN ('matter','risk_matter','matter_node','risk_matter_node','matter_progress','matter_expense'))
);
--> statement-breakpoint
ALTER TABLE "mn_app_user_role" ADD CONSTRAINT "mn_app_user_role_user_id_mn_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mn_app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_app_user_role" ADD CONSTRAINT "mn_app_user_role_role_id_mn_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."mn_role"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_auth_session" ADD CONSTRAINT "mn_auth_session_user_id_mn_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mn_app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_matter" ADD CONSTRAINT "mn_matter_owner_id_mn_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_matter_node" ADD CONSTRAINT "mn_matter_node_matter_id_mn_matter_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."mn_matter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_matter_node" ADD CONSTRAINT "mn_matter_node_node_type_id_mn_node_type_config_id_fk" FOREIGN KEY ("node_type_id") REFERENCES "public"."mn_node_type_config"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_matter_node" ADD CONSTRAINT "mn_matter_node_owner_id_mn_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_matter_party" ADD CONSTRAINT "mn_matter_party_matter_id_mn_matter_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."mn_matter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_matter_party" ADD CONSTRAINT "mn_matter_party_party_id_mn_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."mn_party"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_matter_progress" ADD CONSTRAINT "mn_matter_progress_matter_id_mn_matter_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."mn_matter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_matter_progress" ADD CONSTRAINT "mn_matter_progress_node_id_mn_matter_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."mn_matter_node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_matter_progress" ADD CONSTRAINT "mn_matter_progress_author_id_mn_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_matter_staff" ADD CONSTRAINT "mn_matter_staff_matter_id_mn_matter_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."mn_matter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_matter_staff" ADD CONSTRAINT "mn_matter_staff_user_id_mn_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter" ADD CONSTRAINT "mn_risk_matter_owner_id_mn_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_case" ADD CONSTRAINT "mn_risk_matter_case_risk_matter_id_mn_risk_matter_id_fk" FOREIGN KEY ("risk_matter_id") REFERENCES "public"."mn_risk_matter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_case" ADD CONSTRAINT "mn_risk_matter_case_matter_id_mn_matter_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."mn_matter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_node" ADD CONSTRAINT "mn_risk_matter_node_risk_matter_id_mn_risk_matter_id_fk" FOREIGN KEY ("risk_matter_id") REFERENCES "public"."mn_risk_matter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_node" ADD CONSTRAINT "mn_risk_matter_node_node_type_id_mn_node_type_config_id_fk" FOREIGN KEY ("node_type_id") REFERENCES "public"."mn_node_type_config"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_node" ADD CONSTRAINT "mn_risk_matter_node_owner_id_mn_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_party" ADD CONSTRAINT "mn_risk_matter_party_risk_matter_id_mn_risk_matter_id_fk" FOREIGN KEY ("risk_matter_id") REFERENCES "public"."mn_risk_matter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_party" ADD CONSTRAINT "mn_risk_matter_party_party_id_mn_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."mn_party"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_staff" ADD CONSTRAINT "mn_risk_matter_staff_risk_matter_id_mn_risk_matter_id_fk" FOREIGN KEY ("risk_matter_id") REFERENCES "public"."mn_risk_matter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_risk_matter_staff" ADD CONSTRAINT "mn_risk_matter_staff_user_id_mn_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_activity_log" ADD CONSTRAINT "mn_activity_log_matter_id_mn_matter_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."mn_matter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_activity_log" ADD CONSTRAINT "mn_activity_log_risk_matter_id_mn_risk_matter_id_fk" FOREIGN KEY ("risk_matter_id") REFERENCES "public"."mn_risk_matter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_activity_log" ADD CONSTRAINT "mn_activity_log_operator_id_mn_app_user_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mn_comment" ADD CONSTRAINT "mn_comment_author_id_mn_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_status_initial" ON "mn_status_config" USING btree ("host_type") WHERE is_initial_status;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_status_archived" ON "mn_status_config" USING btree ("host_type") WHERE semantics = 'archived';--> statement-breakpoint
CREATE UNIQUE INDEX "ux_status_closed" ON "mn_status_config" USING btree ("host_type") WHERE semantics = 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "ux_status_code" ON "mn_status_config" USING btree ("host_type","code");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_app_user_username" ON "mn_app_user" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_app_user_role" ON "mn_app_user_role" USING btree ("user_id","role_id");--> statement-breakpoint
CREATE INDEX "ix_mn_app_user_role_user" ON "mn_app_user_role" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_auth_session_token" ON "mn_auth_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_mn_auth_session_user" ON "mn_auth_session" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_role_code" ON "mn_role" USING btree ("code");--> statement-breakpoint
CREATE INDEX "ix_mn_role_scope" ON "mn_role" USING btree ("data_scope");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_node_type_host_code" ON "mn_node_type_config" USING btree ("host_type","code");--> statement-breakpoint
CREATE INDEX "ix_mn_node_type_preset" ON "mn_node_type_config" USING btree ("host_type","preset_on_create","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_risk_level_code" ON "mn_risk_level_config" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_tag_host_name" ON "mn_tag" USING btree ("host_type","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_matter_internal_code" ON "mn_matter" USING btree ("internal_code");--> statement-breakpoint
CREATE INDEX "gin_mn_matter_tags" ON "mn_matter" USING gin ("tag_ids");--> statement-breakpoint
CREATE INDEX "ix_mn_matter_case_no" ON "mn_matter" USING btree ("case_no");--> statement-breakpoint
CREATE INDEX "ix_mn_matter_owner_list" ON "mn_matter" USING btree ("status","owner_id","updated_at") WHERE NOT is_deleted AND NOT is_archived;--> statement-breakpoint
CREATE INDEX "ix_mn_matter_recent" ON "mn_matter" USING btree ("updated_at","id") WHERE NOT is_deleted;--> statement-breakpoint
CREATE INDEX "ix_mn_matter_node_host" ON "mn_matter_node" USING btree ("matter_id","sort_order");--> statement-breakpoint
CREATE INDEX "ix_mn_matter_node_scan" ON "mn_matter_node" USING btree ("status","deadline_time") WHERE is_time_confirmed AND status IN ('not_started','in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_matter_party" ON "mn_matter_party" USING btree ("matter_id","party_id");--> statement-breakpoint
CREATE INDEX "ix_mn_matter_party_host" ON "mn_matter_party" USING btree ("matter_id","sort_order");--> statement-breakpoint
CREATE INDEX "ix_mn_matter_progress_host" ON "mn_matter_progress" USING btree ("matter_id","progress_date") WHERE NOT is_deleted;--> statement-breakpoint
CREATE INDEX "ix_mn_matter_progress_scan" ON "mn_matter_progress" USING btree ("matter_id","created_at") WHERE NOT is_deleted;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_matter_staff_triple" ON "mn_matter_staff" USING btree ("matter_id","user_id","staff_role");--> statement-breakpoint
CREATE INDEX "ix_mn_matter_staff_user" ON "mn_matter_staff" USING btree ("user_id","matter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_party_identity" ON "mn_party" USING btree ("type","id_number");--> statement-breakpoint
CREATE INDEX "ix_mn_party_name" ON "mn_party" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_risk_matter_code" ON "mn_risk_matter" USING btree ("code");--> statement-breakpoint
CREATE INDEX "gin_mn_risk_matter_tags" ON "mn_risk_matter" USING gin ("tag_ids");--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_owner_list" ON "mn_risk_matter" USING btree ("status","owner_id","updated_at") WHERE NOT is_deleted AND NOT is_archived;--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_recent" ON "mn_risk_matter" USING btree ("updated_at","id") WHERE NOT is_deleted;--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_risk_matter_case" ON "mn_risk_matter_case" USING btree ("risk_matter_id","matter_id");--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_case_matter" ON "mn_risk_matter_case" USING btree ("matter_id");--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_node_host" ON "mn_risk_matter_node" USING btree ("risk_matter_id","sort_order");--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_node_scan" ON "mn_risk_matter_node" USING btree ("status","deadline_time") WHERE is_time_confirmed AND status IN ('not_started','in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_risk_matter_party" ON "mn_risk_matter_party" USING btree ("risk_matter_id","party_id");--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_party_host" ON "mn_risk_matter_party" USING btree ("risk_matter_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_risk_matter_staff_triple" ON "mn_risk_matter_staff" USING btree ("risk_matter_id","user_id","staff_role");--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_staff_user" ON "mn_risk_matter_staff" USING btree ("user_id","risk_matter_id");--> statement-breakpoint
CREATE INDEX "ix_mn_activity_target" ON "mn_activity_log" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_mn_activity_operator" ON "mn_activity_log" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_mn_activity_matter" ON "mn_activity_log" USING btree ("matter_id");--> statement-breakpoint
CREATE INDEX "ix_mn_activity_risk_matter" ON "mn_activity_log" USING btree ("risk_matter_id");--> statement-breakpoint
CREATE INDEX "ix_mn_comment_target" ON "mn_comment" USING btree ("target_type","target_id","created_at") WHERE NOT is_deleted;--> statement-breakpoint
CREATE INDEX "ix_mn_comment_parent" ON "mn_comment" USING btree ("parent_id");
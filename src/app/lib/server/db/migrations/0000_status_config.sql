CREATE TABLE "status_config" (
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
CREATE UNIQUE INDEX "ux_status_initial" ON "status_config" USING btree ("host_type") WHERE is_initial_status;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_status_archived" ON "status_config" USING btree ("host_type") WHERE semantics = 'archived';--> statement-breakpoint
CREATE UNIQUE INDEX "ux_status_closed" ON "status_config" USING btree ("host_type") WHERE semantics = 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "ux_status_code" ON "status_config" USING btree ("host_type","code");
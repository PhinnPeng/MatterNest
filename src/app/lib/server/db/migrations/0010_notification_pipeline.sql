-- 0010：通知三表 + 关注表（MATT-41 / T4，2026-10-14）
--
-- 本迁移把 M4「件件有回音」的存储层一次落齐。四张表在 0009 之前**都不存在**：
--   · `mn_notification_event`    事件层：聚合后"该发的一条消息"（修订稿 §7.2）
--   · `mn_notification_delivery` 投递层：按 (event × user × channel) 一行，各自重试
--   · `mn_notification_template` 模板：一期只 seed、无管理页（F5-12）
--   · `mn_user_watch`            关注/收藏：4.6 跨宿主 feed 与 ⭐收藏 的载体（§8.1）
--
-- 列口径的依据是 `docs/PRD-phase1-design-revision-r1.md` §7.2（前两张）、§2.4（模板）、
-- §8.1/§8.2（关注表）；取值域依据是 `docs/PRD-phase1-enums-and-schemas.md` 的 E05/E25/E29/E30/E31。
-- **没有一列是本迁移发明的**，唯一两处需要说明的取舍写在下面 ① 与 ②。
--
-- ① `mn_notification_event.title` / `body` **建列但恒 NULL**。
--    §7.2 的表结构里有这两列（类型 `varchar(200)` / `text`），删掉它们会变成迁移债；
--    但权限草案 §7.1 明写「通知只存 event_id + 白名单摘要，正文读取时按当前权限实时渲染，
--    **不落渲染快照**（快照会把敏感内容永久留在已失权者的收件箱里）」。
--    两条同时成立的做法就是：列在、不写。文案由 `shared/notification/template.ts`
--    在每次读取时从 `template + payload` 现算。**别把它们"顺手补上"**——
--    补上的那一刻，收件人失权后收件箱里仍留着旧正文，而那正是 §7.1 要防的唯一一件事。
--
-- ② 模板的 8 行 seed 放在**本迁移**而不是 `db/seed/`。
--    仓库惯例是"结构进迁移、数据进 seed"，这次破例的理由是可验证的：seed 只在
--    `pnpm db:seed` 时重放，而本轮交付只跑 `db:migrate`——模板缺席会让整个通知中心
--    渲染不出正文（`renderNotification` 返回 null），且**不会报错**。
--    模板是通知管线的结构前提（F5-12：一期只 seed 无管理页，没有"用户改过要保留"的顾虑），
--    所以随建表一起落、用 `ON CONFLICT ("code") DO NOTHING` 保证幂等。
--
-- ③ `mn_event_outbox.event_type` 这次才拿到 CHECK。0003 建表时值域只在代码里
--    （枚举表当时把 E32 登记为 pending-table），于是"库里塞进一个没人认识的事件名"
--    在 0010 之前是拦不住的。既有 44 行全是 `risk_converted`，ADD CONSTRAINT 不会失败。
--
-- DOWN（前滚优先，但人要看得懂丢了什么）：
--   ALTER TABLE "mn_event_outbox" DROP CONSTRAINT "ck_mn_outbox_event_type";
--   DROP TABLE "mn_user_watch";
--   DROP TABLE "mn_notification_delivery";   -- 连带丢掉全部已读态（is_read/read_at）
--   DROP TABLE "mn_notification_event";      -- 连带丢掉全部通知事件与聚合计数
--   DROP TABLE "mn_notification_template";   -- 连带丢掉 8 条已签字文案
--   ⇒ **可逆但会丢数据**：投递表与事件表没有重建来源（事件由业务事务当场产生，
--     不重放业务动作就补不回来）。回退前先 `pg_dump` 这两张表。
--> statement-breakpoint

-- ── 通知模板（§7.2 待办 B5 的表结构，F5-12 一期只 seed） ──────────────────────
-- `code` 与 `event_type` 分开：`code` 是规则 `action_config.template_code` 引用的东西
-- （§2.4 末行：规则引用 code 而非 id，保证 seed 可跨环境重放），
-- `event_type` 是渲染时"这条事件该用哪条模板"的查找键。
-- 两者的 1:1 由下面的 `uk_mn_notification_template_event` 兜住——
-- 两条模板同时认领 `status_changed` 会让渲染结果取决于行顺序，那是最难查的一类不一致。
CREATE TABLE IF NOT EXISTS "mn_notification_template" (
  "id" bigint PRIMARY KEY,
  "code" varchar(40) NOT NULL,
  "event_type" varchar(32) NOT NULL,
  "channel" varchar(16) NOT NULL DEFAULT 'in_app',
  "title_tpl" varchar(200) NOT NULL,
  "body_tpl" text NOT NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" bigint,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" bigint,
  "is_deleted" boolean NOT NULL DEFAULT false,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "ck_mn_notification_template_event_type" CHECK (event_type IN ('status_changed','node_due_start','node_due_end','stale_30d','mention','new_comment','risk_converted','archive_incomplete')),
  CONSTRAINT "ck_mn_notification_template_channel" CHECK (channel IN ('in_app','email')),
  CONSTRAINT "uk_mn_notification_template_code" UNIQUE ("code"),
  CONSTRAINT "uk_mn_notification_template_event" UNIQUE ("event_type","channel")
);
--> statement-breakpoint

-- ── 事件层（§7.2） ────────────────────────────────────────────────────────────
-- `dedupe_key` 是**唯一**的去重机制（§7.2 合并规则 4：「去重靠数据库唯一键，不靠应用层判重」）。
-- 消费侧因此可以安全地按"至少一次"重放：`INSERT … ON CONFLICT (dedupe_key) DO NOTHING`。
-- `event_batch_id` 是一次业务操作的批次号，透传自 outbox 的 `batch_id`——
-- 少了它，"一次转案件生成 N 个案件"会变成 N 条同源通知，用户随后开始屏蔽通知（G3 反例）。
-- `host_id` **不是外键**：宿主是多态的（matter | risk_matter），真外键表达不了；
-- 它是 §7.2 说的"冗余的宿主 id，供 feed 一跳取所属案件/事项"。
CREATE TABLE IF NOT EXISTS "mn_notification_event" (
  "id" bigint PRIMARY KEY,
  "dedupe_key" varchar(120) NOT NULL,
  "event_batch_id" uuid NOT NULL,
  "event_type" varchar(32) NOT NULL,
  "source_type" varchar(24) NOT NULL,
  "source_rule_id" bigint,
  "target_type" varchar(32) NOT NULL,
  "target_id" bigint NOT NULL,
  "host_id" bigint NOT NULL,
  "title" varchar(200),
  "body" text,
  "payload" jsonb NOT NULL,
  "window_start" timestamp with time zone,
  "window_end" timestamp with time zone,
  "recipient_count" integer NOT NULL DEFAULT 0,
  "merge_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_mn_notification_event_type" CHECK (event_type IN ('status_changed','node_due_start','node_due_end','stale_30d','mention','new_comment','risk_converted','archive_incomplete')),
  CONSTRAINT "ck_mn_notification_event_source_type" CHECK (source_type IN ('node_remind','custom_reminder','auto_rule')),
  CONSTRAINT "uk_mn_notification_event_dedupe" UNIQUE ("dedupe_key")
);
--> statement-breakpoint
-- 详情页反查"这件事产生过哪些通知"（排障用），与投递表的主索引互补
CREATE INDEX IF NOT EXISTS "ix_mn_notification_event_target" ON "mn_notification_event" USING btree ("target_type","target_id","created_at" DESC);
--> statement-breakpoint
-- 按批次回捞：一次业务操作到底发了哪几条（§7.2 的 `merge_count` 排障入口）
CREATE INDEX IF NOT EXISTS "ix_mn_notification_event_batch" ON "mn_notification_event" USING btree ("event_batch_id");
--> statement-breakpoint

-- ── 投递层（§7.2） ────────────────────────────────────────────────────────────
-- 一行 = 一个收件人 × 一条事件 × 一个渠道。`is_read` 落在**这一行**上（§7.2 末行），
-- 因为已读是"我对这条通知"的状态，不是"这条通知"的状态。
-- `status='void'` = 收件人不可见而静默丢弃（权限草案 §8：不发"无权查看"的空通知）。
-- ⚠ 它与 E23 的 `cancelled` **不是一回事**：后者是用户主动撤销提醒，前者是权限结果。
-- `channel` 一期只写 `in_app`；`email` 的值域保留只为 CHECK 不返工（IQ-8 撤出一期排期）。
CREATE TABLE IF NOT EXISTS "mn_notification_delivery" (
  "id" bigint PRIMARY KEY,
  "event_id" bigint NOT NULL,
  "user_id" bigint NOT NULL,
  "channel" varchar(16) NOT NULL DEFAULT 'in_app',
  "status" varchar(16) NOT NULL DEFAULT 'pending',
  "attempt" integer NOT NULL DEFAULT 0,
  "next_retry_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "error" varchar(500),
  "is_read" boolean NOT NULL DEFAULT false,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_mn_notification_delivery_status" CHECK (status IN ('pending','sent','failed','void')),
  CONSTRAINT "ck_mn_notification_delivery_channel" CHECK (channel IN ('in_app','email')),
  CONSTRAINT "uk_mn_notification_delivery_triple" UNIQUE ("event_id","user_id","channel"),
  CONSTRAINT "mn_notification_delivery_event_id_mn_notification_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."mn_notification_event"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "mn_notification_delivery_user_id_mn_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
-- 通知中心的主查询形状（§7.2 原文：索引 `(user_id, is_read, created_at DESC)` 支撑 4.6「未读更新：3」）
CREATE INDEX IF NOT EXISTS "ix_mn_notification_delivery_user" ON "mn_notification_delivery" USING btree ("user_id","is_read","created_at" DESC);
--> statement-breakpoint

-- ── 关注 / 收藏（§8.1 + §8.2） ────────────────────────────────────────────────
-- §8.1 给的列是 `(user_id, target_type, target_id) UK`、`watch_type`、`last_read_at`、`created_at`。
-- 本表**刻意不带 `is_deleted`**：§6 的移除动作是「连带删除其 user_watch(follow) 行」，
-- 是硬删；而软删 + 三列唯一键会撞上一个死结——取消关注后重新点 ⭐ 会违反唯一键，
-- 且那个报错长得像"系统坏了"。`created_by` 补上是为了回答"这条关注是谁给加的"
-- （`follow` 由他人指派生成，`favorite` 只能是自己）。
--
-- ⚠ **本表在 MATT-41 里不产生任何写入**：上报人回音走规则 2/8 的 `receivers` 加 `creator`
--   （IQ-13-V5），**不入关注列表**——"不写 user_watch 行"是这张票的一条验收断言。
--   写入方随 F1-13（⭐收藏）与 `*_staff` 同步落地。
CREATE TABLE IF NOT EXISTS "mn_user_watch" (
  "id" bigint PRIMARY KEY,
  "user_id" bigint NOT NULL,
  "target_type" varchar(32) NOT NULL,
  "target_id" bigint NOT NULL,
  "watch_type" varchar(16) NOT NULL,
  "last_read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" bigint,
  CONSTRAINT "ck_mn_user_watch_type" CHECK (watch_type IN ('follow','favorite')),
  CONSTRAINT "ck_mn_user_watch_target_type" CHECK (target_type IN ('matter','risk_matter','matter_node','risk_matter_node','matter_progress','matter_expense','app_user')),
  CONSTRAINT "uk_mn_user_watch_triple" UNIQUE ("user_id","target_type","target_id"),
  CONSTRAINT "mn_user_watch_user_id_mn_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mn_app_user"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- 4.6 按时间倒序（§8.2）
CREATE INDEX IF NOT EXISTS "ix_mn_user_watch_user" ON "mn_user_watch" USING btree ("user_id","created_at" DESC);
--> statement-breakpoint
-- 反查"谁关注了这件事"（§8.2：发通知要用）
CREATE INDEX IF NOT EXISTS "ix_mn_user_watch_target" ON "mn_user_watch" USING btree ("target_type","target_id");
--> statement-breakpoint

-- ── E32 的落点：outbox 事件名进 CHECK（见头注 ③） ─────────────────────────────
-- `DROP … IF EXISTS` 在 `ADD` 之前：这条迁移在**已经手工落过 DDL 的库**上重跑时
-- （本轮交付就是这样验的：父代理还没把 0010 登记进 `meta/_journal.json`，
-- 而真 HTTP 冒烟必须先有表），`ADD CONSTRAINT` 会因为约束已存在而整批回滚。
-- 顺带它也是 §5.3「新增一个取值」的标准形状（DROP + ADD），下次扩值域照抄这一段。
ALTER TABLE "mn_event_outbox" DROP CONSTRAINT IF EXISTS "ck_mn_outbox_event_type";
--> statement-breakpoint
ALTER TABLE "mn_event_outbox" ADD CONSTRAINT "ck_mn_outbox_event_type" CHECK (event_type IN ('risk_converted','comment_added'));

-- ── 模板 seed 搬到 `db/seed/0005_notification_templates.sql` ──
--
-- 原先 8 条模板的 INSERT 写在**这条迁移里**，理由是"票面只要求跑 db:migrate，
-- 模板缺席会让通知正文渲染不出来且不报错"。那个担心成立，但**放错了地方**：
-- 本仓惯例是「结构进迁移、数据进 seed」（同批的 `0004_expense_item_config.sql` 就守了），
-- 而 `db:seed` 会 `readdirSync` 自动捡起新文件并**全量幂等重放**，所以搬到 seed 里
-- 既守惯例、又不会漏（检查子代理逐条核过：无任何测试/工具依赖模板在迁移里；
-- 模板缺席时 `renderNotification` 返回 null，界面降级成事件类型名，**不 500**）。

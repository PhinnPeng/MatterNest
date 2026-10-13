/**
 * 通知管线三表 + 关注表（迁移 0010，MATT-41 / T4）。
 *
 * 列口径的依据：`docs/PRD-phase1-design-revision-r1.md` §7.2（事件层 / 投递层 / 模板）、
 * §8.1 + §8.2（关注表）；取值域依据：`docs/PRD-phase1-enums-and-schemas.md` 的 E05/E25/E29/E30/E31。
 * 迁移文件与这里必须逐列一致（禁令④：迁移是唯一事实，本文件是给查询用的类型化视图）。
 *
 * ## 三条容易写错的语义，写在这里免得被"优化"掉
 *
 * 1. **`title` / `body` 恒 NULL。** 权限草案 §7.1 裁定「不落渲染快照」——
 *    正文在读取时由 `shared/notification/template.ts` 从 `template + payload` 现算。
 *    列保留是因为 §7.2 的表结构里有它们（删了是迁移债），但**没有写入方**。
 * 2. **`dedupe_key` 是唯一去重机制。** 消费侧按"至少一次"重放是正常路径，
 *    `ON CONFLICT (dedupe_key) DO NOTHING` 是它成立的唯一前提。
 * 3. **`host_id` 不是外键**（宿主多态：matter | risk_matter），它是 §7.2 说的
 *    "冗余的宿主 id，供 feed 一跳取所属案件/事项"。
 */
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  DELIVERY_STATUSES,
  NOTIFY_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_SOURCE_TYPES,
  OUTBOX_EVENT_TYPES,
} from "@/shared/enums/notify";
import { TARGET_TYPES, WATCH_TYPES } from "@/shared/enums/targets";
import { appUser } from "./identity";
import { auditColumns, createdOnlyColumns, fk, id } from "./common";
import { sqlInList } from "./ddl";

/**
 * `mn_notification_template`：通知文案模板。一期**只 seed、无管理页**（F5-12）。
 *
 * `code` 与 `event_type` 是两个不同的键：前者被规则 `action_config.template_code` 引用
 * （§2.4：规则引用 code 不引用 id，seed 才能跨环境重放），后者是渲染时的查找键。
 * 1:1 由 `uk_mn_notification_template_event` 兜住——两条模板同时认领一个 event_type
 * 会让渲染结果取决于行顺序。
 */
export const notificationTemplate = pgTable(
  "mn_notification_template",
  {
    id: id(),
    code: varchar("code", { length: 40 }).notNull(),
    eventType: varchar("event_type", { length: 32 }).notNull(),
    channel: varchar("channel", { length: 16 }).notNull().default("in_app"),
    titleTpl: varchar("title_tpl", { length: 200 }).notNull(),
    bodyTpl: text("body_tpl").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    check(
      "ck_mn_notification_template_event_type",
      sqlInList("event_type", NOTIFICATION_EVENT_TYPES),
    ),
    check("ck_mn_notification_template_channel", sqlInList("channel", NOTIFY_CHANNELS)),
    unique("uk_mn_notification_template_code").on(t.code),
    unique("uk_mn_notification_template_event").on(t.eventType, t.channel),
  ],
);

/**
 * `mn_notification_event`：事件层——聚合后"该发的一条消息"。
 *
 * `recipient_count` 与 `merge_count` 分开记：前者是"这条消息发给了几个人"，
 * 后者是"这条消息吸收掉了几条原始意图"（§7.2 排障用）。
 * 一次转案件生成 3 个案件时，`merge_count=3` 而 `recipient_count` 取决于收件人解析结果——
 * 把它们合成一个数，"聚合生效了没有"就再也答不上来。
 */
export const notificationEvent = pgTable(
  "mn_notification_event",
  {
    id: id(),
    dedupeKey: varchar("dedupe_key", { length: 120 }).notNull(),
    eventBatchId: uuid("event_batch_id").notNull(),
    eventType: varchar("event_type", { length: 32 }).notNull(),
    sourceType: varchar("source_type", { length: 24 }).notNull(),
    /** 排障回溯：这条通知是哪条规则发的 */
    sourceRuleId: fk("source_rule_id"),
    targetType: varchar("target_type", { length: 32 }).notNull(),
    targetId: fk("target_id").notNull(),
    /** 冗余宿主 id（**不是外键**，宿主多态），供 feed 一跳取所属案件/事项 */
    hostId: fk("host_id").notNull(),
    /** ⚠ 恒 NULL：§7.1 裁定不落渲染快照，正文读取时现算。见文件头第 1 条 */
    title: varchar("title", { length: 200 }),
    /** ⚠ 恒 NULL，同上 */
    body: text("body"),
    /** 结构化上下文（前端渲染 + 读取时渲染都用它）。§7.2：唯一保留 jsonb 的场景之一 */
    payload: jsonb("payload").notNull(),
    /** 聚合窗口；定时类为扫描批次边界 */
    windowStart: timestamp("window_start", { withTimezone: true, mode: "string" }),
    windowEnd: timestamp("window_end", { withTimezone: true, mode: "string" }),
    recipientCount: integer("recipient_count").notNull().default(0),
    mergeCount: integer("merge_count").notNull().default(0),
    ...createdOnlyColumns,
  },
  (t) => [
    check("ck_mn_notification_event_type", sqlInList("event_type", NOTIFICATION_EVENT_TYPES)),
    check(
      "ck_mn_notification_event_source_type",
      sqlInList("source_type", NOTIFICATION_SOURCE_TYPES),
    ),
    // 去重的唯一前提（§7.2 合并规则 4：靠数据库唯一键，不靠应用层判重）
    unique("uk_mn_notification_event_dedupe").on(t.dedupeKey),
    index("ix_mn_notification_event_target").on(t.targetType, t.targetId, t.createdAt.desc()),
    index("ix_mn_notification_event_batch").on(t.eventBatchId),
  ],
);

/**
 * `mn_notification_delivery`：投递层——按 (event × user × channel) 一行，各自重试。
 *
 * `is_read` 落在这一行上（§7.2 末行）：已读是"我对这条通知"的状态，不是"这条通知"的状态。
 * `status='void'` = 收件人不可见而静默丢弃（权限草案 §8），**与 E23 的 `cancelled` 不是一回事**：
 * 后者是用户主动撤销提醒，前者是权限结果——合成一套之后"没投递"与"被撤销"在排障时无法区分，
 * 而后者是安全事件线索。
 */
export const notificationDelivery = pgTable(
  "mn_notification_delivery",
  {
    id: id(),
    eventId: fk("event_id")
      .notNull()
      .references(() => notificationEvent.id, { onDelete: "cascade" }),
    userId: fk("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    channel: varchar("channel", { length: 16 }).notNull().default("in_app"),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: "string" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    error: varchar("error", { length: 500 }),
    isRead: boolean("is_read").notNull().default(false),
    readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("ck_mn_notification_delivery_status", sqlInList("status", DELIVERY_STATUSES)),
    check("ck_mn_notification_delivery_channel", sqlInList("channel", NOTIFY_CHANNELS)),
    // 同一事件对同一人同一渠道只该有一行——重放时它是第二道闸（第一道是 dedupe_key）
    unique("uk_mn_notification_delivery_triple").on(t.eventId, t.userId, t.channel),
    // 通知中心与未读计数的主查询形状（§7.2 原文）
    index("ix_mn_notification_delivery_user").on(t.userId, t.isRead, t.createdAt.desc()),
  ],
);

/**
 * `mn_user_watch`：关注（`follow`，由 `*_staff` 同步生成）与收藏（`favorite`，仅本人 ⭐）。
 *
 * **本表在 MATT-41 里没有写入方**，这不是漏了：IQ-13-V5 把"上报人回音"改道到规则 2/8 的
 * `receivers` 加 `creator`，**不入关注列表**——"关注保持主动 star 才算"的语义正是这条裁定的内容。
 * 写入方随 F1-13（⭐收藏）与 `*_staff` 同步落地。
 *
 * 刻意**不带 `is_deleted`**：§6 的移除动作是硬删（「连带删除其 `user_watch(follow)` 行」），
 * 而软删 + 三列唯一键会撞死结——取消关注后重新点 ⭐ 会违反唯一键，报错还长得像"系统坏了"。
 */
export const userWatch = pgTable(
  "mn_user_watch",
  {
    id: id(),
    userId: fk("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    targetType: varchar("target_type", { length: 32 }).notNull(),
    targetId: fk("target_id").notNull(),
    watchType: varchar("watch_type", { length: 16 }).notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true, mode: "string" }),
    ...createdOnlyColumns,
    /** 谁给加的这条关注：`follow` 由他人指派生成，`favorite` 只能是自己 */
    createdBy: fk("created_by"),
  },
  (t) => [
    check("ck_mn_user_watch_type", sqlInList("watch_type", WATCH_TYPES)),
    check("ck_mn_user_watch_target_type", sqlInList("target_type", TARGET_TYPES)),
    unique("uk_mn_user_watch_triple").on(t.userId, t.targetType, t.targetId),
    index("ix_mn_user_watch_user").on(t.userId, t.createdAt.desc()),
    index("ix_mn_user_watch_target").on(t.targetType, t.targetId),
  ],
);

/**
 * E32 的值域常量：写 outbox 行时引用它，而不是又抄一遍字面量。
 * 它的 CHECK 在迁移 0010 里补上（0003 建表时值域只在代码里）。
 */
export const OUTBOX_EVENT_TYPE_VALUES = OUTBOX_EVENT_TYPES;

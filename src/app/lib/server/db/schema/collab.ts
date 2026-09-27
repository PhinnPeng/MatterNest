/**
 * 协作与流水（W1-3 的切片）。
 * 出处：基线 1.7 评论 / 1.8 活动日志、修订稿 §6.3（评论 ≤1 层嵌套、日志补 `matter_id`/`risk_matter_id`
 *      双列 + `reason` 列）、§12.3（编号 `code_seq` 单语句原子取号）。
 *
 * 一期**故意不建**的三张（不是漏了）：`mn_attachment`（MinIO 服务账号未开通，接了没有可写目标）、
 * `mn_notification_event`/`mn_notification_delivery`（通知链路属 M5）、
 * `mn_user_watch`/`mn_custom_reminder`（提醒链路属 M5/M6）。
 * 判断依据：Demo 里点不到的入口不该占一张表。
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { AUDIT_ACTIONS } from "@/shared/enums/audit";
import { TARGET_TYPES } from "@/shared/enums/targets";
import { appUser } from "./identity";
import { matter, riskMatter } from "./hosts";
import { auditColumns, createdOnlyColumns, fk, id } from "./common";
import { sqlInList } from "./ddl";

/** `mn_comment`：横切评论，挂在两类宿主上（`target_type` + `target_id` 是多态，**只有这张表保留多态**） */
export const comment = pgTable(
  "mn_comment",
  {
    id: id(),
    targetType: varchar("target_type", { length: 24 }).notNull(),
    targetId: fk("target_id").notNull(),
    /** 最多 1 层嵌套（修订稿 §6.3）；父行存在性由服务层保证，DB 侧只加索引 */
    parentId: fk("parent_id"),
    body: text("body").notNull(),
    /** @提及的 user id 数组，通知链路将来靠它展开 */
    mentionIds: bigint("mention_ids", { mode: "bigint" })
      .array()
      .notNull()
      .default(sql`'{}'`),
    authorId: fk("author_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    isEdited: boolean("is_edited").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    index("ix_mn_comment_target")
      .on(t.targetType, t.targetId, t.createdAt)
      .where(sql`NOT is_deleted`),
    index("ix_mn_comment_parent").on(t.parentId),
    check("ck_mn_comment_target_type", sqlInList("target_type", TARGET_TYPES)),
  ],
);

/**
 * `mn_activity_log`：审计流水。
 * 三件事写在同一张表上，因为它们必须同时成立：
 *   · `action` 是闭集（E 表 §3，41 值，含补登的 `UNCONVERT`）⇒ 上 CHECK；
 *   · `field_diffs` 只存字段差异，规则执行等结构化载荷走 `payload`（§5.4 新增列）；
 *   · 跨宿主 feed 需要 `matter_id`/`risk_matter_id` **双列其一非空**（§6.3），否则"我的活动"要 JOIN 两次多态。
 */
export const activityLog = pgTable(
  "mn_activity_log",
  {
    id: id(),
    targetType: varchar("target_type", { length: 24 }).notNull(),
    targetId: fk("target_id").notNull(),
    matterId: fk("matter_id").references(() => matter.id, { onDelete: "restrict" }),
    riskMatterId: fk("risk_matter_id").references(() => riskMatter.id, { onDelete: "restrict" }),
    operatorId: fk("operator_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    action: varchar("action", { length: 40 }).notNull(),
    fieldDiffs: jsonb("field_diffs"),
    payload: jsonb("payload"),
    /** 偏离推荐路径、归档、撤销归档、取消节点时必填；哪条必填见 `@/shared/enums/audit` */
    reason: varchar("reason", { length: 500 }),
    /** 日志只追加：时间戳即"何时发生"，不需要 updated_by */
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ix_mn_activity_target").on(t.targetType, t.targetId, t.createdAt),
    index("ix_mn_activity_operator").on(t.operatorId, t.createdAt),
    index("ix_mn_activity_matter").on(t.matterId),
    index("ix_mn_activity_risk_matter").on(t.riskMatterId),
    check("ck_mn_activity_action", sqlInList("action", AUDIT_ACTIONS)),
    check("ck_mn_activity_target_type", sqlInList("target_type", TARGET_TYPES)),
    check("ck_mn_activity_host", sql`matter_id IS NOT NULL OR risk_matter_id IS NOT NULL`),
  ],
);

/**
 * `mn_code_seq`：编号发号器（修订稿 §12.3）。
 *
 * `day_key` 是**上海业务日**，写入必须是 `date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')::date`。
 * 为什么不能用 `current_date` / `now()::date`：会话已钉 UTC（`db:check` C4），
 * 那样上海 0–8 点立案会归到**前一天**——C6 用同一个跨零点时刻实测过两者相差一天。
 * 溢出 999 后扩成 4 位（`AJ-20261015-1000`），号可跳不可复。
 */
export const codeSeq = pgTable(
  "mn_code_seq",
  {
    dayKey: date("day_key").notNull(),
    prefix: varchar("prefix", { length: 8 }).notNull(),
    value: integer("value").notNull(),
    ...createdOnlyColumns,
  },
  (t) => [
    // 复合主键即取号的冲突目标：`INSERT … ON CONFLICT (day_key, prefix) DO UPDATE … RETURNING`
    primaryKey({ columns: [t.dayKey, t.prefix], name: "pk_mn_code_seq" }),
  ],
);

/** 取号用的前缀字面量：`AJ` 案件 / `FX` 事项（基线 1.1/1.2） */
export const CODE_PREFIX = { matter: "AJ", riskMatter: "FX" } as const;

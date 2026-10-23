/**
 * 协作与流水（W1-3 的切片）。
 * 出处：基线 1.7 评论 / 1.8 活动日志、修订稿 §6.3（评论 ≤1 层嵌套、日志补 `matter_id`/`risk_matter_id`
 *      双列 + `reason` 列）、§12.3（编号 `code_seq` 单语句原子取号）。
 *
 * 曾**故意不建**、后来按排期补齐的：`mn_attachment`（2026-10-22，MinIO 服务账号到位，
 * 见下面 `attachment` 的注）、`mn_notification_*` 与 `mn_user_watch`（M5，迁移 0010）。
 * 仍留待 M6：`mn_custom_reminder`（提醒链路）—— 判断依据不变：Demo 里点不到的入口不该占一张表。
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
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { AUDIT_ACTIONS } from "@/shared/enums/audit";
import { ATTACHMENT_CATEGORIES } from "@/shared/enums/business";
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
    // 评论只挂**业务对象**（案件 / 风险事项 / 节点 / 进展 / 费用），**不挂账号**。
    //
    // 值域与 `TARGET_TYPES` 同源但**刻意更窄**：MATT-10 给审计落点加了 `app_user`
    // （迁移 0006，账号开通与角色授予要落审计），而评论挂在账号上没有意义——
    // 让评论表为了"值数量相同"而收下账号，等于为一个没人用的能力放宽约束。
    // `enum-check` 的落点判定已改成子集语义，并另加一条"不得整体收窄"的反向守卫。
    check(
      "ck_mn_comment_target_type",
      sqlInList(
        "target_type",
        TARGET_TYPES.filter((t) => t !== "app_user"),
      ),
    ),
  ],
);

/**
 * `mn_attachment`：附件（修订稿 §7.1 / A7，2026-10-22 打通）。
 *
 * ## 为什么单表、不按宿主拆
 *
 * §7.1 原文：「附件属**横切基础设施**，按 §1.0.2 分界线保持单表管线，不按宿主拆表
 * （否则签名 URL 签发、病毒扫描、留存策略要各写一份）。」所以它跟 `mn_comment`
 * 一样是多态表，`owner_type + owner_id` 指向**宿主**（案件 / 事项）。
 *
 * ## `comment_id` —— 规格表里没有的一列，为什么必须有
 *
 * §1.7 要求 Comment 带 `attachment_ids [derived]`，也就是"这条评论发了哪些附件"。
 * 但 E03 `target_type` 是闭集且**没有 `comment`**（评论是明细，不是业务对象），
 * 于是"附件挂在评论上"无法只靠 `owner_type` 表达：
 *
 *   · 若把 `owner_type` 写成 `matter`，那就分不出这条附件属于哪条评论；
 *   · 若给 E03 加一个 `comment`，`mn_activity_log` 的 CHECK、`visibility()` 与
 *     `TARGET_TYPE_LABELS` 都要跟着开一个没有人用的口子。
 *
 * 折中是**加一列**：`owner_type/owner_id` 仍然指向宿主（可见性判定直接复用
 * `scopedWhere`），`comment_id` 才是评论那一条的归属。宿主删除时靠 RESTRICT
 * （宿主是软删的，硬删带附件的宿主本来就不该发生）。
 *
 * ## 字段口径（逐条照 §7.1，不加戏）
 *
 * | 规格 | 这里 | 说明 |
 * |---|---|---|
 * | `storage_key` | `storage_key` | **不可猜测、不含业务含义**（= 随机 UUID），`UNIQUE` |
 * | `mime_type` | `mime_type` | 服务端按扩展名白名单**自己定**，不信客户端声明 |
 * | `checksum_sha256` | `checksum_sha256` | 客户端直传算不出来，由浏览器算好随评论提交（事后异步校验属 §7.1 的下一票） |
 * | `category` | `category` | E26 闭集，可空（评论附件不需要分类）；归档就绪的「裁判文书」将来按 `judgment` 统计 |
 * | `related_node_id` | —— | 本期没有"节点材料"视图，不建空列（建了没人写＝假能力） |
 *
 * 软删：`is_deleted` + `deleted_at`/`deleted_by`。§7.1 明写「`is_deleted` 保留对象
 * 以便审计追溯，物理清理由 B 组定义」——所以删除只改行，不删对象存储里的字节。
 */
export const attachment = pgTable(
  "mn_attachment",
  {
    id: id(),
    ownerType: varchar("owner_type", { length: 24 }).notNull(),
    ownerId: fk("owner_id").notNull(),
    /** 评论附件才有值；§1.7 的 `attachment_ids [derived]` 由它反查 */
    commentId: fk("comment_id").references(() => comment.id, { onDelete: "restrict" }),
    /** 原始文件名，只用于展示与下载时的 `Content-Disposition` */
    fileName: varchar("file_name", { length: 255 }).notNull(),
    /** 对象键：`att/<uuid>`，不含宿主/人名/原名（§7.1 的要求） */
    storageKey: varchar("storage_key", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 128 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    /** 小写十六进制 SHA-256；用于完整性与将来的秒传去重 */
    checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
    category: varchar("category", { length: 24 }),
    uploadedBy: fk("uploaded_by")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
    deletedBy: fk("deleted_by").references(() => appUser.id, { onDelete: "restrict" }),
  },
  (t) => [
    unique("uk_mn_attachment_storage_key").on(t.storageKey),
    // 列表恒带 `NOT is_deleted`（与 ix_mn_comment_target 同口径的 partial index）
    index("ix_mn_attachment_owner")
      .on(t.ownerType, t.ownerId)
      .where(sql`NOT ${t.isDeleted}`),
    index("ix_mn_attachment_comment")
      .on(t.commentId)
      .where(sql`NOT ${t.isDeleted}`),
    // `app_user` 不进 OwnerType：账号没有附件（与评论表同一条理由，见上方 comment 的注）
    check(
      "ck_mn_attachment_owner_type",
      sqlInList(
        "owner_type",
        TARGET_TYPES.filter((t) => t !== "app_user"),
      ),
    ),
    check(
      "ck_mn_attachment_category",
      sql`category IS NULL OR ${sqlInList("category", ATTACHMENT_CATEGORIES)}`,
    ),
    check("ck_mn_attachment_size", sql`size_bytes > 0`),
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
    /**
     * 动作主体。**可空**（迁移 0016）—— NULL = 系统自动动作，没有人类主体。
     *
     * 规格出处：权限草案 §3 末行「系统内部身份（`operator = SYSTEM`）**不建 `app_user` 行**」。
     * 而 `NOT NULL + FK` 让规格那句话写不进去（MATT-72 阻塞 1），所以放开 NOT NULL。
     *
     * **FK 刻意保留**：人类主体的写入仍必须指向真实用户行；放开的只是「允许没有主体」。
     * 删掉 FK 会让拼错的 operator_id 静默落库，而审计恰恰是最不该有这种行的地方。
     *
     * 读侧为什么不必改逻辑：两处读取走的是**子查询**（`matters.ts:300` / `overview.ts:120`），
     * NULL 只让它返回 NULL，不改变行数、不破坏 join。详见迁移 0016 与
     * `docs/research-system-identity.md`（含 Kubernetes / AWS / OWASP 的一手证据）。
     */
    operatorId: fk("operator_id").references(() => appUser.id, { onDelete: "restrict" }),
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
    // 迁移 0006：账号维度是**唯一不挂业务宿主**的落点，所以这里为它开一个口子。
    // 写法是 `target_type='app_user'` 而不是「三个宿主列都空就放行」——后者会让一条
    // 填错落点、漏填宿主列的行悄悄合法，那正是这条约束当初要挡的。业务六条线没松。
    check(
      "ck_mn_activity_host",
      sql`matter_id IS NOT NULL OR risk_matter_id IS NOT NULL OR target_type = 'app_user'`,
    ),
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

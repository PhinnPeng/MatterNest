/**
 * 两张宿主表与它们的从属拆表（W1-1 / W1-2）。
 * 出处：基线 1.1/1.2/1.4 + 修订稿 §1.0.2（按宿主拆表、真外键、删掉 `matter_type` 多态列）、
 *      §6.1（节点列变更）、§6.3（补 `is_deleted`/`last_progress_at`/`conversion_status` 等）、
 *      §12.4（删除分级：宿主软删 + FK RESTRICT；从属明细随宿主 CASCADE）。
 *
 * 为什么从属表用工厂函数而不是复制两遍：规格里 `matter_*` 与 `risk_matter_*` 是**同构表对**，
 * 手写两份必然漂移；spec 的"两条 SQL 各扫自己表"要靠结构一致才成立。
 * 工厂同时把两张表放进**同一个迁移文件**（§12.2 末行的要求）。
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  date,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import {
  CASE_TYPES,
  CASE_TYPE_LABELS,
  CURRENCIES,
  ID_TYPES,
  LITIGATION_ROLES,
  NODE_SOURCE_KINDS,
  NODE_STATUSES,
  PARTY_TYPES,
  PROCEDURES,
  PROGRESS_TYPES,
  RISK_MATTER_SOURCES,
  RISK_MATTER_TYPES,
} from "@/shared/enums/business";
import { STAFF_ROLES, TARGET_TYPES } from "@/shared/enums/targets";
import { appUser } from "./identity";
import { auditColumns, createdOnlyColumns, fk, id } from "./common";
import { sqlInList } from "./ddl";

/** 同构表对里"宿主侧"的那一半标识 */
type HostKind = "matter" | "risk_matter";

/* ───────────────────────────── 宿主：案件 ───────────────────────────── */

export const matter = pgTable(
  "mn_matter",
  {
    id: id(),
    /** `AJ-YYYYMMDD-XXX`，由 `mn_code_seq` 单语句取号，不可编辑（基线 1.2 + 修订稿 §12.3） */
    internalCode: varchar("internal_code", { length: 32 }).notNull(),
    /** 正式案号：非唯一（不同法院可重号），保存时提示重复（修订稿 §6.3） */
    caseNo: varchar("case_no", { length: 100 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    cause: varchar("cause", { length: 200 }).notNull(),
    caseType: varchar("case_type", { length: 24 }).notNull(),
    procedure: varchar("procedure", { length: 28 }).notNull(),
    litigationRole: varchar("litigation_role", { length: 28 }).notNull(),
    court: varchar("court", { length: 200 }),
    /** 标的额；`numeric(18,2)`，禁 float（修订稿 §12.2） */
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull().default("0"),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    /** 风险等级：配置驱动（枚举表 §0），存 `mn_risk_level_config.code`，故**不加 CHECK** */
    level: varchar("level", { length: 32 }).notNull(),
    tagIds: bigint("tag_ids", { mode: "bigint" })
      .array()
      .notNull()
      .default(sql`'{}'`),
    ownerId: fk("owner_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    /** 状态存 code，指向 `mn_status_config.code`（应用层校验，跨配置表不建 FK） */
    status: varchar("status", { length: 32 }).notNull(),
    /** 归档位：由 `semantics='archived'` 的状态推导，列表默认隐藏靠它（§12.1 的 partial index 前缀） */
    isArchived: boolean("is_archived").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    archivedBy: fk("archived_by"),
    filingDate: date("filing_date"),
    closingDate: date("closing_date"),
    /** 规则 4「30 天无更新」的扫描基准（修订稿 §6.4） */
    lastProgressAt: timestamp("last_progress_at", { withTimezone: true, mode: "string" }),
    description: text("description"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("uk_mn_matter_internal_code").on(t.internalCode),
    // 数组列走 GIN（修订稿 §12.1）：标签筛选是列表页的常用入口
    index("gin_mn_matter_tags").using("gin", t.tagIds),
    index("ix_mn_matter_case_no").on(t.caseNo),
    // 列表恒带"未删 + 未归档"过滤 ⇒ partial index（§12.1、§8.2）
    index("ix_mn_matter_owner_list")
      .on(t.status, t.ownerId, t.updatedAt)
      .where(sql`NOT is_deleted AND NOT is_archived`),
    index("ix_mn_matter_recent")
      .on(t.updatedAt, t.id)
      .where(sql`NOT is_deleted`),
    check("ck_mn_matter_case_type", sqlInList("case_type", CASE_TYPES)),
    check("ck_mn_matter_procedure", sqlInList("procedure", PROCEDURES)),
    check("ck_mn_matter_role", sqlInList("litigation_role", LITIGATION_ROLES)),
    check("ck_mn_matter_amount", sql`amount >= 0`),
    check("ck_mn_matter_currency", sqlInList("currency", CURRENCIES)),
  ],
);

/* ───────────────────────────── 宿主：风险事项 ───────────────────────────── */

export const riskMatter = pgTable(
  "mn_risk_matter",
  {
    id: id(),
    /** `FX-YYYYMMDD-XXX` */
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    type: varchar("type", { length: 28 }).notNull(),
    level: varchar("level", { length: 32 }).notNull(),
    source: varchar("source", { length: 28 }),
    description: text("description").notNull(),
    measure: text("measure"),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull().default("0"),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    ownerId: fk("owner_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    /** 基线 1.1：发现日期用 `date` 而非 `timestamptz`（§12.2：日历日期跨时区会漂一天） */
    discoverDate: date("discover_date").notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    isArchived: boolean("is_archived").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
    archivedBy: fk("archived_by"),
    tagIds: bigint("tag_ids", { mode: "bigint" })
      .array()
      .notNull()
      .default(sql`'{}'`),
    /**
     * 修订稿 §3.4：**"已转案件"不占状态位**，是与结案正交的第二个事实，
     * 所以做成 smallint + 详情页第二个徽标。0=未转 1=已转（E28，非枚举语义）。
     */
    conversionStatus: smallintNotNull("conversion_status"),
    convertedAt: timestamp("converted_at", { withTimezone: true, mode: "string" }),
    convertedBy: fk("converted_by"),
    convertedCaseCount: integer("converted_case_count").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("uk_mn_risk_matter_code").on(t.code),
    index("gin_mn_risk_matter_tags").using("gin", t.tagIds),
    index("ix_mn_risk_matter_owner_list")
      .on(t.status, t.ownerId, t.updatedAt)
      .where(sql`NOT is_deleted AND NOT is_archived`),
    index("ix_mn_risk_matter_recent")
      .on(t.updatedAt, t.id)
      .where(sql`NOT is_deleted`),
    check("ck_mn_risk_matter_type", sqlInList("type", RISK_MATTER_TYPES)),
    // `source` 可空（E16），所以 CHECK 必须放过 NULL —— 否则"未填来源"的新建会被 DB 拒
    check(
      "ck_mn_risk_matter_source",
      sql`source IS NULL OR ${sqlInList("source", RISK_MATTER_SOURCES)}`,
    ),
    check("ck_mn_risk_matter_conversion", sql`conversion_status IN (0, 1)`),
    check("ck_mn_risk_matter_amount", sql`amount >= 0`),
    check("ck_mn_risk_matter_currency", sqlInList("currency", CURRENCIES)),
  ],
);

/* ─────────────────── 同构从属表：参与人 / 当事人 / 节点 / 进展 ─────────────────── */

/** 参与人：权限草案 §5 说 `*_staff` 是**权限主表**，`ix_staff_user` 是权限必需索引 */
function staffTable(host: HostKind) {
  const col = host === "matter" ? "matter_id" : "risk_matter_id";
  const parent = host === "matter" ? matter.id : riskMatter.id;
  return pgTable(
    `mn_${host}_staff`,
    {
      id: id(),
      hostId: fk(col)
        .notNull()
        .references(() => parent, { onDelete: "cascade" }),
      userId: fk("user_id")
        .notNull()
        .references(() => appUser.id, { onDelete: "restrict" }),
      /** E04：owner 承办 / co_owner 协办 / follower 关注，除 owner 外可多行 */
      staffRole: varchar("staff_role", { length: 16 }).notNull(),
      ...createdOnlyColumns,
    },
    (t) => [
      uniqueIndex(`uk_mn_${host}_staff_triple`).on(t.hostId, t.userId, t.staffRole),
      // 反向索引：L2 谓词 `EXISTS (… WHERE s.user_id = :me)` 就靠它
      index(`ix_mn_${host}_staff_user`).on(t.userId, t.hostId),
      check(`ck_mn_${host}_staff_role`, sqlInList("staff_role", STAFF_ROLES)),
    ],
  );
}

/** 当事人：库表 `mn_party` + 宿主关联（修订稿 A6 拆表，角色挂在关联行上） */
function partyLinkTable(host: HostKind) {
  const col = host === "matter" ? "matter_id" : "risk_matter_id";
  const parent = host === "matter" ? matter.id : riskMatter.id;
  return pgTable(
    `mn_${host}_party`,
    {
      id: id(),
      hostId: fk(col)
        .notNull()
        .references(() => parent, { onDelete: "cascade" }),
      partyId: fk("party_id")
        .notNull()
        .references(() => party.id, { onDelete: "restrict" }),
      /** E06 复用 E12 诉讼地位取值 */
      partyRole: varchar("party_role", { length: 28 }).notNull(),
      /** E07：是否我方代理，与角色**正交**（同一案件可有多个 represented=true，角色各异） */
      represented: boolean("represented").notNull().default(false),
      sortOrder: integer("sort_order").notNull().default(0),
      ...createdOnlyColumns,
    },
    (t) => [
      uniqueIndex(`uk_mn_${host}_party`).on(t.hostId, t.partyId),
      index(`ix_mn_${host}_party_host`).on(t.hostId, t.sortOrder),
      check(`ck_mn_${host}_party_role`, sqlInList("party_role", LITIGATION_ROLES)),
    ],
  );
}

/** 节点：修订稿 §6.1 的列变更 + 生成列 + partial index（同构两张） */
function nodeTable(host: HostKind) {
  const col = host === "matter" ? "matter_id" : "risk_matter_id";
  const parent = host === "matter" ? matter.id : riskMatter.id;
  return pgTable(
    `mn_${host}_node`,
    {
      id: id(),
      hostId: fk(col)
        .notNull()
        .references(() => parent, { onDelete: "restrict" }),
      /** 真外键到节点类型配置（原多态 `matter_type` 列已删，§1.0.2） */
      nodeTypeId: fk("node_type_id")
        .notNull()
        .references(() => nodeTypeRef, { onDelete: "restrict" }),
      name: varchar("name", { length: 128 }).notNull(),
      /** E11：时间点/段决定 `end_time` 的必填性，由下面的 CHECK 守住 */
      timeType: varchar("time_type", { length: 12 }).notNull().default("point"),
      startTime: timestamp("start_time", { withTimezone: true, mode: "string" }),
      endTime: timestamp("end_time", { withTimezone: true, mode: "string" }),
      isTimeConfirmed: boolean("is_time_confirmed").notNull().default(false),
      /**
       * 生成列：`COALESCE(end_time, start_time)`（§6.1）。
       * 禁令③：pg 侧没有 `.stored()`，写 `generatedAlwaysAs(sql\`…\`)` 即 STORED；
       * 生成列不进 PK/FK/unique，也不进索引（提醒扫描用下面的 partial index 走 deadline_time 是可以的，
       * 但**不能把它当 unique**）。
       */
      deadlineTime: timestamp("deadline_time", {
        withTimezone: true,
        mode: "string",
      }).generatedAlwaysAs(sql`COALESCE(end_time, start_time)`),
      /** 提醒的唯一入口（A8/A9 后无第二处），扫描器直接 unnest */
      remindDays: integer("remind_days")
        .array()
        .notNull()
        .default(sql`'{7,3,1}'`),
      /** E21 生命周期 */
      status: varchar("status", { length: 16 }).notNull().default("not_started"),
      /** E22：manual / preset(P1) / rule(P2)，路径由 source_ref 区分 */
      sourceKind: varchar("source_kind", { length: 12 }).notNull().default("manual"),
      sourceRef: varchar("source_ref", { length: 64 }),
      ownerId: fk("owner_id").references(() => appUser.id, { onDelete: "restrict" }),
      sortOrder: integer("sort_order").notNull().default(0),
      remark: text("remark"),
      completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
      completedBy: fk("completed_by"),
      cancelReason: varchar("cancel_reason", { length: 200 }),
      ...auditColumns,
    },
    (t) => [
      index(`ix_mn_${host}_node_host`).on(t.hostId, t.sortOrder),
      // 提醒扫描：跨宿主按期限全局扫（§6.1 的 ix_node_scan）
      index(`ix_mn_${host}_node_scan`)
        .on(t.status, t.deadlineTime)
        .where(sql`is_time_confirmed AND status IN ('not_started','in_progress')`),
      check(`ck_mn_${host}_node_status`, sqlInList("status", NODE_STATUSES)),
      check(`ck_mn_${host}_node_source_kind`, sqlInList("source_kind", NODE_SOURCE_KINDS)),
      check(
        `ck_mn_${host}_node_time_shape`,
        sql`(time_type = 'range' AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time >= start_time)
            OR (time_type = 'point' AND end_time IS NULL)
            OR (start_time IS NULL AND end_time IS NULL)`,
      ),
      check(
        `ck_mn_${host}_node_cancel_reason`,
        sql`status <> 'cancelled' OR cancel_reason IS NOT NULL`,
      ),
    ],
  );
}

/** 案件进展：基线 1.5，一期**案件专属**（§6.3 明写不给事项加进展表） */
export const matterProgress = pgTable(
  "mn_matter_progress",
  {
    id: id(),
    matterId: fk("matter_id")
      .notNull()
      .references(() => matter.id, { onDelete: "restrict" }),
    nodeId: fk("node_id").references(() => matterNode.id, { onDelete: "restrict" }),
    /** E19 闭集 */
    progressType: varchar("progress_type", { length: 24 }).notNull(),
    content: text("content").notNull(),
    /** 日历日期：进展发生日，用 `date` 而非 `timestamptz`（§12.2） */
    progressDate: date("progress_date").notNull(),
    nextPlan: text("next_plan"),
    authorId: fk("author_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    ...auditColumns,
  },
  (t) => [
    index("ix_mn_matter_progress_host")
      .on(t.matterId, t.progressDate)
      .where(sql`NOT is_deleted`),
    index("ix_mn_matter_progress_scan")
      .on(t.matterId, t.createdAt)
      .where(sql`NOT is_deleted`),
    check("ck_mn_matter_progress_type", sqlInList("progress_type", PROGRESS_TYPES)),
  ],
);

/** 当事人库（基线 模块八）：与宿主多对多，角色挂在关联行上 */
export const party = pgTable(
  "mn_party",
  {
    id: id(),
    name: varchar("name", { length: 200 }).notNull(),
    /** E17：决定 E18 与 `id_number` 的校验规则 */
    type: varchar("type", { length: 24 }).notNull(),
    idType: varchar("id_type", { length: 28 }),
    idNumber: varchar("id_number", { length: 64 }),
    contact: varchar("contact", { length: 100 }),
    remark: text("remark"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("uk_mn_party_identity").on(t.type, t.idNumber),
    index("ix_mn_party_name").on(t.name),
    check("ck_mn_party_type", sqlInList("type", PARTY_TYPES)),
    // `id_type` 选填，故放过 NULL（与 risk_matter.source 同一写法）
    check("ck_mn_party_id_type", sql`id_type IS NULL OR ${sqlInList("id_type", ID_TYPES)}`),
  ],
);

/** 转案件关联：修订稿 §3.4 —— 事项的"来源案件"靠这张表反查，不在宿主上留 `source_risk_id` */
export const riskMatterCase = pgTable(
  "mn_risk_matter_case",
  {
    id: id(),
    riskMatterId: fk("risk_matter_id")
      .notNull()
      .references(() => riskMatter.id, { onDelete: "cascade" }),
    matterId: fk("matter_id")
      .notNull()
      .references(() => matter.id, { onDelete: "restrict" }),
    copiedFields: text("copied_fields"),
    ...createdOnlyColumns,
  },
  (t) => [
    uniqueIndex("uk_mn_risk_matter_case").on(t.riskMatterId, t.matterId),
    index("ix_mn_risk_matter_case_matter").on(t.matterId),
  ],
);

/* 工厂产出的四对同构表：显式命名，供仓储层与 seed 引用 */
export const matterStaff = staffTable("matter");
export const riskMatterStaff = staffTable("risk_matter");
export const matterParty = partyLinkTable("matter");
export const riskMatterParty = partyLinkTable("risk_matter");
export const matterNode = nodeTable("matter");
export const riskMatterNode = nodeTable("risk_matter");

/** 宿主类型 → E03 `target_type` 的前缀，供 activity_log 与附件定位 */
export const HOST_TARGET_PREFIX: Record<HostKind, string> = {
  matter: "matter",
  risk_matter: "risk_matter",
};

/** 编译期防漏：宿主集合与 E03 的两个宿主值一致 */
const hostKinds: HostKind[] = ["matter", "risk_matter"];
export const HOST_KINDS = hostKinds;
export { TARGET_TYPES };

/** 小工具：smallint 语义的 0/1 列（drizzle 的 smallint 与 bigint 同 mode 约束） */
function smallintNotNull(name: string) {
  return integer(name).notNull().default(0);
}

/** 节点类型配置的外键目标（在 `config.ts` 里定义；此处用变量延迟，避免成环 import） */
import { nodeTypeConfig } from "./config";
const nodeTypeRef = nodeTypeConfig.id;

export type MatterRow = typeof matter.$inferSelect;
export type RiskMatterRow = typeof riskMatter.$inferSelect;
export type MatterNodeRow = typeof matterNode.$inferSelect;
export { CASE_TYPE_LABELS };

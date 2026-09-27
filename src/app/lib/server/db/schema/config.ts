/**
 * 5 张配置表里的 3 张（状态配置在 `status-config.ts`，另两张是 `mn_risk_level_config` / `mn_tag`）。
 * 出处：枚举表 §0「配置驱动清单」——状态、节点类型、费用项目、风险等级、标签；
 *      修订稿 §4（节点生成两条互斥路径）、§6.3。
 *
 * 费用项目配置（`mn_expense_item_config`）**一期不建**：Demo 切片里没有费用录入入口，
 * 建了会多一套没人用的 CRUD + 权限。需要时按同构写法补，不改动本文件其余部分。
 */
import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { HOST_TYPES } from "@/shared/enums";
import { TIME_TYPES } from "@/shared/enums/business";
import { auditColumns, createdOnlyColumns, id } from "./common";
import { check } from "drizzle-orm/pg-core";
import { sqlInList } from "./ddl";

/** `mn_node_type_config`：节点类型 + P1 预设顺序（修订稿 §4 的 P1 路径靠 `preset_on_create`） */
export const nodeTypeConfig = pgTable(
  "mn_node_type_config",
  {
    id: id(),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 50 }).notNull(),
    /** E10：与 `mn_status_config.host_type` 同值域，单实现见 `@/shared/enums` */
    hostType: varchar("host_type", { length: 16 }).notNull(),
    /** E11：时间点 / 时间段（决定 `end_time` 的必填性） */
    timeType: varchar("time_type", { length: 12 }).notNull().default("point"),
    /** 距基准日的偏移天数（立案 0 / 举证 7 / 开庭 21 / 判决 30 之类） */
    offsetDays: integer("offset_days").notNull().default(0),
    /** P1：宿主创建时是否自动实例化为本宿主的默认节点（修订稿 §4） */
    presetOnCreate: boolean("preset_on_create").notNull().default(false),
    /** 节点提醒的默认提前天数，如 `{7,3,1}` */
    defaultRemindDays: integer("default_remind_days")
      .array()
      .notNull()
      .default(sql`'{}'`),
    sortOrder: integer("sort_order").notNull().default(0),
    isSystem: boolean("is_system").notNull().default(false),
    isEnabled: boolean("is_enabled").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("uk_mn_node_type_host_code").on(t.hostType, t.code),
    index("ix_mn_node_type_preset").on(t.hostType, t.presetOnCreate, t.sortOrder),
    check("ck_mn_node_type_host", sqlInList("host_type", HOST_TYPES)),
    check("ck_mn_node_type_time", sqlInList("time_type", TIME_TYPES)),
  ],
);

/** `mn_risk_level_config`：风险等级（枚举表 §0 明定它是配置驱动，**不是** E 表枚举，所以不加 CHECK） */
export const riskLevelConfig = pgTable(
  "mn_risk_level_config",
  {
    id: id(),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 50 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isSystem: boolean("is_system").notNull().default(false),
    isEnabled: boolean("is_enabled").notNull().default(true),
    ...createdOnlyColumns,
  },
  (t) => [uniqueIndex("uk_mn_risk_level_code").on(t.code)],
);

/** `mn_tag`：标签（横切，宿主两类共用一张，靠 `host_type` 分列） */
export const tag = pgTable(
  "mn_tag",
  {
    id: id(),
    name: varchar("name", { length: 50 }).notNull(),
    hostType: varchar("host_type", { length: 16 }).notNull(),
    color: varchar("color", { length: 20 }).notNull().default("slate"),
    sortOrder: integer("sort_order").notNull().default(0),
    isSystem: boolean("is_system").notNull().default(false),
    isEnabled: boolean("is_enabled").notNull().default(true),
    ...createdOnlyColumns,
  },
  (t) => [
    uniqueIndex("uk_mn_tag_host_name").on(t.hostType, t.name),
    check("ck_mn_tag_host", sqlInList("host_type", HOST_TYPES)),
  ],
);

/** 宿主 ↔ 标签：两张宿主表都用 `tag_ids bigint[]` + GIN（修订稿 §12.1），故不建中间表 */

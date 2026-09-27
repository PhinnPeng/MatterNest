import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { HOST_TYPES, STATUS_SEMANTICS } from "@/shared/enums/status";

/**
 * `status_config` —— 状态配置表（修订稿 §3.1 替换原文 1.12）。
 *
 * 选它当**第一条真迁移**的理由：这张表把本项目最难的四类 DB 构造一次占全 ——
 * partial unique（三个条件唯一索引）、生成列（`is_archive_status`）、表级 CHECK（两个枚举列值域）、
 * 数组列（`next_status_codes`）；而它又不依赖任何宿主表，可以在 W1-1 之前独立落地。
 *
 * 三条禁令在这里的落点：
 *   禁令② —— 所有 `.where()` 只用 `sql` 模板。实测 `eq()`/`and()` 会生成
 *            `WHERE "is_enabled" = $1`，PG 直接 `there is no parameter $1`（见研究文档 §8）。
 *   禁令③ —— `is_archive_status` 是 STORED 生成列：PG 只支持 STORED，且它不进任何索引/约束。
 *   禁令④ —— 本文件改动后只能 `pnpm db:generate` + 人审 SQL，禁止 `push`。
 *
 * 值域与 `src/shared/enums/status.ts` 由 `status.spec.ts` 逐字对齐（E08/E09 单一事实源）。
 */
import { sqlInList } from "./ddl";

export const statusConfig = pgTable(
  "mn_status_config",
  {
    /** 雪花 id，应用侧生成（修订稿 §12.2）；DB 不设 IDENTITY */
    id: bigint("id", { mode: "number" }).primaryKey(),
    /** 语义标识：seed 与规则引用它，创建后不可改 */
    code: varchar("code", { length: 32 }).notNull(),
    /** 展示名：可改 */
    name: varchar("name", { length: 50 }).notNull(),
    color: varchar("color", { length: 20 }).notNull(),
    hostType: varchar("host_type", { length: 16 }).notNull(),
    /** API 层保存时必填，新建只能给 custom；DB 默认值只为 seed 与手写 SQL 兜底 */
    semantics: varchar("semantics", { length: 24 }).notNull().default("custom"),
    /** true = seed 内置：可改名/改色/排序，不可删 */
    isSystem: boolean("is_system").notNull().default(false),
    isInitialStatus: boolean("is_initial_status").notNull().default(false),
    /** 推荐后继；空 = 不限制（修订稿 §3.1） */
    nextStatusCodes: text("next_status_codes")
      .array()
      .notNull()
      .default(sql`'{}'`),
    sortOrder: integer("sort_order").notNull().default(0),
    /** 停用后不可人工选择，但历史数据保留 */
    isEnabled: boolean("is_enabled").notNull().default(true),
    /** 由 semantics 推导的只读生成列（禁令③ 的写法：没有 `.stored()`，PG 侧就是 STORED） */
    isArchiveStatus: boolean("is_archive_status").generatedAlwaysAs(sql`semantics = 'archived'`),
  },
  (t) => [
    // 修订稿 §3.1：每宿主恰好一个初始态 / 恰好一个归档态 / 至多一个结案态
    uniqueIndex("ux_status_initial")
      .on(t.hostType)
      .where(sql`is_initial_status`),
    uniqueIndex("ux_status_archived")
      .on(t.hostType)
      .where(sql`semantics = 'archived'`),
    uniqueIndex("ux_status_closed")
      .on(t.hostType)
      .where(sql`semantics = 'closed'`),
    // code 的唯一性按宿主成立：matter 与 risk_matter 各有一套同名 code（§3.2 八行 seed）
    uniqueIndex("ux_status_code").on(t.hostType, t.code),
    check("ck_status_host_type", sqlInList("host_type", HOST_TYPES)),
    check("ck_status_semantics", sqlInList("semantics", STATUS_SEMANTICS)),
  ],
);

export type StatusConfigRow = typeof statusConfig.$inferSelect;
export type StatusConfigInsert = typeof statusConfig.$inferInsert;

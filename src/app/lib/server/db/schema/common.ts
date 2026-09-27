import { bigint, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * 表命名与公共列（一期口径：**全部 `mn_` 前缀**，2026-09-27 裁定，见 master §7 P1-15/P1-20）。
 *
 * 裁定后怎么处理已应用的 `0000_status_config`：**M0 一次性重基线**（2026-09-27）。
 * 试过正路 —— 让 generate 出 diff 再把 `DROP+CREATE` 手改成 `ALTER TABLE … RENAME`，
 * 但 drizzle-kit 0.31.10 在"疑似重命名"这一步必弹交互确认，且硬性要求 TTY
 * （`bin.cjs:1449` 无 TTY 直接 reject），本环境拿不到。
 * 于是按"这张库的真实暴露面"判断：`dev_matternest` 只有本地一处、表内只有 8 行可重放 seed、
 * 无任何外部消费者 ⇒ 重基线代价为零，而"库里留一张不带头典的表"代价会长留。
 * **边界写清楚**：一旦有第二个环境用过这些迁移，本条立即失效，只能走 `RENAME` 迁移；
 * 届时要么在有 TTY 的终端跑 generate，要么用 `drizzle-kit generate --custom` 起手再人审。
 *
 * 公共列按修订稿 §6.3 与 §12.4：时间列一律 `timestamptz`（会话已钉 UTC），
 * 业务表带 `is_deleted`/`deleted_at`（软删，FK 一律 RESTRICT）；从属明细不软删，随宿主 CASCADE。
 */

/**
 * 64 位主键与所有外键的唯一写法：`mode: "bigint"`。
 *
 * 三条理由都不是风格：
 *   · 修订稿 §12.2 的 id 是 64 位雪花，`number` 超出 JS 安全整数上界 2^53-1 会**静默丢精度**；
 *   · `drizzle-orm@0.45.3` 的 `bigint` 只接受 `number | bigint` 两种 mode —— 我本轮先写成了
 *     `"string"`，是 `tsc` 拒掉的（vitest 那边全绿），所以这里留一行注记；
 *   · 对外要 string 的诉求（master P1-19）在 **DTO 边界**用 `String(id)` 完成，
 *     服务层与 SQL 里始终是 BigInt；实测 postgres.js 把 `int8` 读成 JS string（`db:check` C7b），
 *     所以读路径本就不丢精度，会丢的是"拿 number 去写"。
 *
 * 外键由调用方写 `.references(() => 表.id)`（drizzle 取 thunk）；引用方向不许成环：
 * `hosts.ts` 引 `identity.ts`，反过来不引。
 */
export const id = (name = "id") => bigint(name, { mode: "bigint" }).primaryKey();
/** 外键 / 软引用列，与 `id()` 同型，避免出现第二种 id 类型 */
export const fk = (name: string) => bigint(name, { mode: "bigint" });

/** 业务表公共列：软删 + 审计时间戳 */
export const auditColumns = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  createdBy: fk("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedBy: fk("updated_by"),
  isDeleted: boolean("is_deleted").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
};

/** 只给"不软删"的配置/明细表用 */
export const createdOnlyColumns = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
};

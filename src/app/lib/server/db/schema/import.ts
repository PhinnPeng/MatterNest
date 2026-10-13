import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { IMPORT_BATCH_STATUSES, IMPORT_KINDS, IMPORT_ROW_STATUSES } from "@/shared/enums/import";
import { createdOnlyColumns, fk, id } from "./common";
import { sqlInList } from "./ddl";

/**
 * 批量导入的两张表（F7-4 / M7 US-M7-1 / MATT-44，迁移 0013）。
 *
 * ## 为什么需要落库（而不是"导入完把结果返回给浏览器就完了"）
 *
 * 三条都是票面 AC 直接要求的，各自指向一个**必须能被事后读到**的事实：
 *   1. `BULK_IMPORT` 汇总日志的 `payload.report_ref`（枚举表 §3.5）要指向一份**还能下载的**
 *      错误报告 —— 报告不能在响应里就地蒸发；
 *   2. **同文件重导不产生重复行**要求知道"哪些内容已经导过"，而那是跨请求的事实；
 *   3. **逐行跳过**要求"哪一行为什么没进"能逐行回查，而不是一句"导入了 812 行"。
 *
 * ## 两张表的分工
 *
 * · `mn_import_batch` —— 一次导入**一条**。计数与状态在这里，`BULK_IMPORT` 的载荷与它同源。
 * · `mn_import_row`   —— 文件里的**每一行**一条（含成功行）。报告只读 `skipped` 那批，
 *   而成功行也要留，因为**幂等键挂在它们身上**（见下面那条 partial unique index）。
 *
 * ## 不软删
 *
 * 两张都用 `createdOnlyColumns`（只有 `created_at`）：导入记录是**审计物**，
 * 与 `mn_activity_log` 同级 —— 它们没有"编辑"语义，软删只会让"这批到底导过没"
 * 变成一个带条件的查询。删除走运维（真删），不走业务入口。
 */

/**
 * `mn_import_batch`：一次导入一条。
 *
 * ⚠ **列名 `host_type` 是继承来的**：枚举表 §3.5 给 `BULK_IMPORT` 定的载荷键就叫
 * `host_type`，而那是事后审计的查询契约（"所有导入"要能一条 SQL 捞出来），
 * 不该为了措辞改键名。代价是值域 `IMPORT_KINDS` 比 `HOST_TYPES`（E08/E10）多一个
 * `party` —— 当事人档案**没有宿主**（`mn_party` 是跨宿主共享实体，F3-1）。
 * 列名与值域的这一处错位写在这里，免得下一个人以为 `party` 是漏登记的宿主类型。
 */
export const importBatch = pgTable(
  "mn_import_batch",
  {
    id: id(),
    /** `IMPORT_KINDS` 三值。列名见上 */
    hostType: varchar("host_type", { length: 16 }).notNull(),
    /** 上传时的文件名，只用于人读（报告标题、批次列表） */
    fileName: varchar("file_name", { length: 200 }).notNull(),
    /** 文件里的**数据行数**（不含表头、说明行与空行）。三条计数必须满足 total = imported + error */
    totalRows: integer("total_rows").notNull().default(0),
    importedRows: integer("imported_rows").notNull().default(0),
    /** **未导入**的行数：校验失败 + 内容重复（与 §3.5 载荷的 `error_rows` 同义） */
    errorRows: integer("error_rows").notNull().default(0),
    /**
     * `running` = **崩溃留下的痕迹**，不是正常中间态：正常一轮在同一个事务里
     * 把计数与状态一起收尾。留着它是因为"上次这个文件没跑完"必须能从库里读出来 ——
     * 那种批次没有 `BULK_IMPORT` 汇总（汇总在收尾事务里写），只有这条记录能解释
     * 为什么库里有半批数据，以及为什么重导会跳过其中一部分。
     */
    status: varchar("status", { length: 16 }).notNull().default("running"),
    /** 导入操作人。**不建外键**：与 `mn_activity_log.operator_id` 同口径（审计物不指人） */
    createdBy: fk("created_by"),
    ...createdOnlyColumns,
  },
  (t) => [
    check("ck_mn_import_batch_host", sqlInList("host_type", IMPORT_KINDS)),
    check("ck_mn_import_batch_status", sqlInList("status", IMPORT_BATCH_STATUSES)),
    /** 批次列表按时间倒序（原型与报告入口都用它） */
    index("ix_mn_import_batch_recent").on(t.createdAt, t.id),
  ],
);

/**
 * `mn_import_row`：文件里每一行一条。
 *
 * `hostId` **故意不建外键**：它按 `host_type` 指向三张不同的表（案件/事项/当事人），
 * 多态外键在 PG 里只能靠触发器或三列可空外键表达，而这张表的价值是"这一行进了哪条记录"，
 * 不是引用完整性 —— 记录被软删（业务表只软删）之后这条痕迹仍应留着。
 */
export const importRow = pgTable(
  "mn_import_row",
  {
    id: id(),
    batchId: fk("batch_id")
      .notNull()
      .references(() => importBatch.id, { onDelete: "cascade" }),
    /** 冗余自批次：下面那条 partial unique 要在**跨批次**范围内唯一，必须有这一列 */
    hostType: varchar("host_type", { length: 16 }).notNull(),
    /** **逻辑行号**（从 1 起，表头是第 1 行）。用户在 Excel 里看到的行号 */
    rowNo: integer("row_no").notNull(),
    /**
     * 内容键（`sha256(host_type + 规范化后的落库入参)`），**只有 `imported` 的行有值**。
     *
     * 幂等重放的判定就挂在这一列上：见下面那条 partial unique index。
     * 未导入的行**不占键** —— 否则"把错行改对再传一次"会撞上自己上一轮的错误记录。
     */
    rowHash: varchar("row_hash", { length: 64 }),
    status: varchar("status", { length: 16 }).notNull(),
    /** 成功导入时新建记录的 id（报告里能让用户点过去） */
    hostId: bigint("host_id", { mode: "bigint" }),
    /** 未导入时的原因清单：`[{field, code, message}]`。**不含单元格原值**（见下） */
    issues: jsonb("issues"),
    ...createdOnlyColumns,
  },
  (t) => [
    check("ck_mn_import_row_status", sqlInList("status", IMPORT_ROW_STATUSES)),
    index("ix_mn_import_row_batch").on(t.batchId, t.rowNo),
    /**
     * **幂等重放的硬保证**：同一个 `host_type` 下，内容相同的行**不可能**被导入两次。
     *
     * 为什么不是"服务层先查后插"：查与插之间有窗口，并发（用户双击提交、两个标签页）
     * 时两边都能查到"没有"然后各插一条。唯一索引把这件事交给 DB —— 冲突那一条
     * 会被服务层 catch 成"已导入"并进报告，不是 500。
     *
     * partial（只索引 `imported`）的理由见 `rowHash` 列注。
     * `.where()` 只用 `sql` 模板：禁令②（`eq()` 在 DDL 位置产出非法 `$1`）。
     */
    uniqueIndex("uk_mn_import_row_content")
      .on(t.hostType, t.rowHash)
      .where(sql`status = 'imported'`),
  ],
);

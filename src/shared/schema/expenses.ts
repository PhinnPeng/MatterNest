import { z } from "zod";
import { EXPENSE_STATUSES } from "@/shared/enums/business";

/**
 * 费用与导出的 DTO（US-41 / US-42）。
 *
 * 落在这里而不是 route 里，是本仓的一条硬口径（技术选型 §4）：**校验的唯一真源在
 * `src/shared/`**，路由只负责把它挂到 HTTP 上。前端表单、服务层与路由因此共用同一份规则
 * —— 各写一份的失败形态是"前端说没问题、服务端 400"，而两边看起来都对。
 */

/** 数据库 `bigint` 对外只有 string 一种形态（master P1-19：雪花 id 进 `number` 会静默丢低位） */
const idField = (label: string) => z.string().regex(/^\d+$/, `${label}必须是数字字符串`);

/**
 * 金额。**全程字符串**，禁 float（修订稿 §12.2）。
 *
 * 两条边界都来自列定义 `numeric(18,2)`：
 *   · 小数最多两位 —— 多给一位就是让数据库替我们四舍五入，而"我填了 1.005、存进去 1.01"
 *     这种事不该发生在一个记账功能里；
 *   · 整数最多 16 位（18 − 2）—— 不设这一条，超界的值会一路走到 PG 才报
 *     `numeric field overflow`，那是一条 500，用户看到的是"服务器错误"而不是"金额太大"。
 *
 * 为什么不用 `z.coerce.number()`：`Number("0.10")` 之后 `String()` 回不去 `"0.10"`
 * （`0.1`），而导出与合计都要求"两位小数"这个**刻度**本身是事实的一部分。
 */
export const expenseAmountField = z
  .string()
  .trim()
  .regex(/^\d{1,16}(\.\d{1,2})?$/, "金额最多两位小数，整数部分最多 16 位（列是 numeric(18,2)）");

/** 发生日期：日历日期，`date` 列（§12.2：用 `timestamptz` 会跨时区漂一天） */
export const expenseDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "发生日期格式为 YYYY-MM-DD");

/**
 * 新建费用。**只记支出**（US-41：企业场景下没有"当事人付我方费用"这一侧），
 * 所以没有"收/支"方向字段 —— 加一个恒为"支出"的字段是给二期留一个没人读的位。
 *
 * 字段与基线 4.6 逐条对应：费用项目 / 金额 / 发生日期 / 状态 / 备注。
 * （附件那一条本票不落列：`mn_attachment` 一期未建，见迁移 0011 的说明。）
 */
export const expenseCreateSchema = z
  .object({
    /** 费用项目：真外键到 `mn_expense_item_config`，服务层再验一次"存在且启用" */
    itemId: idField("费用项目"),
    amount: expenseAmountField,
    occurredDate: expenseDateField,
    /** E20 三值，**不含 `approved`**（第一期无审批流）。省略时用列默认 `pending_pay` */
    status: z.enum(EXPENSE_STATUSES).optional(),
    remark: z.string().trim().max(2000).optional().or(z.literal("")),
  })
  // `.strict()`：zod 默认**静默剥离**未声明字段，于是 `item_id`（下划线写法）会被无声丢掉，
  // 用户看到的是"我填了项目，存进去是空的"。显式拒才能让它在联调时就红。
  .strict();
export type ExpenseCreateInput = z.infer<typeof expenseCreateSchema>;

/**
 * 编辑费用：与新建同一套值域，字段全选填（改哪个传哪个）。
 *
 * 不复用 `expenseCreateSchema.partial()`：那样 `itemId` 的"必须存在且启用"这条
 * 在编辑路径上就没有对应的必填语义可依，而"改金额"与"改项目"是两件事。
 * 值域仍然同源（`expenseAmountField` / `expenseDateField` / E20 枚举都是同一份引用）。
 */
export const expenseUpdateSchema = z
  .object({
    itemId: idField("费用项目").optional(),
    amount: expenseAmountField.optional(),
    occurredDate: expenseDateField.optional(),
    status: z.enum(EXPENSE_STATUSES).optional(),
    remark: z.string().trim().max(2000).optional().or(z.literal("")),
  })
  .strict();
export type ExpenseUpdateInput = z.infer<typeof expenseUpdateSchema>;

/**
 * `?plain=1|true` → 明文档。
 *
 * 当事人导出（`parties.ts` 的 `partyExportQuerySchema`）与整卷导出共用**这一个**解析：
 * 两处各写一遍的失败形态是"一处认 `1`、另一处只认 `true`"，而用户看到的是
 * "同一个按钮在两个页面行为不同"。
 */
export const plainExportField = z
  .enum(["1", "true", "0", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");

/** 整卷导出（`GET /api/matters/{id}/export` 与事项侧同构）的查询串 */
export const hostExportQuerySchema = z.object({ plain: plainExportField });
export type HostExportQuery = z.infer<typeof hostExportQuerySchema>;

import { z } from "zod";

/**
 * 列表查询参数的**唯一**定义（禁令⑧：校验规则单源；枚举表 §5.1）。
 *
 * 客户端与服务端 parse 同一份：客户端拦是体验，服务端拦才是防线。
 * `pageSize` 的上限 100 是禁令⑧ 的硬约束——**理由不是性能而是权限**：
 * 客户端全量拉取再本地筛，等于绕过 `ScopeResolver`（权限草案 §4）。
 *
 * N7 spike 用它来回答"上限到底该由谁拦"这个问题（见任务 design.md 选择 2）。
 */
export const MAX_PAGE_SIZE = 100 as const;
export const DEFAULT_PAGE_SIZE = 20 as const;

/**
 * 可排序列。用枚举而不是自由字符串，否则 `sortBy` 会变成注入面。
 * 这份清单与服务层 `SORTABLE` 映射**逐字相等**（那边写成 `Record<本类型, SQL>`，
 * 少一个键编译期就红）——之前 `risk_level`/`owner_name` 在这里、不在映射里，
 * 结果是那两种排序静默退回 `updated_at`：DTO 说得出、服务层做不到，是最难发现的一类缺陷。
 */
export const SORTABLE_COLUMNS = [
  "code",
  "name",
  "status",
  "risk_level",
  "owner_name",
  "amount",
  "created_at",
  "updated_at",
] as const;

/**
 * 可筛选的状态：四个内置 code 就是 seed 里 `mn_status_config.code` 的取值。
 * 与 `status` 列的 CHECK 由 `enum-check.spec.ts` 保证同源，所以这里能收成枚举。
 * `archived` 仍在值域里（它是一个合法 code），但**在办列表的前端不再提供这一项**——
 * 归档由独立的归档视图承接，见下面 `archivedOnly`。
 */
export const FILTERABLE_STATUSES = ["pending", "in_progress", "closed", "archived"] as const;

/**
 * 归档视图开关（**二态**，取代旧的 `includeArchived`）。
 *
 * 旧语义是"在办里混进归档"：默认 `NOT is_archived`，勾上就不加谓词。它有两个问题——
 * 混着看时 `is_archived` 这个 partial index 前缀用不上（修订稿 §12.1），
 * 而且列表里"这条还要不要跟"分不出来（归档是终态）。
 * 所以改成二选一：`false`（默认）= 在办列表，`true` = 归档视图。
 *
 * 取值四个都收（`1/true/0/false`）再自己转，**不用** `z.coerce.boolean()`：
 * 后者是 `Boolean("false") === true`，会把"退出归档视图"静默变成"一直看归档"。
 * 裸 `yes/no` 仍然拒绝 —— 手打的参数写错该红。
 *
 * 单独导出是给事项列表那份 schema 复用：两张宿主的状态值域来源不同（一个可 enum、一个配置驱动），
 * 所以两份 schema 不能整个合，但这个开关的语义必须一模一样。
 */
export const archivedOnlyField = z
  .enum(["1", "true", "0", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sortBy: z.enum(SORTABLE_COLUMNS).default("updated_at"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  status: z.enum(FILTERABLE_STATUSES).optional(),
  keyword: z.string().trim().min(1).max(60).optional(),
  archivedOnly: archivedOnlyField,
});

export type ListQuery = z.infer<typeof listQuerySchema>;

/** 列表响应的固定形状（`type-safety.md`：不要有的接口返数组有的返对象）。 */
export const listResultSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
    total: z.number().int().min(0),
  });

/** URL 搜索参数 → schema 入参对象（Route Handler 与客户端共用，避免两边各写一遍取参逻辑）。 */
export function searchParamsToRecord(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of sp.entries()) out[k] = v;
  return out;
}

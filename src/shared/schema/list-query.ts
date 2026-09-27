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

/** 可排序列。用枚举而不是自由字符串，否则 `sortBy` 会变成注入面。 */
export const SORTABLE_COLUMNS = [
  "code",
  "name",
  "status",
  "risk_level",
  "owner_name",
  "amount",
  "updated_at",
] as const;

export const FILTERABLE_STATUSES = ["pending", "in_progress", "closed", "archived"] as const;

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sortBy: z.enum(SORTABLE_COLUMNS).default("updated_at"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  status: z.enum(FILTERABLE_STATUSES).optional(),
  keyword: z.string().trim().min(1).max(60).optional(),
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

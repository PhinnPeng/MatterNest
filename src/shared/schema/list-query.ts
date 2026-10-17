import { z } from "zod";
import { plainExportField } from "./expenses";

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

/**
 * 「只看**未指派处理人**的事项」（T1）。
 *
 * 用 `optional()` + `undefined` 而不是 `false`：三态（不限 / 只看空 / 只看有）
 * 挤进一个布尔会丢掉中间态——"有经办人的"本就是默认，不需要单独一档。
 *
 * ⚠ 只有**持 L1 数据范围**的角色用得上。参与经办以下看不到未指派的事项
 * （它不在"我经办 ∪ 我协办 ∪ 我被关注 ∪ 我创建的"里），那个筛选对他们恒为空——
 * 这是权限的正常结果，不是筛选出错。**只暴露这个参数，不为它改可见性。**
 */
export const ownerEmptyField = z
  .enum(["1", "true"])
  .optional()
  .transform((v) => v === "1" || v === "true");

/**
 * 「已结案缺材料」（F2-26 / G4 的运维视角出口）。
 *
 * 与案件详情页的「归档就绪」卡是**同一条判定的两个读出口**——判定本身住在
 * `services/archive-readiness.ts`（一个逐项状态函数 + 一条 SQL 谓词，相邻摆放），
 * 这里只负责把开关传下去，不在这里重算一遍。
 *
 * ⚠ 只对**已归档**的案件有意义：未归档的缺材料不是问题，是"还在办"。
 * 谓词里已经带了 `is_archived = true`，所以这个开关天然与「已归档」视图配套。
 */
export const missingMaterialsField = z
  .enum(["1", "true"])
  .optional()
  .transform((v) => v === "1" || v === "true");

/**
 * 状态筛选字段（**配置驱动**那一份）。事项列表与报表两卡用它。
 *
 * 与 `listQuerySchema.status`（四值枚举）不是两套口径，而是**值域来源不同**：
 * 案件列表那四个值恰好就是 seed 里的内置 code，所以收得成枚举；事项的状态是
 * `mn_status_config.code`，运营可以新增（枚举表 §0），收枚举就等于"运营加一个状态、
 * 列表能筛而卡片 400"。
 *
 * 报表两卡跨两个宿主，所以只能取两者的**并集**——也就是这一份宽松的。
 */
export const configStatusField = z.string().trim().max(32);

/**
 * 报表两卡吃的列表筛选（F8-1「随筛选联动」）。**这是分类，不是第二套筛选定义**：
 * 键名、取值、URL 语义全部沿用列表那一套，这里只说"哪几个进报表"。
 *
 * 进：`status` / `ownerEmpty` / `archivedOnly` —— 三者都是**集合的范围**：
 * 它们回答"这一堆行是哪些行"，而卡片画的正是这一堆行的分布。
 *
 * 与 `REPORT_OMITTED_KEYS` 合起来必须是列表状态的一个**划分**：客户端
 * （`use-list-state.spec.ts`）与服务端 schema（`services/reports.spec.ts`）各有一条
 * 结构性断言盯着它——"界面点了没反应"（筛选没进请求）与"筛选被静默丢掉"
 * （服务端 zod 默认剥掉不认识的键）都在这两条断言的射程里。
 */
export const REPORT_FILTER_KEYS = ["status", "ownerEmpty", "archivedOnly"] as const;

/**
 * 明确**不进**报表的列表键，每个都带一句理由（理由要写下来，否则下一个人会以为是漏了）。
 *
 *  · `keyword` —— 它是"找某一条"（案号/名称/案由的模糊命中），不是"看哪一片"。
 *    让它进报表，卡片会在输入一个词之后塌成一行、每格 1，分布读数当场失效；
 *    而"我搜出来的这条在全局里占多少"并不是这两张卡要回答的问题。
 *  · `page` / `pageSize` —— 分页是**视口**，不是集合的属性：同一批行翻到第 2 页，
 *    集合没变，卡片变数字就是错的。
 *  · `sortBy` / `sortDir` —— 排序改的是行的次序，不是行本身；点一下表头卡片就变数
 *    会让人以为卡片坏了。
 *  · `missingMaterials` —— F2-26 的运维视角出口，只对**已归档**案件成立，而它唯一的宿主页
 *    是 `/archive`；两张卡挂在 P4/P7（P0-2 裁定），所以这个键没有进来的场合。
 */
export const REPORT_OMITTED_KEYS = [
  "keyword",
  "page",
  "pageSize",
  "sortBy",
  "sortDir",
  "missingMaterials",
] as const;

/* ───────────────── 列表的筛选面：列表 / 它导出的那一份 两处同源 ───────────────── */

/**
 * 排序字段。抽出来是给**列表与它的导出**共用（MATT-64）：两处的默认值与白名单必须是
 * 同一个对象，否则"列表按更新倒序、导出按编号正序"这种不一致不会报错，只会让人以为导错了。
 */
export const sortByField = z.enum(SORTABLE_COLUMNS).default("updated_at");
export const sortDirField = z.enum(["asc", "desc"]).default("desc");

/**
 * 案件列表的筛选字段（`listQuerySchema` 与 `matterListExportQuerySchema` **spread 同一批对象**）。
 *
 * 为什么是"同一批对象"而不是"照抄一份值域"：`status` 的四值枚举、`keyword` 的长度上限、
 * 两个开关的三态语义各写一遍，某天一处改了另一处不改 ⇒ 列表能筛的组合导出认不出来（400），
 * 或者更糟：参数被 zod 静默剥掉、导出的是**没筛过**的全量，而两边都 200。
 */
export const matterListFilters = {
  status: z.enum(FILTERABLE_STATUSES).optional(),
  keyword: z.string().trim().min(1).max(60).optional(),
  archivedOnly: archivedOnlyField,
  /**
   * 「已结案缺材料」（F2-26 / G4）。只对**已归档**的案件有意义——谓词里带了
   * `is_archived = true`，所以它与「已归档」视图天然配套。见 `missingMaterialsField`。
   */
  missingMaterials: missingMaterialsField,
} as const;

/**
 * 事项列表的筛选字段。与案件那份逐字对应，只差两处**值域来源不同**（不是不一致）：
 * `status` 取配置驱动那一份、多一个 `ownerEmpty`（案件必有负责人，事项可空，IQ-5）。
 */
export const riskMatterListFilters = {
  status: configStatusField.optional(),
  keyword: z.string().trim().max(60).optional(),
  archivedOnly: archivedOnlyField,
  ownerEmpty: ownerEmptyField,
} as const;

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sortBy: sortByField,
  sortDir: sortDirField,
  // spread 而不是照抄：列表与它的导出引的是**同一批字段对象**（见 `matterListFilters`）
  ...matterListFilters,
});

export type ListQuery = z.infer<typeof listQuerySchema>;

/**
 * 列表导出的查询面（MATT-64 / F1-20 + F2-23）：**列表的筛选 + `plain`**，没有分页。
 *
 * 没有 `page` / `pageSize` 是有意的：导出的是**整个筛选结果**（上限见服务层的
 * `*_EXPORT_LIMIT`），不是当前那一页 —— "只导出这一页"不是列表导出的语义，
 * 用户要的是"我筛出来的这一批都给我"。带分页参数进来也只是被 zod 剥掉。
 *
 * `plain` 复用 `expenses.ts` 的 `plainExportField`（当事人导出、整卷导出同一个人解析）：
 * 各写一份的失败形态是"一处认 `1`、另一处只认 `true`"，用户看到的是同一个按钮在两个页面行为不同。
 */
export const matterListExportQuerySchema = z.object({
  ...matterListFilters,
  sortBy: sortByField,
  sortDir: sortDirField,
  plain: plainExportField,
});
export type MatterListExportQuery = z.infer<typeof matterListExportQuerySchema>;

/** 事项列表导出（F1-20）。比案件侧多一个 `ownerEmpty`、status 走配置驱动那份 */
export const riskMatterListExportQuerySchema = z.object({
  ...riskMatterListFilters,
  sortBy: sortByField,
  sortDir: sortDirField,
  plain: plainExportField,
});
export type RiskMatterListExportQuery = z.infer<typeof riskMatterListExportQuerySchema>;

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

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
 * 可排序列（案件列表那一份就是全量）。用枚举而不是自由字符串，否则 `sortBy` 会变成注入面。
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
 * 事项列表的可排序列：全量减去 `amount`。
 *
 * 「预估影响」已于 2026-10-22 从事项侧整体撤下（迁移 0017 连库列一起删），事项这边
 * 没有这一列可排，所以这里收窄——与 `parties.ts` 同一手法：写自己的字面量清单，
 * 用 `satisfies` 钉住"必须是全量子集"，加错键编译期就红。
 * 不收窄的话，归档视图切到事项档时点金额表头会拿到 400。
 *
 * 案件侧的 `amount`（标的额）是本表自己的字段，不受影响。
 */
export const RISK_SORTABLE_COLUMNS = [
  "code",
  "name",
  "status",
  "risk_level",
  "owner_name",
  "created_at",
  "updated_at",
] as const satisfies readonly (typeof SORTABLE_COLUMNS)[number][];
export type RiskSortableColumn = (typeof RISK_SORTABLE_COLUMNS)[number];

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
 * 经办人（`owner_id`）。收成"数字字符串"而不是自由串：
 * 它最终要转 `bigint` 进 SQL，`"abc"` 那种值在这里就该 400，
 * 而不是等到 `BigInt()` 抛错变成 500。
 *
 * 一张表两个宿主共用同一个字段对象（禁令⑧）：案件侧必填、事项侧可空（IQ-5），
 * 但"什么算一个合法的 id"没有两种答案。
 */
export const ownerField = z.string().trim().regex(/^\d+$/, "经办人 id 必须是数字");

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
 *    是 `/archive`；报表卡按 P0-2 挂在列表页（`/risk-matters` 那一处已于 2026-10-22
 *    按原型撤下，`/api/reports` 仍在），所以这个键没有进来的场合。
 */
export const REPORT_OMITTED_KEYS = [
  "keyword",
  "page",
  "pageSize",
  "sortBy",
  "sortDir",
  "missingMaterials",
  /**
   * 案件页查询区新增的四格（`matters.html`：案件类型 / 案件程序 / 经办人 / 期限范围）。
   *
   * 不进报表的理由与 `keyword` 同一类：**它们不是"看哪一片"**。前三者是"把范围缩到某个
   * 具体值"，报表要回答的是"这一片里的分布长什么样"；`deadlineBucket` 更是按**节点**
   * 而不是按案卷切，与两张卡的矩阵维度（状态 × 等级 × 诉讼地位）根本不在一个粒度上。
   *
   * 这四个键只长在案件列表页，事项页没有对应控件——而两张卡是两个宿主**共用**的组件，
   * 让案件专有的筛选进去，事项那一半的行会与卡片头声明的范围对不上。
   */
  "caseType",
  "procedure",
  "owner",
  "deadlineBucket",
  /**
   * 事项页查询区新增的两格（`risk-matters.html`：风险等级 / 上报时间）。
   *
   * 与上面四个同理由：它们是"把范围缩到某个具体值"，不是"看哪一片"；
   * 而且方向相反——案件专有的键进不了事项那一半，事项专有的键进了案件那一半同样对不上。
   */
  "riskLevel",
  "reportBucket",
] as const;

/* ───────────────── 列表的筛选面：列表 / 它导出的那一份 两处同源 ───────────────── */

/**
 * 排序字段。抽出来是给**列表与它的导出**共用（MATT-64）：两处的默认值与白名单必须是
 * 同一个对象，否则"列表按更新倒序、导出按编号正序"这种不一致不会报错，只会让人以为导错了。
 */
export const sortByField = z.enum(SORTABLE_COLUMNS).default("updated_at");
/**
 * 事项侧的那一份：同一手法、同一个默认值，只是白名单收窄（见 `RISK_SORTABLE_COLUMNS` 那条注）。
 * 列表路由与列表导出**共用这一个对象**（MATT-64 的口径），不要在路由里再写一遍 `z.enum`。
 */
export const riskSortByField = z.enum(RISK_SORTABLE_COLUMNS).default("updated_at");
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
  /**
   * 案件类型 / 案件程序（canon `matters.html` 查询区的两格）。
   *
   * 值域**不在这里收枚举**：`case_type` 与 `procedure` 相加有 13 个 code，
   * 而前端下拉的字典来自 `/api/meta`（`CASE_TYPE_LABELS` / `PROCEDURE_LABELS` 同一份）。
   * 这里只做长度与形态的粗校验，真正的"这个 code 存在吗"由库里的 CHECK 约束回答——
   * 收成枚举就多出一份必须与 `shared/enums` 同步的字面量清单。
   *
   * 空串**不算一个筛选值**：前端「全部」发的是不发这个键，所以 `min(1)`。
   */
  caseType: z.string().trim().min(1).max(24).optional(),
  procedure: z.string().trim().min(1).max(28).optional(),
  /**
   * 经办人（`owner_id`）。收成"数字字符串"而不是自由串：
   * 它最终要转 `bigint` 进 SQL，`"abc"` 那种值在这里就该 400，
   * 而不是等到 `BigInt()` 抛错变成 500。
   */
  owner: ownerField.optional(),
  /**
   * 期限范围（原型「全部 / 已逾期 / 7 日内 / 更远」）。
   *
   * ⚠ **不是** `nextDeadline` 那一列的简单比较：那一列取的是"最近一个未决节点的期限"，
   * 而本筛选要回答的是"这条案卷现在有没有一个节点落在这一档"——两者在
   * "有多个节点、其中最早的逾期"时才会重合，语义不是一回事。
   * 所以谓词写成 `EXISTS (… mn_matter_node …)`，见服务层 `mattersListWhere`。
   *
   * `none` 是原型的第四档「未定」（没有任何未决节点期限）：没有它就是
   * "筛不到那些没有期限的案卷"，而那正是运营最先要找的一批。
   */
  deadlineBucket: z.enum(["overdue", "soon", "later", "none"]).optional(),
} as const;

/**
 * 风险等级（canon `risk-matters.html` 查询区第二格）。
 *
 * 值域同 `caseType`：字典来自 `/api/meta` 的 `levels`（配置驱动，运营可改名），
 * 所以这里只做形态与长度校验，不收枚举——收枚举就多一份必须与库里
 * `mn_risk_level_config` 同步的字面量清单。
 */
export const riskLevelField = z.string().trim().min(1).max(24);

/**
 * 上报时间范围（canon `risk-matters.html` 查询区最后一格，下拉「全部时间」）。
 *
 * 筛的是 `created_at` —— 这一条被**登记进系统**的时刻，也就是原型里"上报"的意思。
 * 不筛 `discover_date`：那是"风险什么时候被发现"，与"什么时候报上来"是两件事，
 * 建号时可以填一个早得多的日期。三档是**滚动窗口**（含今天）：
 *
 *   · `week`  = 近 7 天
 *   · `month` = 近 30 天
 *   · `quarter` = 近 90 天
 *
 * 不做起止双日期：原型那一格是一个下拉，不是日期区间控件；而两个日期框
 * 在 1366 下会把查询区挤成三行。
 */
export const reportBucketField = z.enum(["week", "month", "quarter"]);

/**
 * 事项列表的筛选字段。与案件那份逐字对应，只差两处**值域来源不同**（不是不一致）：
 * `status` 取配置驱动那一份、多一个 `ownerEmpty`（案件必有负责人，事项可空，IQ-5）。
 */
export const riskMatterListFilters = {
  status: configStatusField.optional(),
  keyword: z.string().trim().max(60).optional(),
  archivedOnly: archivedOnlyField,
  ownerEmpty: ownerEmptyField,
  owner: ownerField.optional(),
  riskLevel: riskLevelField.optional(),
  reportBucket: reportBucketField.optional(),
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
 * 事项列表的查询面（分页 + 排序 + 上面那批筛选）。
 *
 * 放这里而不是各路由自己写一份：列表与「经办人候选」两个端点吃的是**同一套**筛选，
 * 而曾经那份写在各路由里的副本漏掉新键 ⇒ zod 静默剥掉 ⇒ 筛选点了没反应、
 * 传错值也不 400。收成一份，加键只有一处。导出不用它（导出没有分页，见下）。
 */
export const riskMatterListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sortBy: riskSortByField,
  sortDir: sortDirField,
  ...riskMatterListFilters,
});
export type RiskMatterListQuery = z.infer<typeof riskMatterListQuerySchema>;

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

/** 事项列表导出（F1-20）。比案件侧多一个 `ownerEmpty`、status 走配置驱动那份，`sortBy` 走事项那份收窄的白名单 */
export const riskMatterListExportQuerySchema = z.object({
  ...riskMatterListFilters,
  sortBy: riskSortByField,
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

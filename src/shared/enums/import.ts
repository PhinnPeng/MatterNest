/**
 * 批量导入（F7-4 / M7 US-M7-1）的三个**新值域**。它们都不占 E 行号
 * （枚举表 E01–E37 是"业务分类与状态"那一侧，导入是管线），所以按 `automation.ts`
 * 的先例住在这里、登记进 `STRUCT_REGISTRY`，迁移里的 `CHECK` 与之一对一认领。
 *
 * 三个值域各自存在的理由：
 *   1. **`IMPORT_KINDS`** —— 三张模板的种类。它**不是** `HOST_TYPES`（E08/E10 = `matter`/`risk_matter`）：
 *      当事人档案模板没有宿主（`mn_party` 是跨宿主共享实体，F3-1），硬塞进 `HOST_TYPES`
 *      会让"宿主类型"这个概念第一次说谎。所以宁可多一个值域，也不借用一个不成立的。
 *   2. **`IMPORT_ROW_STATUSES`** —— 逐行结果。只有两值，且**只有 `imported` 的行参与幂等键**：
 *      未导入的行不占内容键，否则"改了错行再传一次"会撞上自己上一轮的错误记录。
 *   3. **`IMPORT_ISSUE_CODES`** —— 逐行问题的原因码。中文原因（`message`）是给人读的、
 *      会改；码是给测试与统计读的、不许改。两者分开存（`mn_import_row.issues` 的 jsonb 元素），
 *      否则冒烟只能断言"有一句话"，改一个字就红。
 *
 * `IMPORT_ISSUE_CODES` **不在迁移的 CHECK 里**（它住在 jsonb 内部，DB 守不住）——
 * 登记在这里是为了让它可被发现、可被 `import.spec.ts` 断言全覆盖，不是假装 DB 在守它。
 */

/** 三张模板的种类。`party` 无宿主，见文件头第 1 条 */
export const IMPORT_KINDS = ["risk_matter", "matter", "party"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const IMPORT_KIND_LABELS: Record<ImportKind, string> = {
  risk_matter: "风险事项",
  matter: "案件",
  party: "当事人",
};

/** `mn_import_row.status`：一行要么进了库，要么没进（没进的原因在 `issues` 里） */
export const IMPORT_ROW_STATUSES = ["imported", "skipped"] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];
export const IMPORT_ROW_STATUS_LABELS: Record<ImportRowStatus, string> = {
  imported: "已导入",
  skipped: "未导入",
};

/**
 * `mn_import_batch.status`。
 *
 * `running` 是**崩溃留下的痕迹**，不是正常中间态：正常一轮在同一个事务里把计数与状态
 * 一起收尾。留着它是因为"上次这个文件没跑完"必须能从库里读出来 —— 那种批次没有
 * `BULK_IMPORT` 汇总（汇总在收尾事务里写），只有这条记录能解释为什么库里有半批数据。
 */
export const IMPORT_BATCH_STATUSES = ["running", "completed"] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];
export const IMPORT_BATCH_STATUS_LABELS: Record<ImportBatchStatus, string> = {
  running: "未跑完",
  completed: "已完成",
};

/**
 * 逐行问题的原因码（错误报告「原因」列的机器可读那一半）。
 *
 * 十二条不是枚举洁癖：冒烟要按码断言"这一行为什么没进"，而中文原因随时会被改字。
 * 码一旦发布就不改（与 §5.3 的废弃流程同姿态）。
 */
export const IMPORT_ISSUE_CODES = [
  "required",
  "invalid_field",
  "unknown_enum",
  "unknown_config",
  "unknown_user",
  "ambiguous_user",
  "party_mismatch",
  "own_company",
  "duplicate_row",
  "already_imported",
  "identity_exists",
  "unassignable",
] as const;
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number];
export const IMPORT_ISSUE_CODE_LABELS: Record<ImportIssueCode, string> = {
  required: "必填列没填",
  invalid_field: "字段值不合校验规则",
  unknown_enum: "取值不在允许的枚举范围内",
  unknown_config: "取值不在启用的配置项里",
  unknown_user: "处理人在册查不到",
  ambiguous_user: "处理人重名，无法唯一确定",
  party_mismatch: "当事人证件号个数多于当事人个数",
  own_company: "本企业名不入当事人档案",
  duplicate_row: "与本文件前面某行内容完全相同",
  already_imported: "与之前导入过的某行内容完全相同",
  identity_exists: "库里已有同证件号的档案",
  unassignable: "处理人不可被指派",
};

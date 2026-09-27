/**
 * 状态域枚举（E08 / E09）—— 单一事实源在 `docs/PRD-phase1-enums-and-schemas.md` §1。
 *
 * 为什么放在 `src/shared/enums/` 而不是只写在 DDL 里：禁令② 与 W0-3 要求
 * **DB 的 CHECK 值域与这份数组逐字相等**，而 API 校验、前端下拉、seed 都要读同一份。
 * 两边各写一份是本项目最容易出的静默漂移，所以 `status.spec.ts` 直接拿本文件与迁移 SQL 对拉。
 *
 * E09 的口径注意（枚举表 §1 该行）：`custom` 只是 **DDL 兜底默认值**，
 * "新建状态只能选 custom"是 API 规则 —— 四个内置语义由 seed 持有、不可授予。
 */

/**
 * E08 `status_config.host_type` —— 值域与 E10（`node_type_config.host_type`）完全相同，
 * 因此**不在此重复定义**：单一实现住在 `./targets`，这里只做再导出。
 * 两份数组 = 本票要防的第一类漂移（改了 E08 忘了 E10）。
 */
export { HOST_TYPES, HOST_TYPE_LABELS, type HostType } from "./targets";

/** E09 `status_config.semantics` —— 顺序即 DDL CHECK 里的顺序，改动会触发一致性测试 */
export const STATUS_SEMANTICS = ["open", "in_progress", "closed", "archived", "custom"] as const;
export type StatusSemantics = (typeof STATUS_SEMANTICS)[number];
/** 展示名按修订稿 §3.1 的语义描述取短词（文档未给逐项中文，见 `business.ts` 的 DERIVED_LABELS 同口径） */
export const STATUS_SEMANTIC_LABELS: Record<StatusSemantics, string> = {
  open: "初始态",
  in_progress: "进行中",
  closed: "结案",
  archived: "归档",
  custom: "自定义",
};

/**
 * semantics → 系统行为与"每 host_type 数量约束"（修订稿 §3.1 表）。
 * 数量约束写在这里是为了让 seed 与"新增状态"校验共用同一份判定，
 * 而不是各自把 1/≥1/≤1/恰好1 再抄一遍。
 */
export const SEMANTICS_RULES: Record<
  StatusSemantics,
  { perHost: "exactly-one" | "at-least-one" | "at-most-one" | "any"; effect: string }
> = {
  open: { perHost: "exactly-one", effect: "新建初始态（is_initial_status 挂它）" },
  in_progress: { perHost: "at-least-one", effect: "计入活跃，可被规则 3 命中" },
  closed: { perHost: "at-most-one", effect: "视为结案，closing_date 自动写入" },
  archived: { perHost: "exactly-one", effect: "触发归档：只读 + 列表默认隐藏" },
  custom: { perHost: "any", effect: "纯展示与筛选，无系统行为" },
};

/** 只有这一种语义可以被 API 授予给新建状态（枚举表 E09 行） */
export const ASSIGNABLE_SEMANTICS: readonly StatusSemantics[] = ["custom"];

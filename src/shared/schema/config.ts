/**
 * 配置实体枚举（配合 /api/config/[kind] 使用）。
 *
 * 合法值 = 14 个细项（5 个有 CRUD、7 个闭集枚举、2 个无承载）。
 * 非法 kind → 404（与“不可见即 404”同一措辞）。
 *
 * 14 个细项对应：案件状态、事项状态、风险等级、标签、费用项目、案件类型、案件程序、
 * 当事人类型、证件类型、诉讼地位、事项类型、节点状态、节点通知状态、节点通知时间。
 *
 * kind 是实体的枚举，不是自由字符串；前后端同一份形状（禁令⑧）。
 */
export const CONFIG_KINDS = [
  "case_status",     // 案件状态（mn_status_config host_type='matter'）
  "matter_status",   // 案件状态（mn_status_config host_type='risk_matter'）—与 case_status 区分
  "item_status",     // 事项状态（mn_status_config host_type='risk_matter'）
  "risk_level",      // 风险等级（mn_risk_level_config）
  "tag",            // 标签（mn_tag）
  "expense_item",    // 费用项目（mn_expense_item_config）
  "case_type",       // 案件类型（闭集枚举）
  "procedure",       // 案件程序（闭集枚举）
  "party_type",      // 当事人类型（闭集枚举）
  "id_type",         // 证件类型（闭集枚举）
  "litigation_role", // 诉讼地位（闭集枚举）
  "risk_matter_type",// 事项类型（闭集枚举）
  "node_status",     // 节点状态（闭集枚举）
  "node_notify_status",// 节点通知状态（无承载）
  "node_notify_time",  // 节点通知时间（无承载）
] as const;

export type ConfigKind = (typeof CONFIG_KINDS)[number];

export const WRITABLE_KINDS = new Set([
  "case_status",
  "matter_status",
  "item_status",
  "risk_level",
  "tag",
]);

export const ENUM_KINDS = new Set([
  "case_type",
  "procedure",
  "party_type",
  "id_type",
  "litigation_role",
  "risk_matter_type",
  "node_status",
]);

export const NO_ENTITY_KINDS = new Set([
  "node_notify_status",
  "node_notify_time",
]);

/**
 * 请求/响应共享形状：前后端同一份（禁令⑧）。
 *
 * 写接口时 kind 必须在 CONFIG_KINDS 中；读接口同形，校验 kind 合法性。
 *
 * 这与 `src/shared/schema/import.ts` 同一模式： Zod schema 直接映射 DB row，
 * 前端组件读 `useMeta("config")` 或 `useMeta("risk_config")`，服务层 db.select。
 */
export const configItemSchema = z.object({
  /** 细项唯一标识（code），在宿主+code 组合下唯一（status-config 有 partial unique） */
  code: z.string().regex(/^[A-Z0-9_-]+$/, "编码须为大写英文短横线连接"),
  /** 展示名：可改 */
  name: z.string().max(50, "名称最长 50 字符"),
  /** 颜色：标签有，风险等级有，其余留空或默认 */
  color: z.string().optional().default(""),
  /** 排序 */
  sortOrder: z.number().int().min(0).default(0),
  /** 说明 */
  description: z.string().optional(),
  /** 状态语义：决定系统行为 */
  semantics: z.enum(["open", "in_progress", "closed", "archived", "custom"]).optional(),
  /** 停用位 */
  isEnabled: z.boolean().default(true),
});
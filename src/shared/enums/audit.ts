/**
 * `activity_log.action` 全清单（枚举表 §3.1–§3.4，含补登的 `UNCONVERT`）。
 * 权威源：`docs/PRD-phase1-enums-and-schemas.md` §3 —— **这是唯一一份允许写 `payload` 载荷的枚举**。
 *
 * 三件事必须钉在一起，所以放在同一个文件里而不是拆成字符串数组：
 *   1. 值集合（闭合：`action varchar(40)`，`ACCESS_DENIED_WRITE` 已是 21 字符，加长取值时要复看长度）；
 *   2. `reason` 是否必填（§3.2 表；`UNCONVERT` 与 `NODE_CANCELLED` 必填，`STATUS_CHANGED` 仅偏离推荐路径时必填）；
 *   3. 载荷形态（`field_diffs` / `payload`，§5.4 新增 `payload jsonb` 后 `field_diffs` 回归"字段差异"本义）。
 *
 * 两条禁令级口径：**读拒绝不记日志**（否则案号枚举探测会反向灌满日志表），
 * 且 `SENSITIVE_FIELD_READ` 的载荷**不含字段值**（权限草案 §7.3）。
 *
 * ⚠ `SENSITIVE_FIELD_READ` 已于 IQ-12 / Q46′（2026-10-10）**作废**：展示层全明文，
 * "显示明文"按钮与逐次读取审计一并取消。按 §5.3 废弃流程，它**留在本清单与 DB CHECK 里**
 * （历史行仍需可反查），但**一期不写入、前端不展示**。明文与脱敏两档导出改由
 * `EXPORT` 统一留痕（payload 记 `plain` 布尔与行数，不含内容）。别在别处再写它。
 */

/** §3.1 实体 CRUD：载荷 `field_diffs` */
export const CRUD_ACTIONS = [
  "MATTER_CREATED",
  "MATTER_UPDATED",
  "MATTER_DELETED",
  "RISK_CREATED",
  "RISK_UPDATED",
  "RISK_DELETED",
  "NODE_CREATED",
  "NODE_UPDATED",
  "NODE_DELETED",
  "PROGRESS_CREATED",
  "PROGRESS_UPDATED",
  "PROGRESS_DELETED",
  "EXPENSE_CREATED",
  "EXPENSE_UPDATED",
  "EXPENSE_DELETED",
  "PARTY_CREATED",
  "PARTY_UPDATED",
  "PARTY_DELETED",
  "COMMENT_CREATED",
  "COMMENT_UPDATED",
  "COMMENT_DELETED",
  "ATTACHMENT_UPLOADED",
  "ATTACHMENT_DELETED",
] as const;

/** §3.2 状态与归属：载荷 `field_diffs`（部分另需 `reason`） */
export const STATE_ACTIONS = [
  "STATUS_CHANGED",
  "ARCHIVED",
  "UNARCHIVED",
  "OWNER_CHANGED",
  "CONVERTED_TO_CASE",
  "UNCONVERT",
  "NODE_COMPLETED",
  "NODE_CANCELLED",
] as const;

/** §3.3 授权与安全：载荷 `payload` */
export const SECURITY_ACTIONS = [
  "STAFF_CHANGED",
  "ROLE_CHANGED",
  "USER_ACTIVATED",
  /**
   * 账号启停（F6-1）。**新增于 MATT-10**，与 `USER_ACTIVATED` 分开的理由：
   * 后者的语义是"待开通 → 已开通并当场指定角色"（E37 `pending → active`），
   * 而启停改的是 `is_enabled`——方向可逆、且不涉及角色。用 `USER_ACTIVATED` 记一次
   * **停用**，读起来是"账号开通"，历史一查就误判。
   * 方向不另开两个值：载荷 `{is_enabled:{from,to}}` 已经写明了，两个值会把同一件事说两遍
   * （同 `STATUS_CHANGED` 用 field_diffs 记 from/to 的姿态）。
   */
  "USER_STATUS_CHANGED",
  /**
   * 本地凭据设置/重置（F6-9）。**新增于 MATT-10**。
   * 载荷只记 `{mode, self}`，**绝不记口令或摘要**——`logging-guidelines` 的既有禁令。
   */
  "CREDENTIAL_CHANGED",
  "SENSITIVE_FIELD_READ",
  "ACCESS_DENIED_WRITE",
  /**
   * 两档导出的统一留痕（IQ-12 / Q46′）。载荷 = `{target_type, scope, rows, count, plain}`，
   * **不含行内容**。
   *
   * ⚠ `rows` 的读法要说清，否则会被读成"导出了多少条记录"：
   * 它是**导出的数据行数**（等于 CSV 的数据行数），而"整卷"导出含一个「基本信息」区段 ——
   * 那一段是**字段名:值 的键值对**，每个字段算**一行**。实测一条只有 1 个当事人、
   * 3 个预置节点、2 笔费用的小案子，`rows = 24`（= 18 个基本信息字段行 + 1 + 3 + 2）。
   *
   * 所以：**`rows` 是"外流了多少行数据"，不是"多少条案卷"** —— 后者是 `count`
   * （本次覆盖的案卷件数，单卷恒 1；列表类导出没有这个量纲所以不写）。
   * 界面文案若写"已导出 N 行"，N 就是 `rows`，与"条"不同义。
   * （检查子代理在 MATT-47 的复核里挑出这一条：语义自洽，但"24 行"容易被读成"24 条记录"。）
   */
  "EXPORT",
] as const;

/** §3.4 自动化与提醒：载荷 `payload` */
export const AUTOMATION_ACTIONS = [
  "AUTO_RULE_EXECUTED",
  "AUTO_RULE_SKIPPED",
  "AUTO_RULE_FAILED",
  "REMINDER_SENT",
  "REMINDER_FAILED",
] as const;

/**
 * §3.5 意图对齐轮新增（IQ-7 / IQ-11）：两者都是**汇总**动作而非逐行 CRUD，
 * 载荷走 `payload`——合并记"谁活下来、谁被并走"，导入记"多少行进了、多少行没进"。
 */
export const ALIGNMENT_ACTIONS = ["PARTY_MERGED", "BULK_IMPORT"] as const;

export const AUDIT_ACTIONS = [
  ...CRUD_ACTIONS,
  ...STATE_ACTIONS,
  ...SECURITY_ACTIONS,
  ...AUTOMATION_ACTIONS,
  ...ALIGNMENT_ACTIONS,
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 中文名：文档只给了分组与原值，动作名按 UI 展示口径翻译（推导，见 §3 表头） */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  MATTER_CREATED: "新建案件",
  MATTER_UPDATED: "修改案件",
  MATTER_DELETED: "删除案件",
  RISK_CREATED: "新建事项",
  RISK_UPDATED: "修改事项",
  RISK_DELETED: "删除事项",
  NODE_CREATED: "新建节点",
  NODE_UPDATED: "修改节点",
  NODE_DELETED: "删除节点",
  PROGRESS_CREATED: "新建进展",
  PROGRESS_UPDATED: "修改进展",
  PROGRESS_DELETED: "删除进展",
  EXPENSE_CREATED: "新建费用",
  EXPENSE_UPDATED: "修改费用",
  EXPENSE_DELETED: "删除费用",
  PARTY_CREATED: "新建当事人",
  PARTY_UPDATED: "修改当事人",
  PARTY_DELETED: "删除当事人",
  COMMENT_CREATED: "发表评论",
  COMMENT_UPDATED: "编辑评论",
  COMMENT_DELETED: "删除评论",
  ATTACHMENT_UPLOADED: "上传附件",
  ATTACHMENT_DELETED: "删除附件",
  STATUS_CHANGED: "状态变更",
  ARCHIVED: "归档",
  UNARCHIVED: "撤销归档",
  OWNER_CHANGED: "变更负责人",
  CONVERTED_TO_CASE: "转为案件",
  UNCONVERT: "撤销转案件",
  NODE_COMPLETED: "节点完成",
  NODE_CANCELLED: "节点取消",
  STAFF_CHANGED: "参与人变更",
  ROLE_CHANGED: "角色变更",
  USER_ACTIVATED: "账号开通",
  USER_STATUS_CHANGED: "账号启停",
  CREDENTIAL_CHANGED: "凭据设置",
  /** @deprecated IQ-12 已作废：展示层全明文，不再逐次审计。留在这里只为反查历史行 */
  SENSITIVE_FIELD_READ: "明文查看敏感字段",
  ACCESS_DENIED_WRITE: "写操作被拒",
  EXPORT: "导出",
  AUTO_RULE_EXECUTED: "规则执行",
  AUTO_RULE_SKIPPED: "规则跳过",
  AUTO_RULE_FAILED: "规则失败",
  REMINDER_SENT: "提醒发送",
  REMINDER_FAILED: "提醒发送失败",
  PARTY_MERGED: "当事人合并",
  BULK_IMPORT: "批量导入",
};

/** §3.2：`reason` 恒必填的四条 */
export const REASON_REQUIRED_ACTIONS: readonly AuditAction[] = [
  "ARCHIVED",
  "UNARCHIVED",
  "UNCONVERT",
  "NODE_CANCELLED",
];
/** §3.2：`reason` 条件必填 —— 仅当偏离推荐路径（修订稿 §3.3 第 3 条） */
export const REASON_CONDITIONAL_ACTIONS: readonly AuditAction[] = ["STATUS_CHANGED"];
/** §3.2：`reason` 选填 */
export const REASON_OPTIONAL_ACTIONS: readonly AuditAction[] = [
  "OWNER_CHANGED",
  "CONVERTED_TO_CASE",
  "NODE_COMPLETED",
];

/** 载荷走 `payload jsonb` 而非 `field_diffs` 的两组（§5.4） */
export const PAYLOAD_ACTIONS: readonly AuditAction[] = [
  ...SECURITY_ACTIONS,
  ...AUTOMATION_ACTIONS,
  ...ALIGNMENT_ACTIONS,
];
/** 载荷走 `field_diffs` 的一组（§3.1） */
export const FIELD_DIFF_ACTIONS: readonly AuditAction[] = CRUD_ACTIONS;
/** `action` 列宽（修订稿 §8.1：`varchar(40)`）；长度断言用它 */
export const AUDIT_ACTION_MAX_LENGTH = 40;

/**
 * §3.2 末行的硬口径：`*_UPDATED` 只在**业务字段**变化时写。
 * 这三列是派生列，触发日志会把审计刷成噪声（`converted_case_count` 尤其明显）。
 */
export const NON_AUDIT_TRIGGERING_COLUMNS = [
  "updated_at",
  "deadline_time",
  "is_archived",
  "converted_case_count",
] as const;

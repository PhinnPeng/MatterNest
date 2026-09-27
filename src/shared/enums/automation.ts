/**
 * 自动化规则的结构定义（枚举表 §4 + E33）。
 * 权威源：`docs/PRD-phase1-enums-and-schemas.md` §4.1–§4.4；规则取值见修订稿 §2.3。
 *
 * 第一期引擎的能力边界就是这份文件的全部内容 —— **不在清单里的算子/字段，配置页不许出现，
 * 后端也直接拒**。§4.2 末行的裁定写得很直白：规则 4「30 天无更新」的"无更新"判断
 * **不在 `extra_condition` 里表达**，内置在动作实现中；这一条要在配置页对用户明示，
 * 否则用户会以为能配出任意条件。
 */

/** §4.1 `trigger_type`：五种内置触发 */
export const TRIGGER_TYPES = [
  "status_changed",
  "time_no_progress",
  "node_before_start",
  "node_before_end",
  "event_occurred",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  status_changed: "状态变更为",
  time_no_progress: "一段时间无更新",
  node_before_start: "节点开始前",
  node_before_end: "节点截止前",
  event_occurred: "领域事件发生时",
};
/** 触发实体（E03 的子集）：节点类触发指向节点表，其余指向宿主 */
export const TRIGGER_TARGET_BY_TYPE: Record<TriggerType, readonly string[]> = {
  status_changed: ["matter", "risk_matter"],
  time_no_progress: ["matter", "risk_matter"],
  node_before_start: ["matter_node", "risk_matter_node"],
  node_before_end: ["matter_node", "risk_matter_node"],
  event_occurred: ["matter", "risk_matter"],
};
/** `trigger_config` 的键按 trigger_type 一对一（§4.1）：未知键一律拒绝保存 */
export const TRIGGER_CONFIG_KEYS: Record<TriggerType, readonly string[]> = {
  status_changed: ["status_code"],
  time_no_progress: ["days"],
  node_before_start: ["days"],
  node_before_end: ["days"],
  event_occurred: ["event"],
};
/** §4.1 校验：`days` 为 1..365 整数 */
export const TRIGGER_DAYS_RANGE = { min: 1, max: 365 } as const;
/** §4.1：`node_before_end` 仅对 `time_type=range` 且 `end_time` 非空的节点有效 */
export const TRIGGER_NODE_BEFORE_END_REQUIRES_RANGE = true;

/** E33 `trigger_config.event`（`event_occurred` 用）：第一期两个事件，规则 7 / 规则 8 各引一个 */
export const DOMAIN_EVENT_TYPES = ["risk_converted", "comment_added"] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
export const DOMAIN_EVENT_TYPE_LABELS: Record<DomainEventType, string> = {
  risk_converted: "事项转案件",
  comment_added: "新增评论",
};

/** §4.3 `action_type`：五种内置动作 */
export const ACTION_TYPES = [
  "archive",
  "notify",
  "create_node",
  "assign_staff",
  "update_field",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  archive: "归档",
  notify: "发送通知",
  create_node: "生成节点",
  assign_staff: "指派参与人",
  update_field: "更新字段",
};
/** `action_config` 的键按 action_type 一对一（§4.3） */
export const ACTION_CONFIG_KEYS: Record<ActionType, readonly string[]> = {
  archive: [],
  notify: ["receivers", "template_code", "custom_user_ids", "once_per_target", "cooldown_days"],
  create_node: ["template_code", "offset_days_from", "offset_days"],
  assign_staff: ["staff_role", "user_ids", "mode"],
  update_field: ["field", "value"],
};
/** §4.3 notify 的收件人类型（E04 的三个 staff_role + custom） */
export const NOTIFY_RECEIVERS = ["owner", "co_owner", "follower", "custom"] as const;
export type NotifyReceiver = (typeof NOTIFY_RECEIVERS)[number];
export const NOTIFY_RECEIVER_LABELS: Record<NotifyReceiver, string> = {
  owner: "承办人",
  co_owner: "协办人",
  follower: "关注人",
  custom: "指定人员",
};
/** §4.3：`custom_user_ids` 仅当 `receivers` 含 `custom` 时才允许非空 */
export const CUSTOM_RECEIVER_KEY = "custom";
/** §4.3 create_node：`offset_days_from` 第一期只有这一个基准 */
export const OFFSET_DAY_BASES = ["status_changed_at"] as const;
export type OffsetDayBase = (typeof OFFSET_DAY_BASES)[number];
/** §4.3 assign_staff 的两种模式 */
export const ASSIGN_MODES = ["append", "replace"] as const;
export type AssignMode = (typeof ASSIGN_MODES)[number];
export const ASSIGN_MODE_LABELS: Record<AssignMode, string> = { append: "追加", replace: "替换" };
/** §4.3 校验：`once_per_target=true` 时 `cooldown_days` 必须 ≥1 */
export const COOLDOWN_MIN_WHEN_ONCE = 1;

/** §4.2 逻辑算子：**只有根节点 `and`，不支持 `or` / 取反 / 子查询 / 聚合** */
export const LOGIC_OPS = ["and"] as const;
export type LogicOp = (typeof LOGIC_OPS)[number];
/** §4.2 嵌套：仅 1 层，子条件不可再含 `op` */
export const EXTRA_CONDITION_MAX_DEPTH = 1;
/** §4.2 比较算子 */
export const COMPARE_OPS = [
  "eq",
  "ne",
  "in",
  "not_in",
  "gt",
  "lt",
  "is_empty",
  "not_empty",
] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];
export const COMPARE_OP_LABELS: Record<CompareOp, string> = {
  eq: "等于",
  ne: "不等于",
  in: "属于",
  not_in: "不属于",
  gt: "大于",
  lt: "小于",
  is_empty: "为空",
  not_empty: "非空",
};
/** `in`/`not_in` 的 value 必须是数组，其余不是（保存期校验，避免运行期才炸） */
export const ARRAY_VALUE_COMPARE_OPS: readonly CompareOp[] = ["in", "not_in"];

/**
 * §4.2 字段白名单**按宿主分列**（修订稿 §2.5 的扁平白名单是旧版，已按 §4.2 回改）。
 * 存的是 `code` 不是列名；白名单外的 key 直接拒绝保存。
 */
export const CONDITION_FIELDS_BY_HOST = {
  matter: [
    "level",
    "case_type",
    "procedure",
    "litigation_role",
    "owner_id",
    "tag_ids",
    "amount",
    "court",
  ],
  risk_matter: ["level", "type", "source", "owner_id", "tag_ids", "amount"],
} as const satisfies Record<string, readonly string[]>;

/**
 * §4.3 `update_field.field` 白名单。
 * 排除项同样重要，所以并列写出：`status` 禁止（要走状态变更链路，否则绕过推荐路径与规则 2）；
 * 人员类走 `assign_staff`（避免与它重叠，修订稿 D4）；派生列与不可变列不可写。
 */
export const UPDATABLE_FIELDS = ["level", "source", "cause", "court", "remark"] as const;
export type UpdatableField = (typeof UPDATABLE_FIELDS)[number];
export const UPDATABLE_FIELD_LABELS: Record<UpdatableField, string> = {
  level: "风险等级",
  source: "事项来源",
  cause: "案由",
  court: "受理法院",
  remark: "备注",
};
export const NEVER_UPDATABLE_BY_RULE = {
  forbidden: ["status"],
  viaAssignStaff: ["owner_id", "co_owner_ids", "follower_ids"],
  immutableOrAudit: ["id", "code", "internal_code", "case_no", "created_at", "created_by"],
  derived: ["is_archived", "deadline_time", "converted_case_count", "is_archive_status"],
} as const;

/** §4.4 `scope_key`：摘要长度 12（base32 hex 前 12 位），列宽 `varchar(32)` 有余量 */
export const SCOPE_KEY_LENGTH = 12;
/** 归一化必过的 8 条向量在 `src/app/lib/server/automation/scope-key.spec.ts`（W1-4 落实现时一并写） */
export const SCOPE_KEY_VECTOR_COUNT = 8;

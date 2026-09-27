/**
 * 枚举注册表（W0-3）。
 *
 * 这份文件本身不含取值 —— 取值一律住在各分册里，它只做两件事：
 *   1. 给 E01–E37 每行一个**可被机器核对**的条目（含"这行不是枚举"的三种情况）；
 *   2. 标出该值域是否已经进了 DB（`in-db` + 约束名），从而让
 *      `src/app/lib/server/db/enum-check.spec.ts` 能做**双向**比对：
 *        · 注册表说"已进库" ⇒ 迁移里必须找得到该 CHECK，且值集合逐字相等；
 *        · 迁移里出现 `CHECK (col IN (…'literal'…))` ⇒ 必须被注册表认领，否则红。
 *      单向检查会漏掉"有人直接在迁移里加了值域约束却没登记"这一半。
 *
 * 为什么不做 codegen：枚举表 §5.1 明确裁定"CHECK 手写 + 一条一致性测试"，
 * 理由是生成器往迁移里插内容会让迁移不再是稳定产物。本文件遵守该裁定。
 */
import {
  ACTIVATION_STATUSES,
  ACTIVATION_STATUS_LABELS,
  AUTH_VIAS,
  AUTH_VIA_LABELS,
  EXTERNAL_PROVIDER_LABELS,
  EXTERNAL_PROVIDERS,
  EXTERNAL_SYNC_STATUSES,
  EXTERNAL_SYNC_STATUS_LABELS,
} from "./auth";
import {
  ATTACHMENT_CATEGORIES,
  ATTACHMENT_CATEGORY_LABELS,
  CASE_TYPES,
  CASE_TYPE_LABELS,
  CONVERSION_STATUSES,
  CONVERSION_STATUS_LABELS,
  CURRENCIES,
  CURRENCY_LABELS,
  EXPENSE_STATUSES,
  EXPENSE_STATUS_LABELS,
  ID_TYPES,
  ID_TYPE_LABELS,
  LITIGATION_ROLES,
  LITIGATION_ROLE_LABELS,
  NODE_SOURCE_KINDS,
  NODE_SOURCE_KIND_LABELS,
  NODE_STATUSES,
  NODE_STATUS_LABELS,
  PARTY_TYPES,
  PARTY_TYPE_LABELS,
  PROCEDURES,
  PROCEDURE_LABELS,
  PROGRESS_TYPES,
  PROGRESS_TYPE_LABELS,
  REPRESENTED_IS_BOOLEAN,
  RISK_MATTER_SOURCES,
  RISK_MATTER_SOURCE_LABELS,
  RISK_MATTER_TYPES,
  RISK_MATTER_TYPE_LABELS,
  TIME_TYPES,
  TIME_TYPE_LABELS,
} from "./business";
import {
  ACTION_TYPES,
  ACTION_TYPE_LABELS,
  ASSIGN_MODES,
  ASSIGN_MODE_LABELS,
  COMPARE_OPS,
  COMPARE_OP_LABELS,
  DOMAIN_EVENT_TYPES,
  DOMAIN_EVENT_TYPE_LABELS,
  LOGIC_OPS,
  NOTIFY_RECEIVERS,
  NOTIFY_RECEIVER_LABELS,
  OFFSET_DAY_BASES,
  TRIGGER_TYPES,
  TRIGGER_TYPE_LABELS,
  UPDATABLE_FIELDS,
  UPDATABLE_FIELD_LABELS,
} from "./automation";
import { AUDIT_ACTION_LABELS, AUDIT_ACTIONS } from "./audit";
import {
  DELIVERY_STATUSES,
  DELIVERY_STATUS_LABELS,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_EVENT_TYPE_LABELS,
  NOTIFICATION_SOURCE_TYPES,
  NOTIFICATION_SOURCE_TYPE_LABELS,
  NOTIFY_CHANNELS,
  NOTIFY_CHANNEL_LABELS,
  OUTBOX_EVENT_TYPES,
  OUTBOX_EVENT_TYPE_LABELS,
  REMINDER_STATUSES,
  REMINDER_STATUS_LABELS,
  REPEAT_TYPES,
  REPEAT_TYPE_LABELS,
} from "./notify";
import { STATUS_SEMANTICS, STATUS_SEMANTIC_LABELS } from "./status";
import {
  DATA_SCOPES,
  DATA_SCOPE_LABELS,
  HOST_TYPES,
  HOST_TYPE_LABELS,
  NO_STATUS_COLUMN,
  STAFF_ROLES,
  STAFF_ROLE_LABELS,
  TARGET_TYPES,
  TARGET_TYPE_LABELS,
  WATCH_TYPES,
  WATCH_TYPE_LABELS,
} from "./targets";

/** `in-db` = 值域已由迁移里的 CHECK 守住；`pending-table` = 值域已定但表还没建；`not-an-enum` = 该行本就不是枚举 */
export type EnumLanding = "in-db" | "pending-table" | "not-an-enum";

export type EnumEntry = {
  /** 枚举表行号，E01…E37 */
  id: string;
  /** 文档里的字段写法 */
  field: string;
  landing: EnumLanding;
  values: readonly (string | number)[];
  labels: Readonly<Record<string, string>>;
  /** 仅 `in-db`：值域落在哪张表哪个列、约束叫什么 */
  constraint?: { table: string; column: string; name: string };
  /** 值域被哪些列共用（同 E03/E06 这类跨列复用），供建表时抄约束 */
  usedBy?: readonly string[];
  /** `not-an-enum` 的处置说明 */
  note?: string;
};

export const ENUM_REGISTRY: readonly EnumEntry[] = [
  {
    id: NO_STATUS_COLUMN.id,
    field: NO_STATUS_COLUMN.field,
    landing: "not-an-enum",
    values: [],
    labels: {},
    note: NO_STATUS_COLUMN.note,
  },
  {
    id: "E02",
    field: "role.data_scope",
    landing: "pending-table",
    values: DATA_SCOPES,
    // label 是 `{zh, formula}` 结构，注册表只收展示名
    labels: Object.fromEntries(DATA_SCOPES.map((v) => [v, DATA_SCOPE_LABELS[v].zh])),
    usedBy: ["role.data_scope"],
  },
  {
    id: "E03",
    field: "target_type",
    landing: "pending-table",
    values: TARGET_TYPES,
    labels: TARGET_TYPE_LABELS,
    usedBy: [
      "activity_log.target_type",
      "notification_event.target_type",
      "custom_reminder.target_type",
    ],
  },
  {
    id: "E04",
    field: "*_staff.staff_role",
    landing: "pending-table",
    values: STAFF_ROLES,
    labels: STAFF_ROLE_LABELS,
    usedBy: ["matter_staff.staff_role", "risk_matter_staff.staff_role", "action_config.staff_role"],
  },
  {
    id: "E05",
    field: "user_watch.watch_type",
    landing: "pending-table",
    values: WATCH_TYPES,
    labels: WATCH_TYPE_LABELS,
  },
  {
    id: "E06",
    field: "*_party.party_role",
    landing: "pending-table",
    values: LITIGATION_ROLES,
    labels: LITIGATION_ROLE_LABELS,
    usedBy: ["matter_party.party_role", "risk_matter_party.party_role", "matter.litigation_role"],
  },
  {
    id: REPRESENTED_IS_BOOLEAN.id,
    field: REPRESENTED_IS_BOOLEAN.field,
    landing: "not-an-enum",
    values: [],
    labels: {},
    note: REPRESENTED_IS_BOOLEAN.note,
  },
  {
    id: "E08",
    field: "status_config.host_type",
    landing: "in-db",
    values: HOST_TYPES,
    labels: HOST_TYPE_LABELS,
    constraint: { table: "status_config", column: "host_type", name: "ck_status_host_type" },
  },
  {
    id: "E09",
    field: "status_config.semantics",
    landing: "in-db",
    values: STATUS_SEMANTICS,
    labels: STATUS_SEMANTIC_LABELS,
    constraint: { table: "status_config", column: "semantics", name: "ck_status_semantics" },
  },
  {
    id: "E10",
    field: "node_type_config.host_type",
    landing: "pending-table",
    values: HOST_TYPES,
    labels: HOST_TYPE_LABELS,
  },
  {
    id: "E11",
    field: "node_type_config.time_type",
    landing: "pending-table",
    values: TIME_TYPES,
    labels: TIME_TYPE_LABELS,
  },
  {
    id: "E12",
    field: "matter.litigation_role",
    landing: "pending-table",
    values: LITIGATION_ROLES,
    labels: LITIGATION_ROLE_LABELS,
  },
  {
    id: "E13",
    field: "matter.case_type",
    landing: "pending-table",
    values: CASE_TYPES,
    labels: CASE_TYPE_LABELS,
  },
  {
    id: "E14",
    field: "matter.procedure",
    landing: "pending-table",
    values: PROCEDURES,
    labels: PROCEDURE_LABELS,
  },
  {
    id: "E15",
    field: "risk_matter.type",
    landing: "pending-table",
    values: RISK_MATTER_TYPES,
    labels: RISK_MATTER_TYPE_LABELS,
  },
  {
    id: "E16",
    field: "risk_matter.source",
    landing: "pending-table",
    values: RISK_MATTER_SOURCES,
    labels: RISK_MATTER_SOURCE_LABELS,
  },
  {
    id: "E17",
    field: "party.type",
    landing: "pending-table",
    values: PARTY_TYPES,
    labels: PARTY_TYPE_LABELS,
  },
  {
    id: "E18",
    field: "party.id_type",
    landing: "pending-table",
    values: ID_TYPES,
    labels: ID_TYPE_LABELS,
  },
  {
    id: "E19",
    field: "matter_progress.progress_type",
    landing: "pending-table",
    values: PROGRESS_TYPES,
    labels: PROGRESS_TYPE_LABELS,
  },
  {
    id: "E20",
    field: "matter_expense.status",
    landing: "pending-table",
    values: EXPENSE_STATUSES,
    labels: EXPENSE_STATUS_LABELS,
  },
  {
    id: "E21",
    field: "matter_node.status",
    landing: "pending-table",
    values: NODE_STATUSES,
    labels: NODE_STATUS_LABELS,
    usedBy: ["matter_node.status", "risk_matter_node.status"],
  },
  {
    id: "E22",
    field: "*_node.source_kind",
    landing: "pending-table",
    values: NODE_SOURCE_KINDS,
    labels: NODE_SOURCE_KIND_LABELS,
  },
  {
    id: "E23",
    field: "custom_reminder.status",
    landing: "pending-table",
    values: REMINDER_STATUSES,
    labels: REMINDER_STATUS_LABELS,
  },
  {
    id: "E24",
    field: "custom_reminder.repeat_type",
    landing: "pending-table",
    values: REPEAT_TYPES,
    labels: REPEAT_TYPE_LABELS,
  },
  {
    id: "E25",
    field: "notify_channel",
    landing: "pending-table",
    values: NOTIFY_CHANNELS,
    labels: NOTIFY_CHANNEL_LABELS,
  },
  {
    id: "E26",
    field: "attachment.category",
    landing: "pending-table",
    values: ATTACHMENT_CATEGORIES,
    labels: ATTACHMENT_CATEGORY_LABELS,
  },
  {
    id: "E27",
    field: "currency",
    landing: "pending-table",
    values: CURRENCIES,
    labels: CURRENCY_LABELS,
  },
  {
    id: "E28",
    field: "risk_matter.conversion_status",
    landing: "pending-table",
    values: CONVERSION_STATUSES,
    labels: CONVERSION_STATUS_LABELS,
  },
  {
    id: "E29",
    field: "notification_event.event_type",
    landing: "pending-table",
    values: NOTIFICATION_EVENT_TYPES,
    labels: NOTIFICATION_EVENT_TYPE_LABELS,
  },
  {
    id: "E30",
    field: "notification_event.source_type",
    landing: "pending-table",
    values: NOTIFICATION_SOURCE_TYPES,
    labels: NOTIFICATION_SOURCE_TYPE_LABELS,
  },
  {
    id: "E31",
    field: "notification_delivery.status",
    landing: "pending-table",
    values: DELIVERY_STATUSES,
    labels: DELIVERY_STATUS_LABELS,
  },
  {
    id: "E32",
    field: "event_outbox.event_type",
    landing: "pending-table",
    values: OUTBOX_EVENT_TYPES,
    labels: OUTBOX_EVENT_TYPE_LABELS,
  },
  {
    id: "E33",
    field: "trigger_config.event",
    landing: "pending-table",
    values: DOMAIN_EVENT_TYPES,
    labels: DOMAIN_EVENT_TYPE_LABELS,
  },
  {
    id: "E34",
    field: "app_user_external_identity.provider",
    landing: "pending-table",
    values: EXTERNAL_PROVIDERS,
    labels: EXTERNAL_PROVIDER_LABELS,
  },
  {
    id: "E35",
    field: "auth_session.auth_via",
    landing: "pending-table",
    values: AUTH_VIAS,
    labels: AUTH_VIA_LABELS,
  },
  {
    id: "E36",
    field: "app_user_external_identity.sync_status",
    landing: "pending-table",
    values: EXTERNAL_SYNC_STATUSES,
    labels: EXTERNAL_SYNC_STATUS_LABELS,
  },
  {
    id: "E37",
    field: "app_user.activation_status",
    landing: "pending-table",
    values: ACTIVATION_STATUSES,
    labels: ACTIVATION_STATUS_LABELS,
  },
];

/**
 * 枚举表 §3 / §4 里**不占 E 行号**但同样要守的结构取值。
 * 单列一份是为了让"注册表覆盖率 37/37"这条断言不被拿来充当全量登记。
 */
export const STRUCT_REGISTRY = [
  {
    key: "activity_log.action",
    values: AUDIT_ACTIONS,
    labels: AUDIT_ACTION_LABELS,
    landing: "pending-table" as const,
  },
  {
    key: "automation_rule.trigger_type",
    values: TRIGGER_TYPES,
    labels: TRIGGER_TYPE_LABELS,
    landing: "pending-table" as const,
  },
  {
    key: "automation_rule.action_type",
    values: ACTION_TYPES,
    labels: ACTION_TYPE_LABELS,
    landing: "pending-table" as const,
  },
  { key: "extra_condition.op(逻辑)", values: LOGIC_OPS, labels: {}, landing: "jsonb 内" as const },
  {
    key: "extra_condition.op(比较)",
    values: COMPARE_OPS,
    labels: COMPARE_OP_LABELS,
    landing: "jsonb 内" as const,
  },
  {
    key: "action_config.receivers",
    values: NOTIFY_RECEIVERS,
    labels: NOTIFY_RECEIVER_LABELS,
    landing: "jsonb 内" as const,
  },
  {
    key: "action_config.mode",
    values: ASSIGN_MODES,
    labels: ASSIGN_MODE_LABELS,
    landing: "jsonb 内" as const,
  },
  {
    key: "action_config.offset_days_from",
    values: OFFSET_DAY_BASES,
    labels: {},
    landing: "jsonb 内" as const,
  },
  {
    key: "update_field.field",
    values: UPDATABLE_FIELDS,
    labels: UPDATABLE_FIELD_LABELS,
    landing: "jsonb 内" as const,
  },
];

export * from "./targets";
export * from "./status";
export * from "./business";
export * from "./notify";
export * from "./auth";
export * from "./audit";
export * from "./automation";

/**
 * 枚举注册表（W0-3）。
 *
 * 本文件不含取值 —— 取值住在各分册里。它只做两件事：
 *   1. 给 E01–E37 每行一个**可被机器核对**的条目（含"这行不是枚举"的情况）；
 *   2. 用 `IN_DB_CHECKS` 记录哪些值域已经进了库、落在哪个约束名上，让
 *      `src/app/lib/server/db/enum-check.spec.ts` 能做**双向**比对：
 *        · 注册表说已进库 ⇒ 迁移里必须找得到该 CHECK 且值集合逐字相等；
 *        · 迁移里出现 `CHECK (col IN (…))` ⇒ 必须被注册表认领。
 *      单向检查会漏掉"直接在迁移里加值域约束却不登记"这一半。
 *
 * 为什么不做 codegen：枚举表 §5.1 明确裁定"CHECK 手写 + 一条一致性测试"，
 * 因为生成器往迁移里插内容会让迁移不再是稳定产物。本文件遵守该裁定。
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

/** 值域在 DB 侧的一个落点：[表, 列, CHECK 约束名] */
export type CheckTarget = readonly [table: string, column: string, name: string];

/**
 * 四种落点状态，故意把 `in-jsonb` 与 `pending-table` 分开：
 *   · `in-db` 有 CHECK 守着，改值要走迁移；
 *   · `pending-table` 表还没建，值域只在代码里；
 *   · `in-jsonb` 表建了但值在 jsonb 内部，**DB 守不住**，只能靠服务层校验 + 单测；
 *   · `not-an-enum` 这一行本来就不是枚举（E01 无此列、E07 布尔）。
 */
export type EnumLanding = "in-db" | "pending-table" | "in-jsonb" | "not-an-enum";

export type EnumEntry = {
  /** 枚举表行号，E01…E37 */
  id: string;
  /** 文档里的字段写法 */
  field: string;
  landing: EnumLanding;
  values: readonly (string | number)[];
  labels: Readonly<Record<string, string>>;
  /** 值域被哪些列共用（同 E03/E06 这类跨列复用），建表时照抄 */
  usedBy?: readonly string[];
  /** `not-an-enum` 的处置说明 */
  note?: string;
  /** 派生字段，来自 `IN_DB_CHECKS`；**不要手写**，写了会与 `landing` 打架并被测试抓住 */
  checks: readonly CheckTarget[];
};

/**
 * **"哪些值域已进库"由这张映射表推导，而不是逐条手写标记。**
 *
 * 理由：手写 `landing: "in-db"` 有两种说谎方式 —— 表建了忘了标，或标了但迁移里没那条约束。
 * 建表是一张一张发生的，改这一处映射比改三十个标记可靠。约束名同时被一致性测试双向认领，
 * 所以拼错名、漏写一张同构表都会当场红（本轮建两张 `*_staff` 时就因只登记一张被反向检查拦下）。
 */
export const IN_DB_CHECKS: Readonly<Record<string, readonly CheckTarget[]>> = {
  E02: [["mn_role", "data_scope", "ck_mn_role_data_scope"]],
  E03: [
    ["mn_activity_log", "target_type", "ck_mn_activity_target_type"],
    ["mn_comment", "target_type", "ck_mn_comment_target_type"],
  ],
  E04: [
    ["mn_matter_staff", "staff_role", "ck_mn_matter_staff_role"],
    ["mn_risk_matter_staff", "staff_role", "ck_mn_risk_matter_staff_role"],
  ],
  E06: [
    ["mn_matter_party", "party_role", "ck_mn_matter_party_role"],
    ["mn_risk_matter_party", "party_role", "ck_mn_risk_matter_party_role"],
  ],
  E08: [["mn_status_config", "host_type", "ck_status_host_type"]],
  E09: [["mn_status_config", "semantics", "ck_status_semantics"]],
  // `mn_tag.host_type` 用同一值域，但枚举表没给它一行 —— 先挂在 E10 下，已回写 §5.1
  E10: [
    ["mn_node_type_config", "host_type", "ck_mn_node_type_host"],
    ["mn_tag", "host_type", "ck_mn_tag_host"],
  ],
  E11: [["mn_node_type_config", "time_type", "ck_mn_node_type_time"]],
  E12: [["mn_matter", "litigation_role", "ck_mn_matter_role"]],
  E13: [["mn_matter", "case_type", "ck_mn_matter_case_type"]],
  E14: [["mn_matter", "procedure", "ck_mn_matter_procedure"]],
  E15: [["mn_risk_matter", "type", "ck_mn_risk_matter_type"]],
  E16: [["mn_risk_matter", "source", "ck_mn_risk_matter_source"]],
  E17: [["mn_party", "type", "ck_mn_party_type"]],
  E18: [["mn_party", "id_type", "ck_mn_party_id_type"]],
  E19: [["mn_matter_progress", "progress_type", "ck_mn_matter_progress_type"]],
  E21: [
    ["mn_matter_node", "status", "ck_mn_matter_node_status"],
    ["mn_risk_matter_node", "status", "ck_mn_risk_matter_node_status"],
  ],
  E22: [
    ["mn_matter_node", "source_kind", "ck_mn_matter_node_source_kind"],
    ["mn_risk_matter_node", "source_kind", "ck_mn_risk_matter_node_source_kind"],
  ],
  E27: [
    ["mn_matter", "currency", "ck_mn_matter_currency"],
    ["mn_risk_matter", "currency", "ck_mn_risk_matter_currency"],
  ],
  E28: [["mn_risk_matter", "conversion_status", "ck_mn_risk_matter_conversion"]],
  E35: [["mn_auth_session", "auth_via", "ck_mn_auth_session_auth_via"]],
  E37: [["mn_app_user", "activation_status", "ck_mn_app_user_activation"]],
};

/** §3 的活动动作同样进了库，但它不占 E 行号，所以另立一份映射 */
export const STRUCT_CHECKS: Readonly<Record<string, readonly CheckTarget[]>> = {
  "activity_log.action": [["mn_activity_log", "action", "ck_mn_activity_action"]],
};

type RawEntry = Omit<EnumEntry, "checks">;

function entry(e: RawEntry): EnumEntry {
  return { ...e, checks: IN_DB_CHECKS[e.id] ?? [] };
}

export const ENUM_REGISTRY: readonly EnumEntry[] = [
  entry({
    id: NO_STATUS_COLUMN.id,
    field: NO_STATUS_COLUMN.field,
    landing: "not-an-enum",
    values: [],
    labels: {},
    note: NO_STATUS_COLUMN.note,
  }),
  entry({
    id: "E02",
    field: "role.data_scope",
    landing: "in-db",
    // 该行的 label 是 `{zh, formula}` 结构，注册表只收展示名（公式给 UI 的说明气泡用）
    labels: Object.fromEntries(DATA_SCOPES.map((v) => [v, DATA_SCOPE_LABELS[v].zh])),
    values: DATA_SCOPES,
    usedBy: ["role.data_scope"],
  }),
  entry({
    id: "E03",
    field: "target_type",
    landing: "in-db",
    values: TARGET_TYPES,
    labels: TARGET_TYPE_LABELS,
    usedBy: ["activity_log.target_type", "comment.target_type"],
  }),
  entry({
    id: "E04",
    field: "*_staff.staff_role",
    landing: "in-db",
    values: STAFF_ROLES,
    labels: STAFF_ROLE_LABELS,
    usedBy: ["matter_staff.staff_role", "risk_matter_staff.staff_role", "action_config.staff_role"],
  }),
  entry({
    id: "E05",
    field: "user_watch.watch_type",
    landing: "pending-table",
    values: WATCH_TYPES,
    labels: WATCH_TYPE_LABELS,
  }),
  entry({
    id: "E06",
    field: "*_party.party_role",
    landing: "in-db",
    values: LITIGATION_ROLES,
    labels: LITIGATION_ROLE_LABELS,
    usedBy: ["matter_party.party_role", "risk_matter_party.party_role"],
  }),
  entry({
    id: REPRESENTED_IS_BOOLEAN.id,
    field: REPRESENTED_IS_BOOLEAN.field,
    landing: "not-an-enum",
    values: [],
    labels: {},
    note: REPRESENTED_IS_BOOLEAN.note,
  }),
  entry({
    id: "E08",
    field: "status_config.host_type",
    landing: "in-db",
    values: HOST_TYPES,
    labels: HOST_TYPE_LABELS,
  }),
  entry({
    id: "E09",
    field: "status_config.semantics",
    landing: "in-db",
    values: STATUS_SEMANTICS,
    labels: STATUS_SEMANTIC_LABELS,
  }),
  entry({
    id: "E10",
    field: "node_type_config.host_type",
    landing: "in-db",
    values: HOST_TYPES,
    labels: HOST_TYPE_LABELS,
  }),
  entry({
    id: "E11",
    field: "node_type_config.time_type",
    landing: "in-db",
    values: TIME_TYPES,
    labels: TIME_TYPE_LABELS,
  }),
  entry({
    id: "E12",
    field: "matter.litigation_role",
    landing: "in-db",
    values: LITIGATION_ROLES,
    labels: LITIGATION_ROLE_LABELS,
  }),
  entry({
    id: "E13",
    field: "matter.case_type",
    landing: "in-db",
    values: CASE_TYPES,
    labels: CASE_TYPE_LABELS,
  }),
  entry({
    id: "E14",
    field: "matter.procedure",
    landing: "in-db",
    values: PROCEDURES,
    labels: PROCEDURE_LABELS,
  }),
  entry({
    id: "E15",
    field: "risk_matter.type",
    landing: "in-db",
    values: RISK_MATTER_TYPES,
    labels: RISK_MATTER_TYPE_LABELS,
  }),
  entry({
    id: "E16",
    field: "risk_matter.source",
    landing: "in-db",
    values: RISK_MATTER_SOURCES,
    labels: RISK_MATTER_SOURCE_LABELS,
  }),
  entry({
    id: "E17",
    field: "party.type",
    landing: "in-db",
    values: PARTY_TYPES,
    labels: PARTY_TYPE_LABELS,
  }),
  entry({
    id: "E18",
    field: "party.id_type",
    landing: "in-db",
    values: ID_TYPES,
    labels: ID_TYPE_LABELS,
  }),
  entry({
    id: "E19",
    field: "matter_progress.progress_type",
    landing: "in-db",
    values: PROGRESS_TYPES,
    labels: PROGRESS_TYPE_LABELS,
  }),
  entry({
    id: "E20",
    field: "matter_expense.status",
    landing: "pending-table",
    values: EXPENSE_STATUSES,
    labels: EXPENSE_STATUS_LABELS,
  }),
  entry({
    id: "E21",
    field: "matter_node.status",
    landing: "in-db",
    values: NODE_STATUSES,
    labels: NODE_STATUS_LABELS,
    usedBy: ["matter_node.status", "risk_matter_node.status"],
  }),
  entry({
    id: "E22",
    field: "*_node.source_kind",
    landing: "in-db",
    values: NODE_SOURCE_KINDS,
    labels: NODE_SOURCE_KIND_LABELS,
  }),
  entry({
    id: "E23",
    field: "custom_reminder.status",
    landing: "pending-table",
    values: REMINDER_STATUSES,
    labels: REMINDER_STATUS_LABELS,
  }),
  entry({
    id: "E24",
    field: "custom_reminder.repeat_type",
    landing: "pending-table",
    values: REPEAT_TYPES,
    labels: REPEAT_TYPE_LABELS,
  }),
  entry({
    id: "E25",
    field: "notify_channel",
    landing: "pending-table",
    values: NOTIFY_CHANNELS,
    labels: NOTIFY_CHANNEL_LABELS,
  }),
  entry({
    id: "E26",
    field: "attachment.category",
    landing: "pending-table",
    values: ATTACHMENT_CATEGORIES,
    labels: ATTACHMENT_CATEGORY_LABELS,
  }),
  entry({
    id: "E27",
    field: "currency",
    landing: "in-db",
    values: CURRENCIES,
    labels: CURRENCY_LABELS,
  }),
  entry({
    id: "E28",
    field: "risk_matter.conversion_status",
    landing: "in-db",
    values: CONVERSION_STATUSES,
    labels: CONVERSION_STATUS_LABELS,
  }),
  entry({
    id: "E29",
    field: "notification_event.event_type",
    landing: "pending-table",
    values: NOTIFICATION_EVENT_TYPES,
    labels: NOTIFICATION_EVENT_TYPE_LABELS,
  }),
  entry({
    id: "E30",
    field: "notification_event.source_type",
    landing: "pending-table",
    values: NOTIFICATION_SOURCE_TYPES,
    labels: NOTIFICATION_SOURCE_TYPE_LABELS,
  }),
  entry({
    id: "E31",
    field: "notification_delivery.status",
    landing: "pending-table",
    values: DELIVERY_STATUSES,
    labels: DELIVERY_STATUS_LABELS,
  }),
  entry({
    id: "E32",
    field: "event_outbox.event_type",
    landing: "pending-table",
    values: OUTBOX_EVENT_TYPES,
    labels: OUTBOX_EVENT_TYPE_LABELS,
  }),
  entry({
    id: "E33",
    field: "trigger_config.event",
    // 落在 `trigger_config` jsonb 内部：建了规则表也守不住，只能服务层校验
    landing: "in-jsonb",
    values: DOMAIN_EVENT_TYPES,
    labels: DOMAIN_EVENT_TYPE_LABELS,
  }),
  entry({
    id: "E34",
    field: "app_user_external_identity.provider",
    landing: "pending-table",
    values: EXTERNAL_PROVIDERS,
    labels: EXTERNAL_PROVIDER_LABELS,
  }),
  entry({
    id: "E35",
    field: "auth_session.auth_via",
    landing: "in-db",
    values: AUTH_VIAS,
    labels: AUTH_VIA_LABELS,
  }),
  entry({
    id: "E36",
    field: "app_user_external_identity.sync_status",
    landing: "pending-table",
    values: EXTERNAL_SYNC_STATUSES,
    labels: EXTERNAL_SYNC_STATUS_LABELS,
  }),
  entry({
    id: "E37",
    field: "app_user.activation_status",
    landing: "in-db",
    values: ACTIVATION_STATUSES,
    labels: ACTIVATION_STATUS_LABELS,
  }),
];

/**
 * 枚举表 §3 / §4 里**不占 E 行号**但同样要守的结构取值。
 * 单列一份是为了让"注册表覆盖 37/37"这条断言不被拿来冒充全量登记。
 */
export const STRUCT_REGISTRY: readonly {
  key: string;
  values: readonly (string | number)[];
  labels: Readonly<Record<string, string>>;
}[] = [
  { key: "activity_log.action", values: AUDIT_ACTIONS, labels: AUDIT_ACTION_LABELS },
  { key: "automation_rule.trigger_type", values: TRIGGER_TYPES, labels: TRIGGER_TYPE_LABELS },
  { key: "automation_rule.action_type", values: ACTION_TYPES, labels: ACTION_TYPE_LABELS },
  { key: "extra_condition.op(逻辑)", values: LOGIC_OPS, labels: {} },
  { key: "extra_condition.op(比较)", values: COMPARE_OPS, labels: COMPARE_OP_LABELS },
  { key: "action_config.receivers", values: NOTIFY_RECEIVERS, labels: NOTIFY_RECEIVER_LABELS },
  { key: "action_config.mode", values: ASSIGN_MODES, labels: ASSIGN_MODE_LABELS },
  { key: "action_config.offset_days_from", values: OFFSET_DAY_BASES, labels: {} },
  { key: "update_field.field", values: UPDATABLE_FIELDS, labels: UPDATABLE_FIELD_LABELS },
];

/** 约束名 → 出处；反向检查用它判断"迁移里有 IN 型 CHECK 却没人认领" */
export function claimedChecks(): Map<
  string,
  { id: string; column: string; values: readonly (string | number)[] }
> {
  const out = new Map<
    string,
    { id: string; column: string; values: readonly (string | number)[] }
  >();
  for (const e of ENUM_REGISTRY)
    for (const [, column, name] of e.checks) out.set(name, { id: e.id, column, values: e.values });
  for (const s of STRUCT_REGISTRY)
    for (const [, column, name] of STRUCT_CHECKS[s.key] ?? [])
      out.set(name, { id: s.key, column, values: s.values });
  return out;
}

export * from "./targets";
export * from "./status";
export * from "./business";
export * from "./notify";
export * from "./auth";
export * from "./audit";
export * from "./automation";

export * from "./scope";

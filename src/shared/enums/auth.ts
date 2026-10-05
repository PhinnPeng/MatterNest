/**
 * 认证与账号状态（枚举表 §2 v3 补登的 E34–E37）。
 * 权威源：`docs/PRD-phase1-enums-and-schemas.md`；决策背景 `docs/tech-stack-decision.md` §3.4 与 §7 假设 F。
 *
 * 这一组分清了三个**互不等价**的状态，混用是本组最大的风险：
 *   · `is_enabled`（布尔，不在本表）—— 账号可用性问题：停用/离职。
 *   · E37 `activation_status` —— 开通问题：云之家首登自动建号后、管理员批准前是 `pending`，
 *     登录返回「等待开通」而**不是**"账号不存在"。
 *   · E36 `sync_status` —— 外部源可见性问题：`unknown` 只代表"这次没查到"，**不得当 `inactive` 处理**，
 *     否则一次网络抖动就把全公司锁在门外（修订稿 §7 假设 F 的原始裁定）。
 * 三条共同点：**都不参与数据范围判定**（范围只看 `role.data_scope` 与归属关系）。
 */

/** E34 `app_user_external_identity.provider`：第一期唯一外部身份源 */
export const EXTERNAL_PROVIDERS = ["yunzhijia"] as const;
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];
export const EXTERNAL_PROVIDER_LABELS: Record<ExternalProvider, string> = { yunzhijia: "云之家" };
/** 云之家身份键是 `eid`/`openId`，存 `external_id`，**不进 `app_user`**（技术选型 §3.4） */
export const EXTERNAL_ID_KINDS: Record<ExternalProvider, readonly ["eid", "openId"]> = {
  yunzhijia: ["eid", "openId"],
};

/** E35 `auth_session.auth_via`：只用于审计与差异化失效策略，**不参与权限判定** */
export const AUTH_VIAS = ["local", "yunzhijia"] as const;
export type AuthVia = (typeof AUTH_VIAS)[number];
export const AUTH_VIA_LABELS: Record<AuthVia, string> = {
  local: "本地密码",
  yunzhijia: "云之家",
};

/** E36 `app_user_external_identity.sync_status`，默认 `unknown` */
export const EXTERNAL_SYNC_STATUSES = ["active", "inactive", "unknown"] as const;
export type ExternalSyncStatus = (typeof EXTERNAL_SYNC_STATUSES)[number];
export const EXTERNAL_SYNC_STATUS_LABELS: Record<ExternalSyncStatus, string> = {
  active: "外部源在职可见",
  inactive: "外部源已不可见",
  unknown: "未同步/同步失败",
};
export const DEFAULT_EXTERNAL_SYNC_STATUS: ExternalSyncStatus = "unknown";
/**
 * 只有 `inactive` 触发回收链路（`is_enabled=false` + 吊销 session + `token_version++`）。
 * 写成显式常量是为了让"把 unknown 当 inactive"这种写法在 review 时无处遁形。
 */
export const REVOKE_TRIGGERS_SYNC_STATUS: ExternalSyncStatus = "inactive";

/** E37 `app_user.activation_status`：默认 `pending` **只适用于云之家首登自动建号路径** */
export const ACTIVATION_STATUSES = ["pending", "active"] as const;
export type ActivationStatus = (typeof ACTIVATION_STATUSES)[number];
export const ACTIVATION_STATUS_LABELS: Record<ActivationStatus, string> = {
  pending: "等待开通",
  active: "已开通",
};
/** 本地密码兜底账号建号即 `active` —— 默认值不适用于它，故单列 */
export const ACTIVATION_STATUS_DEFAULTS: Record<AuthVia, ActivationStatus> = {
  yunzhijia: "pending",
  local: "active",
};
/** 被加进案卷的第三个条件（权限草案 §4.1 收窄裁定）：`pending` 账号不得被选为参与人 */
export const SELECTABLE_ACTIVATION_STATUS: ActivationStatus = "active";

/**
 * 主体与关系（枚举表 §1 的 E02 / E03 / E04 / E05，以及被 E08、E10 共用的 `host_type`）。
 * 权威源：`docs/PRD-phase1-enums-and-schemas.md` §1。
 *
 * 为什么 `HOST_TYPES` 住在这里而不是 `status.ts`：E08（`status_config.host_type`）与
 * E10（`node_type_config.host_type`）是**同一个值域在两列上重复登记**。两处各写一份数组，
 * 就是本票要防的那类漂移（改了 E08 忘了 E10）。⇒ 单实现，`status.ts` 引用它。
 *
 * 中文名口径：文档只给了语义描述、没给短名的，这里用描述性短名并在注释里标出，不伪造"权威叫法"。
 */

/** E02 `role.data_scope`（权限草案 §1；**无 L4**，"仅我创建的"第四档已随 P-1 删除） */
export const DATA_SCOPES = ["all", "participating", "owned"] as const;
export type DataScope = (typeof DATA_SCOPES)[number];
export const DEFAULT_DATA_SCOPE: DataScope = "participating";
/** 权限草案 §1 给的是集合描述而非短名，故 label 取描述缩句，另存 `scope` 便于 UI 直接展示公式 */
export const DATA_SCOPE_LABELS: Record<DataScope, { zh: string; formula: string }> = {
  all: { zh: "全公司", formula: "全公司每一案件/事项" },
  participating: { zh: "我参与的", formula: "我承办的 ∪ 我协办的 ∪ 我被加为关注人的 ∪ 我创建的" },
  owned: { zh: "我承办的", formula: "我承办的 ∪ 我创建的（不含他人加给我的协办/关注）" },
};

/**
 * E03 `target_type`（修订稿 §1.0.2）。
 * 硬口径：**禁止缩写 `risk`**（会指代不清），`case_study` 随案例模块移出第一期。
 */
export const TARGET_TYPES = [
  "matter",
  "risk_matter",
  "matter_node",
  "risk_matter_node",
  "matter_progress",
  "matter_expense",
] as const;
export type TargetType = (typeof TARGET_TYPES)[number];
export const TARGET_TYPE_LABELS: Record<TargetType, string> = {
  matter: "案件",
  risk_matter: "风险事项",
  matter_node: "案件节点",
  risk_matter_node: "事项节点",
  matter_progress: "案件进展",
  matter_expense: "案件费用",
};

/** E04 `*_staff.staff_role`：除 `owner` 外可多行 */
export const STAFF_ROLES = ["owner", "co_owner", "follower"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
/** 权限草案 §2.2 的原词：负责人 / 协办人 / 关注人 */
export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  owner: "负责人",
  co_owner: "协办人",
  follower: "关注人",
};
/** 护栏 1 的归属变更只认这三个动作的主体（权限草案 §2.2） */
export const UNIQUE_STAFF_ROLES: readonly StaffRole[] = ["owner"];

/** E05 `user_watch.watch_type` */
export const WATCH_TYPES = ["follow", "favorite"] as const;
export type WatchType = (typeof WATCH_TYPES)[number];
export const WATCH_TYPE_LABELS: Record<WatchType, string> = {
  follow: "关注",
  favorite: "收藏",
};
/**
 * `follow` 由 `*_staff` 同步生成、`favorite` 仅本人可建（枚举表 E05 说明）。
 * ⇒ `follow` 不接受用户直接写入，这是同步链路的一致性前提。
 */
export const USER_OWNABLE_WATCH_TYPES: readonly WatchType[] = ["favorite"];

/** E08 ∩ E10 共用值域（单一实现） */
export const HOST_TYPES = ["matter", "risk_matter"] as const;
export type HostType = (typeof HOST_TYPES)[number];
export const HOST_TYPE_LABELS: Record<HostType, string> = {
  matter: "案件",
  risk_matter: "风险事项",
};

/** E01 `app_user.status` —— **不存在此列**，用 `is_enabled boolean`。登记是为了防止有人又造一个状态列。 */
export const NO_STATUS_COLUMN = {
  id: "E01",
  field: "app_user.status",
  note: "无此列，用 is_enabled boolean（枚举表 §1 E01）",
} as const;

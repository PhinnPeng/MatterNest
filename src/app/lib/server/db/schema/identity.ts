/**
 * 身份与权限（W1-4 的认证三表 + 角色表）。
 * 出处：权限草案 §1/§2.1（三档范围 + 4 特权）、技术选型 §3.4（双通道，一期只落本地密码通道）、
 * 枚举表 E02/E35/E37。
 *
 * 两条实现约束值得写在代码旁边：
 *   · 口令只存 `scrypt`（node:crypto 默认参数），**明文与 hash 都绝不进日志**；
 *     云之家通道的 `app_user_external_identity` 一期不建（N6 未验，见落地方案 G1）。
 *   · session 走服务端表 + `token_hash`（sha256）+ httpOnly cookie，
 *     因为 Next 没有第一方 session（技术选型 §13.2 继承的 C4 结论）。
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { DATA_SCOPES } from "@/shared/enums";
import { AUTH_VIAS, ACTIVATION_STATUSES } from "@/shared/enums/auth";
import { auditColumns, createdOnlyColumns, fk, id } from "./common";
import { sqlInList } from "./ddl";

/** `mn_role`：权限草案 §2.1 的 5 角色 + 4 个特权开关 */
export const role = pgTable(
  "mn_role",
  {
    id: id(),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 50 }).notNull(),
    /** E02 三档数据范围；`all` = L1、`participating` = L2、`owned` = L3 */
    dataScope: varchar("data_scope", { length: 20 }).notNull().default("participating"),
    canUnarchive: boolean("can_unarchive").notNull().default(false),
    canReadPlain: boolean("can_read_plain").notNull().default(false),
    canManageUser: boolean("can_manage_user").notNull().default(false),
    canManageConfig: boolean("can_manage_config").notNull().default(false),
    /** true = seed 内置角色，不可删（权限草案 §2.1） */
    isSystem: boolean("is_system").notNull().default(false),
    isEnabled: boolean("is_enabled").notNull().default(true),
    ...createdOnlyColumns,
  },
  (t) => [
    uniqueIndex("uk_mn_role_code").on(t.code),
    index("ix_mn_role_scope").on(t.dataScope),
    // 一期只 5 个角色且要防"改完 code 让 seed 引用断掉"，故值域钉 CHECK（E02）
    check("ck_mn_role_data_scope", sqlInList("data_scope", DATA_SCOPES)),
  ],
);

/** E37 `app_user.activation_status`：云之家首登自动建号才落 `pending`，本地账号建号即 `active` */
export const appUser = pgTable(
  "mn_app_user",
  {
    id: id(),
    username: varchar("username", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 50 }).notNull(),
    /** 本地密码通道的 scrypt 摘要（`salt:hash`，hex）；外部身份账号可为空 */
    passwordHash: varchar("password_hash", { length: 256 }),
    /** 可用性：离职/停用即 false（与 E37 的"未开通"正交，两者都不参与数据范围判定） */
    isEnabled: boolean("is_enabled").notNull().default(true),
    /**
     * 权限草案 §3：**独立于角色的最后开关**，只绕过数据范围，不给任何特权。
     * 存在的理由是"误删角色导致无人可管"这个逃生口 —— 所以第一期就要有列，
     * 且只给 1–2 个账号（seed 里是总经理）。判定见 `scope/visibility.ts` 的第一行短路。
     */
    isAdmin: boolean("is_admin").notNull().default(false),
    activationStatus: varchar("activation_status", { length: 16 }).notNull().default("active"),
    /** 吊销全部会话用（离职回收链路，权限草案 §5） */
    tokenVersion: fk("token_version")
      .notNull()
      .default(sql`1`),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "string" }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("uk_mn_app_user_username").on(t.username),
    check("ck_mn_app_user_activation", sqlInList("activation_status", ACTIVATION_STATUSES)),
  ],
);

/**
 * `mn_app_user_role`：用户 ↔ 角色 的多对多。
 *
 * 这张表是我第一版**漏掉的**：当时按"一个用户一个角色"写了 `app_user.role_id`，
 * 读到权限草案 §2 的"给他 `sys_admin` + `full_admin` 两个角色，靠取最宽并集生效"才发现建模错了 ——
 * 单值外网关不掉"兼两个角色"这个被文档点名的场景，且并集口径无处落地。
 */
export const appUserRole = pgTable(
  "mn_app_user_role",
  {
    id: id(),
    userId: fk("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    roleId: fk("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "restrict" }),
    ...createdOnlyColumns,
  },
  (t) => [
    uniqueIndex("uk_mn_app_user_role").on(t.userId, t.roleId),
    // 解析会话权限时按 user 取全部角色，这张索引就是热路径
    index("ix_mn_app_user_role_user").on(t.userId),
  ],
);

/** `mn_auth_session`：服务端会话；cookie 里只放随机 token，DB 存其 sha256 */
export const authSession = pgTable(
  "mn_auth_session",
  {
    id: id(),
    userId: fk("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    /** E35：只用于审计与失效策略差异，不参与权限判定 */
    authVia: varchar("auth_via", { length: 16 }).notNull().default("local"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    userAgent: text("user_agent"),
    ...createdOnlyColumns,
  },
  (t) => [
    uniqueIndex("uk_mn_auth_session_token").on(t.tokenHash),
    index("ix_mn_auth_session_user").on(t.userId, t.expiresAt),
    check("ck_mn_auth_session_auth_via", sqlInList("auth_via", AUTH_VIAS)),
  ],
);

/** 类型别名：给服务层与 DTO 边界用（DTO 出 string，见 master P1-19） */
export type RoleRow = typeof role.$inferSelect;
export type AppUserRow = typeof appUser.$inferSelect;

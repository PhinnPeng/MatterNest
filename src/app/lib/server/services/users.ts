import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { activityLog, appUser, appUserRole, authSession, role } from "../db/schema";
import { hashPassword, type Actor } from "../auth/auth";
import { nextId } from "@/shared/ids/snowflake";

/**
 * 账号与角色（MATT-10 / PRD F6-1 启停、F6-5 角色授予、F6-9 本地凭据、F6-11 待开通队列）。
 *
 * ## 三条硬约束（都写在票面上，不是风格）
 *
 * 1. **禁自助提权**：改**自己**的角色必须失败。这是权限模型里唯一"自己给自己开门"的路径，
 *    必须由服务端拒，不能只在下拉里藏——藏起来的下拉挡不住一次构造好的请求。
 * 2. **不得提供裸的用户列表接口**。§4.1 收窄之后，能列出全部在册同事就等于拿到一份花名册；
 *    所以本模块的读入口一律要求 `canManageUser`，且**不返回**证件号/手机号之类的敏感列
 *    （那些在 `mn_party`，与本表无关）。参与人选择面走 `selectable-users` 那条带宿主上下文的路。
 * 3. **软删账号不得被派活**（§4.1 成文于软删出现之前）。本模块的写路径挡住 `is_deleted`
 *    的账号；**"可派活集合"那个谓词不在这里**——`selectable-users.ts` 已经有同一套
 *    （`isEnabled && activationStatus='active' && !isDeleted`，外加共现收窄），
 *    在这里再写一遍就是第二份实现，而两份谓词会各自漂移：漂移了不会报错，
 *    只会让某个离职的人重新出现在下拉里。要"全体在册可用用户"（MATT-49 的创建期例外）
 *    时去扩那一份。
 *
 * ## 为什么启停要挡三类对象
 *
 * · **系统所有者**：MATT-53 把"凭据生命线"放在这个人身上，停掉他 = 系统再也无法恢复。
 *   拒绝要给**可区分的错误码**（`system_owner_protected`），不能与"没权限"混成一句话。
 * · **自己**：停自己 = 把自己锁在门外，且这个动作没有撤销入口（得别人来开）。
 * · **已经软删的账号**：`is_deleted` 是死列，本模块不复活它，也不对软删行做启停。
 */

/**
 * 账号启停 / 所有者移交的拒绝原因。分开列出来而不是并成一个布尔：
 * 前端要能逐条说清"为什么不行"，而"动的是凭据生命线"与"你动的是自己"是两回事。
 */
export type EnableBlocker =
  | "system_owner_protected"
  | "self_disable"
  | "deleted_account"
  /** 受让人被停用：不能把生命线交给一个登不进来的人 */
  | "disabled_account"
  /** 受让人还是"待开通"（E37 pending）：同上 */
  | "not_activated";

export type UserRow = {
  id: string;
  username: string;
  displayName: string;
  isEnabled: boolean;
  isAdmin: boolean;
  isSystemOwner: boolean;
  activationStatus: string;
  /** 有没有可用口令（**只给布尔**：摘要本身永不出服务端） */
  hasCredential: boolean;
  lastLoginAt: string | null;
  roleIds: string[];
  roleCodes: string[];
};

export type RoleRow = {
  id: string;
  code: string;
  name: string;
  dataScope: string;
  canUnarchive: boolean;
  canReadPlain: boolean;
  canManageUser: boolean;
  canManageConfig: boolean;
  isSystem: boolean;
};

/** 角色字典：授予界面要用（只出启用中的角色） */
export async function listRoles(): Promise<RoleRow[]> {
  const db = await getDb();
  const rows = await db.select().from(role).where(eq(role.isEnabled, true)).orderBy(asc(role.id));
  return rows.map((r) => ({
    id: String(r.id),
    code: r.code,
    name: r.name,
    dataScope: r.dataScope,
    canUnarchive: r.canUnarchive,
    canReadPlain: r.canReadPlain,
    canManageUser: r.canManageUser,
    canManageConfig: r.canManageConfig,
    isSystem: r.isSystem,
  }));
}

/**
 * 账号列表。**调用方必须先过 `canManageUser`**（路由层用 `requirePrivilege`）。
 *
 * 角色用一次 `inArray` 批量取再在内存里归并，不写成 N+1：十人组织现在看不出差别，
 * 但"列表页每行一次查询"这种形状一旦定型，加人时没人会回头改。
 */
export async function listUsers(): Promise<UserRow[]> {
  const db = await getDb();
  const users = await db
    .select({
      id: appUser.id,
      username: appUser.username,
      displayName: appUser.displayName,
      isEnabled: appUser.isEnabled,
      isAdmin: appUser.isAdmin,
      isSystemOwner: appUser.isSystemOwner,
      activationStatus: appUser.activationStatus,
      // 口令摘要永不出服务端：这里只投影"有没有"，`password_hash` 本身不进 DTO
      hasCredential: sql<boolean>`(${appUser.passwordHash} is not null)`,
      lastLoginAt: appUser.lastLoginAt,
    })
    .from(appUser)
    .orderBy(asc(appUser.username));

  const ids = users.map((u) => u.id);
  const grants = ids.length
    ? await db
        .select({ userId: appUserRole.userId, roleId: role.id, code: role.code })
        .from(appUserRole)
        .innerJoin(role, eq(role.id, appUserRole.roleId))
        .where(inArray(appUserRole.userId, ids))
    : [];

  return users.map((u) => {
    const mine = grants.filter((g) => g.userId === u.id);
    return {
      id: String(u.id),
      username: u.username,
      displayName: u.displayName,
      isEnabled: u.isEnabled,
      isAdmin: u.isAdmin,
      isSystemOwner: u.isSystemOwner,
      activationStatus: u.activationStatus,
      hasCredential: u.hasCredential === true,
      lastLoginAt: u.lastLoginAt,
      roleIds: mine.map((g) => String(g.roleId)),
      roleCodes: mine.map((g) => g.code),
    };
  });
}

/** 待开通队列（F6-11）：`activation_status='pending'` 的账号 */
export async function listPendingUsers(): Promise<UserRow[]> {
  const all = await listUsers();
  return all.filter((u) => u.activationStatus === "pending");
}

export type WriteResult =
  | { ok: true }
  | { ok: false; why: "not_found" }
  | { ok: false; why: "self_escalation" }
  /** 只有系统所有者能做的事（F6-9 凭据、所有者移交） */
  | { ok: false; why: "not_system_owner" }
  | { ok: false; why: "blocked"; blockers: EnableBlocker[] }
  | { ok: false; why: "role_not_found"; missing: string[] };

/** 目标账号的存在性 + 启停护栏（写路径共用） */
async function loadTarget(userId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      id: appUser.id,
      isSystemOwner: appUser.isSystemOwner,
      isDeleted: appUser.isDeleted,
      isEnabled: appUser.isEnabled,
      activationStatus: appUser.activationStatus,
    })
    .from(appUser)
    .where(eq(appUser.id, BigInt(userId)))
    .limit(1);
  return row ?? null;
}

/**
 * 角色授予 / 撤销（F6-5）。**整体替换**而不是增量：界面是一次多选提交，
 * 增量语义会让"取消勾选"与"没提交"变成两件分不清的事。
 *
 * 拒自己的理由见文件头。注意**这里只挡"改自己的角色"**：给别人改角色是本职。
 */
export async function setUserRoles(
  actor: Actor,
  userId: string,
  roleIds: string[],
): Promise<WriteResult> {
  // 禁自助提权：服务端拒，不靠界面藏
  if (userId === actor.userId) return { ok: false, why: "self_escalation" };

  const db = await getDb();
  const target = await loadTarget(userId);
  if (!target) return { ok: false, why: "not_found" };

  // 角色必须真实存在且启用中：不校验的话会建出指向停用角色的授权行
  const wanted = roleIds.length
    ? await db
        .select({ id: role.id })
        .from(role)
        .where(
          and(
            inArray(
              role.id,
              roleIds.map((r) => BigInt(r)),
            ),
            eq(role.isEnabled, true),
          ),
        )
    : [];
  if (wanted.length !== roleIds.length) {
    const have = new Set(wanted.map((w) => String(w.id)));
    return { ok: false, why: "role_not_found", missing: roleIds.filter((r) => !have.has(r)) };
  }

  const before = await db
    .select({ roleId: appUserRole.roleId })
    .from(appUserRole)
    .where(eq(appUserRole.userId, BigInt(userId)));

  await db.transaction(async (tx) => {
    await tx.delete(appUserRole).where(eq(appUserRole.userId, BigInt(userId)));
    if (roleIds.length) {
      await tx.insert(appUserRole).values(
        roleIds.map((rid, i) => ({
          id: BigInt(nextId()) + BigInt(i),
          userId: BigInt(userId),
          roleId: BigInt(rid),
        })),
      );
    }
    // 审计：`ROLE_CHANGED` 的文档口径是「唯一允许记录范围类旧值的 action」，所以
    // old/new 都记（旧值正是"他原来是什么范围"，是复盘时最需要的一格）。
    await tx.insert(activityLog).values({
      id: BigInt(nextId()),
      operatorId: BigInt(actor.userId),
      targetType: "app_user",
      targetId: BigInt(userId),
      action: "ROLE_CHANGED",
      payload: {
        role_ids: roleIds,
        old: { role_ids: before.map((b) => String(b.roleId)) },
        new: { role_ids: roleIds },
      },
    });
  });
  return { ok: true };
}

/**
 * 账号启停（F6-1）。三类对象挡住，理由见文件头。
 *
 * 停用**同时吊销该账号的全部会话**：只翻 `is_enabled` 而不动会话，等于"离职了但手上那张
 * 工牌还能刷到 8 小时后"——`readActor` 每请求重判 is_enabled 确实会拦住，但把会话留着
 * 是没必要的残面（§5 失效链路写的是"停用 + 吊销 session"）。
 */
export async function setUserEnabled(
  actor: Actor,
  userId: string,
  enabled: boolean,
): Promise<WriteResult> {
  const db = await getDb();
  const target = await loadTarget(userId);
  if (!target) return { ok: false, why: "not_found" };

  const blockers: EnableBlocker[] = [];
  if (!enabled) {
    // 系统所有者不可被停用：停掉他 = 系统再也无法恢复（MATT-53 的凭据生命线）
    if (target.isSystemOwner) blockers.push("system_owner_protected");
    if (userId === actor.userId) blockers.push("self_disable");
    if (target.isDeleted) blockers.push("deleted_account");
  }
  if (blockers.length) return { ok: false, why: "blocked", blockers };
  if (target.isEnabled === enabled) return { ok: true }; // 幂等：同值不写审计（避免刷噪声）

  await db.transaction(async (tx) => {
    await tx
      .update(appUser)
      .set({
        isEnabled: enabled,
        updatedBy: BigInt(actor.userId),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(appUser.id, BigInt(userId)));
    if (!enabled) {
      // 停用即吊销全部会话（§5 失效链路）
      await tx.delete(authSession).where(eq(authSession.userId, BigInt(userId)));
    }
    await tx.insert(activityLog).values({
      id: BigInt(nextId()),
      operatorId: BigInt(actor.userId),
      targetType: "app_user",
      targetId: BigInt(userId),
      action: "USER_STATUS_CHANGED",
      payload: { is_enabled: { from: target.isEnabled, to: enabled } },
    });
  });
  return { ok: true };
}

/**
 * 批准待开通并当场指定角色（F6-11）。`pending → active` 与角色授予**同一事务**：
 * 分开提交会留下"开通了但没有任何角色"的账号，而 `readActor` 对无角色者返回 null
 * ——那人能登录却什么都看不到，报障时最难查。
 */
export async function approveUser(
  actor: Actor,
  userId: string,
  roleIds: string[],
): Promise<WriteResult> {
  if (userId === actor.userId) return { ok: false, why: "self_escalation" };
  const db = await getDb();
  const target = await loadTarget(userId);
  if (!target) return { ok: false, why: "not_found" };

  const wanted = roleIds.length
    ? await db
        .select({ id: role.id })
        .from(role)
        .where(
          and(
            inArray(
              role.id,
              roleIds.map((r) => BigInt(r)),
            ),
            eq(role.isEnabled, true),
          ),
        )
    : [];
  if (wanted.length !== roleIds.length) {
    const have = new Set(wanted.map((w) => String(w.id)));
    return { ok: false, why: "role_not_found", missing: roleIds.filter((r) => !have.has(r)) };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(appUser)
      .set({
        activationStatus: "active",
        isEnabled: true,
        updatedBy: BigInt(actor.userId),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(appUser.id, BigInt(userId)));
    await tx.delete(appUserRole).where(eq(appUserRole.userId, BigInt(userId)));
    if (roleIds.length) {
      await tx.insert(appUserRole).values(
        roleIds.map((rid, i) => ({
          id: BigInt(nextId()) + BigInt(i),
          userId: BigInt(userId),
          roleId: BigInt(rid),
        })),
      );
    }
    // 载荷按 §3.3 的 USER_ACTIVATED 行：`{external_id, provider, role_ids}`。
    // 本地通道没有 external_id/provider，落 null 而不是编一个假值——审计里假值比空值危险。
    await tx.insert(activityLog).values({
      id: BigInt(nextId()),
      operatorId: BigInt(actor.userId),
      targetType: "app_user",
      targetId: BigInt(userId),
      action: "USER_ACTIVATED",
      payload: { external_id: null, provider: "local", role_ids: roleIds },
    });
  });
  return { ok: true };
}

/**
 * 本地凭据设置 / 重置（F6-9）。
 *
 * **仅系统所有者**——这不是"再加一道权限"，是 MATT-53 裁定的落点：账号收敛到只剩一个
 * `admin` 之后，不另设兜底账号，凭据生命线由 `is_system_owner` 持有。F6-9 的原文写的是
 * "仅 `sys_admin` 与兜底账号可开通"，而兜底账号这条已经被裁定撤掉，所以判定改为
 * **系统所有者**；`sys_admin` 的 `canManageUser` 管的是"改角色/启停"，不含凭据。
 *
 * 口令策略按 F6-9：至少 8 位。**不做复杂度规则**——十人内部工具，复杂度规则换来的是
 * 贴在显示器上的便签；真正把风险压下去的是"只有一个人能设"与"摘要不进日志"。
 *
 * 重置**不吊销目标账号的现有会话**：那是"改自己的口令顺手把别人踢下线"的越权副作用。
 * 要踢人走 `setUserEnabled(false)`（它吊销会话），两个动作各自可解释。
 */
export const MIN_PASSWORD_LENGTH = 8;

export type CredentialResult =
  { ok: true } | { ok: false; why: "not_found" | "not_system_owner" | "too_short" };

export async function setUserCredential(
  actor: Actor,
  userId: string,
  password: string,
): Promise<CredentialResult> {
  if (!actor.isSystemOwner) return { ok: false, why: "not_system_owner" };
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, why: "too_short" };

  const db = await getDb();
  const [target] = await db
    .select({
      id: appUser.id,
      username: appUser.username,
      hasCredential: sql<boolean>`(${appUser.passwordHash} is not null)`,
    })
    .from(appUser)
    .where(eq(appUser.id, BigInt(userId)))
    .limit(1);
  if (!target) return { ok: false, why: "not_found" };

  // 摘要的派生口径只有 `auth.hashPassword` 一处（scrypt + salt=用户名）。
  // 在这里再写一遍 salt 规则，就是第二份实现——哪天 auth 改了，两处会静默不一致。
  const hash = hashPassword(password, target.username);
  await db.transaction(async (tx) => {
    await tx
      .update(appUser)
      .set({
        passwordHash: hash,
        updatedBy: BigInt(actor.userId),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(appUser.id, BigInt(userId)));
    await tx.insert(activityLog).values({
      id: BigInt(nextId()),
      operatorId: BigInt(actor.userId),
      targetType: "app_user",
      targetId: BigInt(userId),
      action: "CREDENTIAL_CHANGED",
      // **绝不记口令或摘要**（logging-guidelines 的既有禁令）。
      // mode 区分"首次设置"与"重置"——复盘时这两件事的含义不同。
      payload: { mode: target.hasCredential ? "reset" : "set", self: userId === actor.userId },
    });
  });
  return { ok: true };
}

/**
 * 移交系统所有者（MATT-53 移交过来的一条硬要求）。
 *
 * ## 为什么必须有这条路
 *
 * 「系统所有者不可被停用」只堵住了**出路**，而票面紧接着写的是「**移交是唯一出路**」——
 * 只堵不移交，结果就是所有者这个位置永远锁在一个人身上：他离职、失联、或就是想换人，
 * 都没有路可走（直接改库不算路）。
 *
 * ## 四条实现口径
 *
 * 1. **仅当前所有者可发起**。这不是 `canManageUser` 能做的事：持"管理账号"的人能改角色、
 *    能启停，但凭据生命线的交接是**身份本身的转移**，不是权限操作。
 * 2. **同一事务里先清旧、再授新**。`uk_mn_app_user_owner` 是 **partial unique index**
 *    （全局至多一行为 true），"同时为真"会撞索引——那是**预期行为**，不是 bug，
 *    也正是它让"全局仅一人"这条硬不变式不依赖应用层。顺序写反（先授新）会当场撞索引，
 *    而不是悄悄出现两个所有者。
 * 3. **受让人必须在册且已开通**：软删/停用/待开通的账号不能拿生命线——把恢复能力交给
 *    一个登不进来的人，等于把系统锁在一个更糟的位置上。
 * 4. **审计用 `ROLE_CHANGED`**（票面指定用这个已存在的动作）。载荷保留该动作文档口径里的
 *    `old`/`new` 结构，只把内容换成所有者交接的事实——形状一致，读日志的人不必先分辨
 *    "这条 ROLE_CHANGED 是哪种"。
 */
export async function transferSystemOwnership(
  actor: Actor,
  toUserId: string,
): Promise<WriteResult> {
  if (!actor.isSystemOwner) return { ok: false, why: "not_system_owner" };

  const db = await getDb();
  const target = await loadTarget(toUserId);
  if (!target) return { ok: false, why: "not_found" };

  const blockers: EnableBlocker[] = [];
  if (target.isDeleted) blockers.push("deleted_account");
  if (!target.isEnabled) blockers.push("disabled_account");
  if (target.activationStatus !== "active") blockers.push("not_activated");
  if (blockers.length) return { ok: false, why: "blocked", blockers };

  // 已经是持有人：幂等成功，不写审计（别把"点了一下"记成一次交接）
  if (target.isSystemOwner) return { ok: true };

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    // ⚠ 顺序不能反：先清旧，再授新（partial unique index 只允许一行 true）
    await tx
      .update(appUser)
      .set({ isSystemOwner: false, updatedBy: BigInt(actor.userId), updatedAt: now })
      .where(and(eq(appUser.isSystemOwner, true), eq(appUser.id, BigInt(actor.userId))));
    await tx
      .update(appUser)
      .set({ isSystemOwner: true, updatedBy: BigInt(actor.userId), updatedAt: now })
      .where(eq(appUser.id, BigInt(toUserId)));

    await tx.insert(activityLog).values({
      id: BigInt(nextId()),
      operatorId: BigInt(actor.userId),
      targetType: "app_user",
      targetId: BigInt(toUserId),
      action: "ROLE_CHANGED",
      payload: {
        old: { system_owner_user_id: actor.userId },
        new: { system_owner_user_id: toUserId },
      },
    });
  });
  return { ok: true };
}

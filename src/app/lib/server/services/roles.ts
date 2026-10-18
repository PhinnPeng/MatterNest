import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { appUser, appUserRole, role } from "../db/schema";

/**
 * 角色权限页的读出口（MATT-100，**只读**）。
 *
 * ## 为什么单独一个服务文件，而不是往 `services/users.ts` 里加一个函数
 *
 * `users.ts` 是**账号管理**的服务（启停、角色授予、凭据、所有者移交），
 * 它的文件头写着一条硬约束：**本模块的读入口一律要求 `canManageUser`**。
 * 而本票的读出口恰好要把门**分成两档**（角色定义登录即可读、成员清单才要 `canManageUser`），
 * 塞进 `users.ts` 会让那条"一律"的注释变成假话 —— 下一个读它的人会以为整模块都是严门。
 * 两个不同的读语义住两个文件，各自的头注才不互相污染。
 *
 * ## 数据源
 *
 * · `mn_role`：5 个内置角色（seed `0001_identity.sql`），出 code / name / dataScope /
 *   四项特权 / isSystem。
 * · `mn_app_user_role` ⋈ `mn_app_user`：持有人（**关系表叫 `mn_app_user_role`，
 *   不叫 `mn_role_join`** —— 那个名字只存在于本票的票面文字里，
 *   `src/app/lib/server/db/schema/identity.ts` 是权威）。
 *
 * ## 两个刻意不做的翻译
 *
 * 1. **`dataScope` 原样出 code**（`all` / `participating` / `owned`），不在这里拼中文。
 *    中文只在页面走 `DATA_SCOPE_LABELS`（`shared/enums/targets.ts`）——那是唯一那份字典，
 *    服务层再抄一份就是第二份，改了别处它不会跟着动（票面明令）。
 * 2. **不做 `isEnabled` 过滤之外的取舍**：与 `users.ts:listRoles()` 同一口径
 *    （只出启用中的角色、按 id 升序）。停用的角色不出现在角色表里 ——
 *    它与"授予界面能选的角色"必须是同一个集合，否则授予端能选的与这一页列出的会对不上。
 */

/** `mn_role` 传给投影函数的输入形状（纯数据，便于离线单测）。 */
export type RoleSeed = {
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

/** 一条「谁持有什么角色」的授予行（投影函数的输入）。 */
export type RoleGrantRow = {
  roleId: string;
  userId: string;
  username: string;
  displayName: string;
};

/** 角色成员摘要：只带定位一个人的最小三列。**不含**凭据/最后登录等账号列。 */
export type RoleMember = { id: string; username: string; displayName: string };

/**
 * 一个角色在接口里的形状。
 *
 * `members` 是 `RoleMember[] | null`：**`null` 与 `[]` 不是一回事** ——
 * `null` = "你没有看成员清单的权限"（无 `canManageUser`），
 * `[]` = "你看得到成员清单，但这个角色确实没人持有"。
 * 页面靠这个区分说两种话：前者只写计数并说明为什么看不到名单，后者才是空态。
 */
export type RoleDetail = RoleSeed & {
  holderCount: number;
  members: RoleMember[] | null;
};

/**
 * 把「角色清单 + 授予行」投影成接口形状（**纯函数，不连库**）。
 *
 * 计数与成员都**按角色归并**：同一个人持两个角色时，两个角色各数他一次 ——
 * 这正是 seed 里 `admin` 同时持 `sys_admin` + `full_admin` 时要看到的 1 / 1，
 * 而不是"按人去重后某个角色变成 0"。
 *
 * `includeMembers` 是**唯一**由权限门控制的参数：false 时成员清单换成 `null`，
 * 其余字段逐字不动。这样"收窄"与"翻译"两件事在类型上就分开了 ——
 * 权限门不可能顺手改了角色定义。
 */
export function projectRoleDetails(
  roles: readonly RoleSeed[],
  grants: readonly RoleGrantRow[],
  opts: { includeMembers: boolean },
): RoleDetail[] {
  return roles.map((r) => {
    const held = grants.filter((g) => g.roleId === r.id);
    return {
      ...r,
      holderCount: held.length,
      members: opts.includeMembers
        ? held.map((g) => ({ id: g.userId, username: g.username, displayName: g.displayName }))
        : null,
    };
  });
}

/**
 * 角色清单 + 持有人数（+ 可选成员清单）。
 *
 * **调用方必须先决定 `includeMembers`**（路由层用 `actor.privileges.canManageUser`）：
 * 服务层不读会话 —— 那是第二条鉴权路径，禁令⑤ 要的是"每个 handler 内部自己判权限"。
 *
 * 两次查询再在内存里归并，与 `users.ts:listUsers()` 同一形状：十人组织看不出差别，
 * 但"每行一次查询"这种形状一旦定型，加人时没人会回头改。
 */
export async function listRoleDetails(opts: { includeMembers: boolean }): Promise<RoleDetail[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: role.id,
      code: role.code,
      name: role.name,
      dataScope: role.dataScope,
      canUnarchive: role.canUnarchive,
      canReadPlain: role.canReadPlain,
      canManageUser: role.canManageUser,
      canManageConfig: role.canManageConfig,
      isSystem: role.isSystem,
    })
    .from(role)
    .where(eq(role.isEnabled, true))
    .orderBy(asc(role.id));

  const seeds: RoleSeed[] = rows.map((r) => ({
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

  // 无权限者根本不需要查成员 —— 少一次全表读，也少一个"查了但没给"的中间态。
  const grants: RoleGrantRow[] = opts.includeMembers ? await loadGrants() : [];
  return projectRoleDetails(seeds, grants, opts);
}

/** 全部授予行（含账号名）。只在需要成员清单时调用。 */
async function loadGrants(): Promise<RoleGrantRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      roleId: appUserRole.roleId,
      userId: appUser.id,
      username: appUser.username,
      displayName: appUser.displayName,
    })
    .from(appUserRole)
    .innerJoin(appUser, eq(appUser.id, appUserRole.userId))
    .orderBy(asc(appUser.username));

  return rows.map((r) => ({
    roleId: String(r.roleId),
    userId: String(r.userId),
    username: r.username,
    displayName: r.displayName,
  }));
}

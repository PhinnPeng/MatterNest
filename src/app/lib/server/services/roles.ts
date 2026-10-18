import { asc, count as dcount, eq } from "drizzle-orm";
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
 * 把「角色清单 + 计数 + 可选成员清单」投影成接口形状（**纯函数，不连库**）。
 *
 * 计数与成员都**按角色归并**：同一个人持两个角色时，两个角色各数他一次 ——
 * 这正是 seed 里 `admin` 同时持 `sys_admin` + `full_admin` 时要看到的 1 / 1，
 * 而不是"按人去重后某个角色变成 0"。
 *
 * ## 计数与成员是**两个独立输入**，不是一份数据的两种投影（2026-10-18 更正）
 *
 * 初版写成 `(roles, grants, { includeMembers })`：一份 `grants` 既算计数又出名单，
 * 无权限时把 `grants` 传成 `[]`。**那是个真缺陷** —— 计数也一起变 0，
 * 于是无 `canManageUser` 的用户看到「5 个角色，共 0 人持有」，
 * 而票面明写"看不到成员时**只给计数**"。实机验出来的（两个账号对撞，非单测）：
 *
 * | 账号 | 计数 | 名单 |
 * |---|---|---|
 * | `sys_admin`（有 `canManageUser`） | 2 | admin + 临时账号 |
 * | `full_admin`（无） | **0** ← 应为 2 | 只给计数 |
 *
 * 单测没抓到，是因为它把 `GRANTS` 直接喂进纯函数 —— 纯函数**从来没坏过**，
 * 坏的是"无权限就整个不查"这个接线。所以修法是把两个输入在类型上分开：
 * 计数**必给**、名单**可为 null**，接线层就不可能再把计数连坐掉。
 *
 * `members === null` = 没有看名单的权限（`[]` = 看得到但确实没人持有）。
 */
export function projectRoleDetails(
  roles: readonly RoleSeed[],
  holderCounts: ReadonlyMap<string, number>,
  members: ReadonlyMap<string, readonly RoleMember[]> | null,
): RoleDetail[] {
  return roles.map((r) => ({
    ...r,
    // 计数不指名道姓，所以任何登录用户都拿得到；与名单是两条独立的输入
    holderCount: holderCounts.get(r.id) ?? 0,
    members: members ? [...(members.get(r.id) ?? [])] : null,
  }));
}

/**
 * 角色清单 + 持有人数（+ 可选成员清单）。
 *
 * **调用方必须先决定 `includeMembers`**（路由层用 `actor.privileges.canManageUser`）：
 * 服务层不读会话 —— 那是第二条鉴权路径，禁令⑤ 要的是"每个 handler 内部自己判权限"。
 *
 * ## 三次查询，其中两次是刻意的（2026-10-18 更正）
 *
 * · **角色行**：5 行，必查；
 * · **计数**：`group by role_id, count(*)`，**必查、且只出数字**（不带用户名）。
 *   计数不指名道姓，所以无 `canManageUser` 的人也拿得到 —— 这正是票面"只给计数"那一档。
 * · **成员名单**：只带 `includeMembers` 时查。它出的是**人名**，是"人的信息"那一档。
 *
 * 把计数与名单拆成两次查询是**有意的**，不是懒得合并：合并成一次（像初版那样）
 * 会让"无权限"顺手把计数也连坐掉，而那是一个真出过的缺陷（见 `projectRoleDetails` 的头注）。
 * 拆开之后下一个人想"省一次查询"时，会先撞上一句说明为什么不能合。
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

  // 两次查询并发：两者互不依赖，串起来只是白等一个往返
  const [counts, members] = await Promise.all([
    loadHolderCounts(),
    opts.includeMembers ? loadMembers() : Promise.resolve(null),
  ]);
  return projectRoleDetails(seeds, counts, members);
}

/**
 * 每个角色的持有**人数**（`group by role_id`）。
 *
 * 刻意不 select 用户名：这一条要在无 `canManageUser` 时也能跑，
 * 而"能跑"与"能读名字"是两件事 —— 只出数字的那条查询不该有读名字的能力。
 */
async function loadHolderCounts(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db
    .select({ roleId: appUserRole.roleId, n: dcount() })
    .from(appUserRole)
    .groupBy(appUserRole.roleId);
  return new Map(rows.map((r) => [String(r.roleId), Number(r.n)]));
}

/**
 * 每个角色的成员清单（含账号名）。
 *
 * **只在 `includeMembers` 为真时调用** —— 这张表出的每一列都在指认一个人。
 * 与 `listUsers()` 同一道门（`canManageUser`）。
 */
async function loadMembers(): Promise<Map<string, RoleMember[]>> {
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

  const out = new Map<string, RoleMember[]>();
  for (const r of rows) {
    const key = String(r.roleId);
    const list = out.get(key) ?? [];
    list.push({ id: String(r.userId), username: r.username, displayName: r.displayName });
    out.set(key, list);
  }
  return out;
}

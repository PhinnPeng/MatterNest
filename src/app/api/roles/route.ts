import { json, withActor } from "@/app/lib/server/http";
import { listRoleDetails } from "@/app/lib/server/services/roles";

/**
 * 角色定义（只读，MATT-100）。
 *
 * ## 权限门：登录即可读角色定义，成员清单按 `canManageUser` 收窄
 *
 * 这是票面那条「⚠ 权限门需要先点头」的落点，按建议执行，理由是两条不同的东西：
 *
 * · **角色定义**（谁有什么能力）是系统的**公开契约** —— 它本来就已经通过 `/api/session`
 *   把当前用户的四项特权与数据范围给到了每个客户端。再拿它当机密没有意义，
 *   所以**任何登录用户都能读到** 5 个内置角色的 code / name / dataScope / 四项特权。
 *   ⚠ **不做成整页 403**：那会让普通用户连"系统里有哪几种角色、各能做什么"都看不到，
 *   而"这个动作需要「管理账号」权限"这类提示正是要靠角色定义才读得懂的。
 *
 * · **成员清单**（谁持有什么角色）是**人的信息**，与 `/api/users` 同一档 ——
 *   那条路由的门就是 `canManageUser`（`src/app/api/users/route.ts` 的注释：
 *   "能列出全部在册同事就等于拿到一份花名册"）。所以这里把成员清单收窄到同一道门，
 *   **无权限者只拿到持有人数**（计数本身不指名道姓，不构成花名册）。
 *
 * 收窄的**判定在服务层**（`listRoleDetails` 按 `includeMembers` 投影），
 * 本层只负责把"actor 有没有 `canManageUser`"这一个事实翻译成那个布尔。
 * 服务层不自己读会话：那是两条鉴权路径（禁令⑤ 的"每个 handler 内部自己判权限"）。
 */
export async function GET() {
  return withActor(async (actor) => {
    const roles = await listRoleDetails({ includeMembers: actor.privileges.canManageUser });
    return json({ roles });
  });
}

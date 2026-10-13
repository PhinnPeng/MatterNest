import { json, requirePrivilege, withActor } from "@/app/lib/server/http";
import { listRoles, listUsers } from "@/app/lib/server/services/users";

/**
 * 账号列表（F6-1 / F6-5 / F6-11 的读入口）。
 *
 * **必须 `canManageUser`**，这是 §4.1 的硬口径：能列出全部在册同事就等于拿到一份花名册。
 * 参与人选择面走 `selectable-users` 那条带宿主上下文的路，不走这里。
 *
 * 一次返回账号 + 角色字典：授予界面两个都要，分两个请求会多一次往返、且容易半新半旧。
 * **不返回**口令摘要（只给 `hasCredential` 布尔）。
 */
export async function GET() {
  return withActor(async (actor) => {
    const denied = requirePrivilege(actor, "canManageUser", "管理账号");
    if (denied) return denied;
    const [users, roles] = await Promise.all([listUsers(), listRoles()]);
    return json({ users, roles });
  });
}

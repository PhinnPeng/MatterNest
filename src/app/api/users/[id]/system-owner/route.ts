import { fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";
import { transferSystemOwnership } from "@/app/lib/server/services/users";

/**
 * 移交系统所有者（MATT-53 移交过来的硬要求：**移交是唯一出路**）。
 *
 * 不收请求体：这个动作除"移交给谁"（在路径里）之外没有别的参数，给空对象做一次校验
 * 是仪式而不是防护。真要加"为什么要移交"的说明，那是一次独立的决定（票面没要求）。
 *
 * **不挂 `requirePrivilege`**：判定是 `actor.isSystemOwner`。持 `canManageUser` 的人
 * 能改角色、能启停，但凭据生命线的交接是身份本身的转移——把判定挂在特权开关上，
 * 等于"配了某个角色就能接管系统恢复权"。
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    const r = await transferSystemOwnership(actor, id);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "not_system_owner") {
      return fail(
        403,
        "system_owner_required",
        "只有当前系统所有者能移交所有权：凭据生命线是身份本身的转移，不是权限操作。",
      );
    }
    if (r.why === "blocked") {
      const b = r.blockers[0];
      if (b === "disabled_account") {
        return fail(422, "target_disabled", "受让人当前是停用状态，先启用他再移交。");
      }
      if (b === "not_activated") {
        return fail(422, "target_not_activated", "受让人尚未开通（待批准），先批准他再移交。");
      }
      return fail(422, "target_deleted", "受让人已删除，不能持有凭据生命线。");
    }
    return fail(403, "forbidden", "这个动作不被允许。");
  });
}

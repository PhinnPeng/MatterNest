import { userEnabledSchema } from "@/shared/schema/users";
import {
  body,
  fail,
  json,
  notFound,
  pathId,
  requirePrivilege,
  withActor,
} from "@/app/lib/server/http";
import { setUserEnabled } from "@/app/lib/server/services/users";

/**
 * 账号启停（F6-1）。
 *
 * 拒绝要给**可区分的错误码与文案**（票面硬要求）：`system_owner_protected` 与
 * `self_disable` 分开，前端才能说清"为什么不行"。合成一句"无权限"的话，
 * 运维会去翻角色配置，而真因是"你动的是凭据生命线"。
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, userEnabledSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    const denied = requirePrivilege(actor, "canManageUser", "管理账号");
    if (denied) return denied;

    const r = await setUserEnabled(actor, id, parsed.data.enabled);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "blocked") {
      const b = r.blockers[0];
      if (b === "system_owner_protected") {
        return fail(
          403,
          "system_owner_protected",
          "系统所有者不可被停用：停掉他就再没有人能设置本地凭据、系统将无法恢复。要换人请先撤销他的所有者标记再授给新的持有者。",
        );
      }
      if (b === "self_disable") {
        return fail(403, "self_disable", "不能停用自己：这个动作没有撤销入口，会把自己锁在门外。");
      }
      return fail(403, "deleted_account", "该账号已删除，不能再做启停。");
    }
    return fail(403, "forbidden", "这个动作不被允许。");
  });
}

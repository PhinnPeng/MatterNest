import { userApproveSchema } from "@/shared/schema/users";
import {
  body,
  fail,
  json,
  notFound,
  pathId,
  requirePrivilege,
  withActor,
} from "@/app/lib/server/http";
import { approveUser } from "@/app/lib/server/services/users";

/**
 * 批准待开通并当场指定角色（F6-11）。
 *
 * 与 `roles` 端点分开而不是合成一个：批准是**一次状态迁移**（`pending → active`），
 * 角色是它的**附带决定**（文档原话"批准并当场指定角色"）。合成一个 PATCH 会让
 * "只改角色"和"批准开通"共用一条路径，而这两件事的审计动作不同
 * （`USER_ACTIVATED` vs `ROLE_CHANGED`）。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, userApproveSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    const denied = requirePrivilege(actor, "canManageUser", "管理账号");
    if (denied) return denied;

    const r = await approveUser(actor, id, parsed.data.roleIds);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "self_escalation") {
      return fail(403, "self_escalation", "不能批准自己：开通与授权是别人给你做的事。");
    }
    if (r.why === "role_not_found") {
      return fail(422, "role_not_found", `这些角色不存在或已停用：${r.missing.join("、")}`);
    }
    return fail(403, "forbidden", "这个动作不被允许。");
  });
}

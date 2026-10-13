import { userRolesSchema } from "@/shared/schema/users";
import {
  body,
  fail,
  json,
  notFound,
  pathId,
  requirePrivilege,
  withActor,
} from "@/app/lib/server/http";
import { setUserRoles } from "@/app/lib/server/services/users";

/**
 * 角色授予 / 撤销（F6-5）。整体替换语义，理由见服务层 `setUserRoles` 的注释。
 *
 * **禁自助提权**在这里是一条 403 + 专用错误码：界面也会藏掉自己的角色编辑入口，
 * 但藏起来挡不住一次构造好的请求——权限模型里"自己给自己开门"只有这一条路径。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, userRolesSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    const denied = requirePrivilege(actor, "canManageUser", "管理账号");
    if (denied) return denied;

    const r = await setUserRoles(actor, id, parsed.data.roleIds);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "self_escalation") {
      return fail(
        403,
        "self_escalation",
        "不能改自己的角色：这是权限模型里唯一「自己给自己开门」的路径，请让另一位管理员来改。",
      );
    }
    if (r.why === "role_not_found") {
      return fail(422, "role_not_found", `这些角色不存在或已停用：${r.missing.join("、")}`);
    }
    return fail(403, "forbidden", "这个动作不被允许。");
  });
}

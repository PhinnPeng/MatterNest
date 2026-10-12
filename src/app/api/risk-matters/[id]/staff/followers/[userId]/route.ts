import { removeRiskFollower } from "@/app/lib/server/services/risks";
import { fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 摘一个关注人（MATT-56）。
 *
 * 按 **userId** 摘而不是按 staff 行 id：界面上「我」那一行的 X 与眼睛是同一个动作
 * （取消关注），发起方只知道"是谁"，不该先查一次名单拿行 id。
 * 摘自己不受名单管理权约束（ADR-0003）；摘别人要——判定在服务层。
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; userId: string }> },
) {
  const { id, userId } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  // userId 是**路径段**（`.../followers/{userId}`），不是 query —— 与冒烟的调用形状一致
  const uid = pathId(userId);
  if (!uid.ok) return uid.res;

  return withActor(async (actor) => {
    const r = await removeRiskFollower(actor, id, userId);
    if (!r.ok) {
      if (r.why === "not_found") return notFound();
      if (r.why === "archived") return fail(403, "archived", "归档是终态，关注名单不再变更。");
      return fail(403, "forbidden", "只有经办人、创建人或全局范围的角色能移除其他关注人。");
    }
    return json({ ok: true });
  });
}

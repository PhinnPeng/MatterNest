import { nodeWriteSchema } from "@/shared/schema/nodes";
import {
  deleteRiskNode,
  RISK_FROZEN_MESSAGE,
  updateRiskNode,
} from "@/app/lib/server/services/risks";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/** 事项节点：编辑字段 / 软删（状态走集合路由的 PATCH） */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; nodeId: string }> },
) {
  const parsed = await body(req, nodeWriteSchema);
  if (!parsed.ok) return parsed.res;
  const { id, nodeId } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const nid = pathId(nodeId);
  if (!nid.ok) return nid.res;

  return withActor(async (actor) => {
    const r = await updateRiskNode(actor, id, nodeId, {
      name: parsed.data.name,
      description: parsed.data.description || undefined,
      startTime: parsed.data.startTime,
    });
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "frozen") return fail(422, "frozen", RISK_FROZEN_MESSAGE);
    return fail(403, "forbidden", "归档是终态，或这条节点轮不到你编辑。");
  });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; nodeId: string }> },
) {
  const { id, nodeId } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const nid = pathId(nodeId);
  if (!nid.ok) return nid.res;

  return withActor(async (actor) => {
    const r = await deleteRiskNode(actor, id, nodeId);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "frozen") return fail(422, "frozen", RISK_FROZEN_MESSAGE);
    return fail(403, "forbidden", "归档是终态，或这条节点轮不到你删除。");
  });
}

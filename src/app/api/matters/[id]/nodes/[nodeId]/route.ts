import { nodeStatusSchema, pruneEmpty } from "@/shared/schema/hosts";
import { nodeWriteSchema } from "@/shared/schema/nodes";
import {
  deleteMatterNode,
  setNodeStatus,
  updateMatterNode,
} from "@/app/lib/server/services/matters";
import {
  body,
  fail,
  json,
  notFound,
  pathId,
  reasonRequired,
  withActor,
} from "@/app/lib/server/http";

/**
 * 单条案件节点：状态 / 编辑 / 删除（2026-10-23）。
 *
 * - `POST` 改状态：三态之间自由跳（用户裁定），但取消必填原因、状态没变给 422；
 * - `PATCH` 改字段：名称 / 描述 / 时间，随时可改（归档宿主除外）；
 * - `DELETE` 软删：节点是提醒与归档判定的输入，硬删会让"这条期限存在过"消失。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; nodeId: string }> }) {
  const parsed = await body(req, nodeStatusSchema);
  if (!parsed.ok) return parsed.res;
  const { id, nodeId } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const nid = pathId(nodeId);
  if (!nid.ok) return nid.res;
  return withActor(async (actor) => {
    const input = pruneEmpty(parsed.data);
    const r = await setNodeStatus(actor, id, nodeId, input.status, input.cancelReason ?? null);
    if (r === null) return notFound();
    if (!r.ok && r.why === "reason_required") return reasonRequired();
    if (!r.ok && r.why === "unchanged") return fail(422, "unchanged", "目标状态与当前状态相同");
    if (!r.ok) {
      return fail(403, "forbidden", "归档是终态，或这条节点轮不到你来取消。");
    }
    return json({ ok: true });
  });
}

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
    const r = await updateMatterNode(actor, id, nodeId, {
      name: parsed.data.name,
      description: parsed.data.description || undefined,
      startTime: parsed.data.startTime,
    });
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
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
    const r = await deleteMatterNode(actor, id, nodeId);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    return fail(403, "forbidden", "归档是终态，或这条节点轮不到你删除。");
  });
}

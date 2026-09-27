import { nodeStatusSchema, pruneEmpty } from "@/shared/schema/hosts";
import { setNodeStatus } from "@/app/lib/server/services/matters";
import { body, json, notFound, pathId, reasonRequired, withActor } from "@/app/lib/server/http";

/**
 * 节点状态：取消必填原因（E21 的 CHECK 与 §6.1 同源，服务层再判一次是为了给出可读错误）。
 * 父子两段 id 都校验格式，并且**要求节点真的挂在这条案件下**（服务层判）。
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
    if (!r.ok) return reasonRequired();
    return json({ ok: true });
  });
}

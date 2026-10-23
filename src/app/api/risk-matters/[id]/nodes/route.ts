import { nodeStatusSchema } from "@/shared/schema/hosts";
import { nodeWriteSchema } from "@/shared/schema/nodes";
import {
  addRiskNode,
  RISK_FROZEN_MESSAGE,
  setRiskNodeStatus,
} from "@/app/lib/server/services/risks";
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
 * 事项节点（2026-10-23 与案件侧同形）。
 *
 * - `POST` 新增：名称 / 描述 / 时间三个字段，不再选类型；
 * - `PATCH` 改状态：三态自由跳，取消必填原因；冻结与归档先挡。
 *
 * 编辑字段与删除在 `[nodeId]` 那条路由里。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, nodeWriteSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await addRiskNode(actor, id, {
      name: parsed.data.name,
      description: parsed.data.description || undefined,
      startTime: parsed.data.startTime,
    });
    if (r.ok) return json({ id: r.id }, 201);
    if (r.why === "not_found") return notFound();
    // 冻结必须走自己那一条：掉进兜底会说「归档是终态」，而真实原因是这条事项转过案件
    if (r.why === "frozen") return fail(422, "frozen", RISK_FROZEN_MESSAGE);
    return fail(403, "forbidden", "归档是终态，无法新增节点。");
  });
}

/** 节点状态（完成 / 取消）。 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, nodeStatusSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const nodeId = new URL(req.url).searchParams.get("nodeId");
  const nid = pathId(nodeId ?? undefined);
  if (!nid.ok) return nid.res;

  return withActor(async (actor) => {
    const r = await setRiskNodeStatus(
      actor,
      id,
      nodeId!,
      parsed.data.status,
      parsed.data.cancelReason ?? null,
    );
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "frozen") return fail(422, "frozen", RISK_FROZEN_MESSAGE);
    if (r.why === "reason_required") return reasonRequired();
    if (r.why === "unchanged") return fail(422, "unchanged", "目标状态与当前状态相同");
    return fail(403, "forbidden", "归档是终态，或这条节点轮不到你来取消。");
  });
}

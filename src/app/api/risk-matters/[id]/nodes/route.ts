import { z } from "zod";
import { nodeStatusSchema, pruneEmpty } from "@/shared/schema/hosts";
import { addRiskNode, setRiskNodeStatus } from "@/app/lib/server/services/risks";
import {
  body,
  fail,
  json,
  notFound,
  pathId,
  reasonRequired,
  withActor,
} from "@/app/lib/server/http";

/** 与 `shared/schema/hosts.ts` 里未导出的 `idField` 同一形状，就地写一份 */
const idText = (label: string) => z.string().regex(/^\d+$/, `${label}必须是数字字符串`);

/**
 * 手动新增事项节点（T1 / IQ-5）。
 *
 * **只接受 `nodeTypeId` 与时间点**：时间段由服务层按节点类型的 `time_type` 拒掉。
 * 前端不给时间段控件是不够的——手写请求照样能建，而事项侧的提醒扫描与展示
 * 都按"只有时间点"写的。
 */
const createNodeSchema = z
  .object({
    nodeTypeId: idText("节点类型"),
    name: z.string().trim().max(128).optional().or(z.literal("")),
    startTime: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/, "时间格式为 YYYY-MM-DD")
      .optional()
      .or(z.literal("")),
    remark: z.string().trim().max(2000).optional().or(z.literal("")),
  })
  .strict();

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, createNodeSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await addRiskNode(actor, id, {
      // nodeTypeId 不参与 pruneEmpty：它是必填，清洗只针对可选的可空字段
      nodeTypeId: parsed.data.nodeTypeId,
      ...(pruneEmpty({
        name: parsed.data.name,
        startTime: parsed.data.startTime,
        remark: parsed.data.remark,
      }) as { name?: string; startTime?: string; remark?: string }),
    });
    if (r.ok) return json({ id: r.id }, 201);
    if (r.why === "not_found") return notFound();
    if (r.why === "range_not_allowed") {
      // 给 422 + 下一步动作，不给 400：请求没写错，是**事项侧不支持这个节点类型**
      return fail(
        422,
        "range_not_allowed",
        "事项节点只支持时间点，不支持时间段。请换一个时间点类型的节点。",
      );
    }
    return fail(403, "forbidden", "归档是终态，或你不是这条事项的经办人，无法新增节点。");
  });
}

/** 节点完成 / 取消 / 确认时间。「确认时间」等命令走同一端点。 */
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
    if (r.why === "reason_required") return reasonRequired();
    if (r.why === "forbidden") return fail(403, "forbidden", "归档是终态，无法改节点状态");
    return fail(422, "unchanged", "目标状态与当前状态相同");
  });
}

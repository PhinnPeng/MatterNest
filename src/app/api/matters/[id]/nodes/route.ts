import { nodeWriteSchema } from "@/shared/schema/nodes";
import { createMatterNode } from "@/app/lib/server/services/matters";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * `POST /api/matters/{id}/nodes` —— 新增案件节点（2026-10-23）。
 *
 * 三个字段：名称、描述（可选）、时间。不选类型（类型是模板的概念，手工节点没有模板）。
 * 新节点从「进行中」起算，提醒档位由 `shared/node-reminder.ts` 收一次。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, nodeWriteSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    const r = await createMatterNode(actor, id, {
      name: parsed.data.name,
      description: parsed.data.description || undefined,
      startTime: parsed.data.startTime,
    });
    if (r.ok) return json({ id: r.id }, 201);
    if (r.why === "not_found") return notFound();
    return fail(403, "forbidden", "归档是终态，无法新增节点。");
  });
}

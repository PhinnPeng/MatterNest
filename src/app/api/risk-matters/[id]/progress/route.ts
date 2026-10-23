import { progressSchema, pruneEmpty } from "@/shared/schema/hosts";
import { addRiskProgress, RISK_FROZEN_MESSAGE } from "@/app/lib/server/services/risks";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 写一条事项进展（迁移 0021）。
 *
 * 与案件侧 `/api/matters/[id]/progress` 同形：先按范围谓词判可见，不可见一律 404。
 * 事项侧多两道门（与节点写入口同一口径）：已转案件（冻结）与已归档都不再收新进展。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, progressSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const input = pruneEmpty(parsed.data);
  return withActor(async (actor) => {
    const r = await addRiskProgress(actor, id, input);
    if (r.ok) return json({ id: r.id }, 201);
    if (r.why === "not_found") return notFound();
    if (r.why === "frozen") return fail(422, "frozen", RISK_FROZEN_MESSAGE);
    return fail(403, "forbidden", "归档是终态，无法新增进展。");
  });
}

import { hostExportQuerySchema } from "@/shared/schema/expenses";
import { exportHostFile } from "@/app/lib/server/services/exports";
import { json, notFound, pathId, query, requirePrivilege, withActor } from "@/app/lib/server/http";

/**
 * 事项整卷导出（与案件侧同构：同一份 `exportHostFile`，只换宿主）。
 *
 * 两档、特权门、`EXPORT` 审计的形状与案件侧逐字相同 —— 它们是同一件事在两个宿主上，
 * 不是两套实现。差别只有区段：事项侧没有"案件进展"那一段（`mn_matter_progress`
 * 是案件专属，§6.3）。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const q = await query(req, hostExportQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => {
    if (q.data.plain) {
      const denied = requirePrivilege(actor, "canReadPlain", "明文导出");
      if (denied) return denied;
    }
    const r = await exportHostFile(actor, "risk_matter", id, { plain: q.data.plain });
    if (!r) return notFound();
    return json(r);
  });
}

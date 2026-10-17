import { riskMatterListExportQuerySchema } from "@/shared/schema/list-query";
import { exportRiskMatters } from "@/app/lib/server/services/risks";
import { json, query, requirePrivilege, withActor } from "@/app/lib/server/http";

/**
 * 事项列表导出（MATT-64 / F1-20）：**导出当前筛选的那一批**（含「只看未指派」），默认脱敏。
 *
 * 与 `/api/matters/export` 逐条同形 —— 两处的差别只有筛选集合与后端那个服务函数，
 * 口径（整批导出、`plain` 只在 handler 判、服务层不判）是同一套。
 */
export async function GET(req: Request) {
  const q = await query(req, riskMatterListExportQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => {
    if (q.data.plain) {
      const denied = requirePrivilege(actor, "canReadPlain", "明文导出");
      if (denied) return denied;
    }
    return json(await exportRiskMatters(actor, q.data));
  });
}

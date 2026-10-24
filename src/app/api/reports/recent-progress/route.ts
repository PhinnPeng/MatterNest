import { recentProgressQuerySchema } from "@/shared/schema/reports";
import { json, query, withActor } from "@/app/lib/server/http";
import { recentProgress } from "@/app/lib/server/services/recent-progress";

/**
 * `GET /api/reports/recent-progress` —— 报表页的主查询（2026-10-24）。
 *
 * `scope` 决定案件还是事项；`days` 是滚动时间窗（7/30/90/all），默认 30。
 * 可见性、归档与"必须有进展行"三条谓词都在服务层，与工作台共用同一份。
 */
export async function GET(req: Request) {
  const q = await query(req, recentProgressQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => json(await recentProgress(actor, q.data)));
}

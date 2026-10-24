import { recentProgressExportQuerySchema } from "@/shared/schema/reports";
import { json, query, withActor } from "@/app/lib/server/http";
import { exportRecentProgress } from "@/app/lib/server/services/recent-progress";

/**
 * `GET /api/reports/recent-progress/export` —— 导出当前筛选（服务端拼 CSV）。
 *
 * 一档导出：六列里没有证件号与金额，不做「明文/脱敏」的假差异；审计仍记 `EXPORT`。
 * 上限 1000 行，超出由响应里的 `truncated` 告诉调用方。
 */
export async function GET(req: Request) {
  const q = await query(req, recentProgressExportQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => json(await exportRecentProgress(actor, q.data)));
}

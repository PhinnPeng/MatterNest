import { json, query, withActor } from "@/app/lib/server/http";
import { reports, reportsQuerySchema } from "@/app/lib/server/services/reports";

/**
 * 报表两卡（MATT-46 / F8-1 + F8-2）。**只读，没有写路径**。
 *
 * 两张卡一次给：页面不需要为了"同一次查询时刻"发两个请求，也不会出现
 * "案件卡是按 10:00 算的、节点卡是按 10:01 算的"这种对不上的读数。
 *
 * 鉴权与两张列表同源（禁令⑤：判在 handler 里，不在 middleware）：`withActor` 拿不到 actor 就 401，
 * 可见性判定在服务层经 `scopedWhere`——所以这个端点**不探测任何资源是否存在**，
 * 未登录给 401 而不是 404（与 `/api/overview`、`/api/session` 同一类）。
 *
 * `archivedOnly` 是二态开关（在办 / 已归档），语义与两张列表逐字同一个字段；
 * 手打 `yes` 这类值由 `reportsQuerySchema` 直接 400，不静默当成"看在办"。
 */
export async function GET(req: Request) {
  const q = await query(req, reportsQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => json(await reports(actor, q.data)));
}

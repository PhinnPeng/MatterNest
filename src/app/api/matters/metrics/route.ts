import { listQuerySchema } from "@/shared/schema/list-query";
import { matterMetrics } from "@/app/lib/server/services/matters";
import { json, query, withActor } from "@/app/lib/server/http";

/**
 * 案件列表顶部的六格指标（canon `matters.html` 的 `.metrics`，2026-10-19）。
 *
 * ## 为什么独立端点，而不是塞进 `GET /api/matters`
 *
 * 两者是**两次不同用途的读**：
 *   · 列表要分页、要排序，只返回当前页；
 *   · 指标带要的是"整个筛选结果"的六个聚合数，与翻到第几页无关。
 *
 * 挤进同一个响应会让列表页每翻一页都白算一次六格聚合；而分开之后
 * "同一时刻的两个读数"这件事由前端用同一个 `queryKey` 承担（筛选一变两者一起重取）。
 *
 * ⚠ 它与 `/api/reports` 的两张矩阵卡**不是一回事**，不要合并：
 * 矩阵卡是"状态 × 等级 × 诉讼地位"的交叉分布，指标带是六个**单维**读数。
 * 两者的读者问题不同（"这一片里各档怎么分布" vs "有几个该现在就动手"），
 * 而 PRD 把矩阵卡（M8 / F8-1）与列表页指标（P7 的页面构图）分在两处裁定。
 *
 * ## 鉴权
 *
 * 与列表逐字同源：`withActor` 拿不到 actor 就 401，可见性在服务层经 `scopedWhere`。
 * 查询串直接用 `listQuerySchema`（与 `GET /api/matters` 同一个 schema）——
 * 这样"指标按什么筛"与"列表按什么筛"在类型与校验上是**同一份**，
 * 而不是两套会漂的参数面。
 */
export async function GET(req: Request) {
  const q = await query(req, listQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => json(await matterMetrics(actor, q.data)));
}

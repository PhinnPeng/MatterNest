import { listQuerySchema } from "@/shared/schema/list-query";
import { listMatterOwners } from "@/app/lib/server/services/matters";
import { json, query, withActor } from "@/app/lib/server/http";

/**
 * 「经办人」筛选下拉的候选集（2026-10-19，canon `matters.html` 查询区）。
 *
 * ## 为什么不复用 `/api/meta` 或 `selectable-users`
 *
 *   · `/api/meta` 按权限草案 §4.1 **刻意不下发 users**——能列出全体同事就等于拿到花名册；
 *   · `selectable-users` 必须带宿主 id，而列表页没有"某一条"可指。
 *
 * 所以这条端点返回的是**当前筛选下真实出现过的负责人**（`DISTINCT owner`，经 `scopedWhere`）：
 * 下拉里出现的人，必定在你可见的某条案卷上办着事。它的泄露面与列表本身相同——
 * 不是多开了一个名单面。
 *
 * 查询串与列表同一份 `listQuerySchema`：换一个筛选，候选人也跟着变（口径同源）。
 */
export async function GET(req: Request) {
  const q = await query(req, listQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => json({ owners: await listMatterOwners(actor, q.data) }));
}

import { riskMatterListQuerySchema } from "@/shared/schema/list-query";
import { listRiskMatterOwners } from "@/app/lib/server/services/risks";
import { json, query, withActor } from "@/app/lib/server/http";

/**
 * 「经办人」筛选下拉的候选集（canon `risk-matters.html` 查询区，与案件侧同一条口径）。
 *
 * 返回的是**当前筛选下真实出现过的经办人**（`DISTINCT owner`，经 `scopedWhere`），
 * 不是花名册：`/api/meta` 按权限草案 §4.1 刻意不下发 users，而 `selectable-users`
 * 必须带宿主 id。所以下拉里出现的人，必定在你可见的某条事项上办着事——
 * 泄露面与列表本身相同，没有多开一个名单面。
 *
 * 未指派（`owner_id IS NULL`）不在候选里：它不是一个人，由前端那个固定的
 * 「未指派」选项承担（`ownerEmpty`）。
 */
export async function GET(req: Request) {
  const q = await query(req, riskMatterListQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => json({ owners: await listRiskMatterOwners(actor, q.data) }));
}

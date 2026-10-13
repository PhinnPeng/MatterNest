import { getMatter } from "@/app/lib/server/services/matters";
import { json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * `GET /api/matters/{id}/archive-readiness` —— 「归档就绪」三项（F2-26）。
 *
 * ## 为什么单独一条，而不是让调用方从详情里取
 *
 * 归档二次确认弹窗在**列表页与详情页共用**（`StatusDialog` 是同一个组件）。走详情接口
 * 意味着每次打开归档确认都要拉整份详情（节点/评论/活动日志全带上），而它只要三个布尔。
 *
 * ## 与详情页那张卡、列表筛选是**同一条判定**的三个出口
 *
 * 三个出口都出自 `judgeArchiveReadiness`（判定只实现一次）。这里不做任何再判定——
 * 尤其**不许**把附件那项"补"成绿：它是 `unavailable`（`mn_attachment` 一期未建），
 * 三个出口必须给出同一个答案。
 *
 * ## 为什么复用 `getMatter` 而不是自己写一次 `scopedWhere`
 *
 * 可见性判定只有一处比省这一次查询重要。代价是拉了一份详情——但这条接口只在
 * 打开归档确认时被调用，不在热路径上。
 *
 * `readiness` 为 `null` 只可能出现在"详情查到了、再算就绪时案件已被删"这种竞态里；
 * 客户端把 `null` 当"读不到"，不渲染那张卡（不猜、不默认绿）。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const detail = await getMatter(actor, id);
    if (!detail) return notFound();
    return json({ readiness: detail.archiveReadiness });
  });
}

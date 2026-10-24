import { statusChangeSchema } from "@/shared/schema/hosts";
import { changeHostStatus } from "@/app/lib/server/services/status-change";
import {
  attributionRequired,
  body,
  fail,
  json,
  notFound,
  pathId,
  reasonRequired,
  withActor,
} from "@/app/lib/server/http";

/**
 * 案件状态变更。**这条路由只剩三件事**：读 body、读 id、把 `why` 翻成 HTTP。
 *
 * 判定与写入（可见 → 冻结 → 撤销归档特权 → 归属 → 原因）在
 * `services/status-change.ts`，与事项侧共用同一份顺序。
 *
 * ## 为什么守卫全搬走了
 *
 * 原来这里有八行预检：按 `scopedWhere` 读 `is_archived`、判 `can_unarchive`。
 * 那八行与事项侧逐字相同，而且**判了两次**（预检一次、服务层事务里再读一次）。
 * 搬进模块之后：
 *   · 不可见一律 404（元规则 3 —— 403 等于替探测者确认"这条存在"）；
 *   · `can_unarchive` 只在"已归档 **且** 要离开归档"时要；
 *   · 「冻结排在归档之前」这条顺序由 `decideStatusChange` 拥有，有单测钉住。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, statusChangeSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await changeHostStatus({
      host: "matter",
      actor,
      id,
      to: parsed.data.to,
      reason: parsed.data.reason ?? null,
    });
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "reason_required") return reasonRequired();
    if (r.why === "privilege_required")
      return fail(403, "privilege_required", "撤销归档需要「撤销归档」权限，当前角色未持有");
    // 可见但不是负责人：403 是诚实的答复（这条你看得见，只是轮不到你推状态）
    if (r.why === "forbidden") return attributionRequired();
    return fail(422, "unchanged", "目标状态与当前状态相同");
  });
}

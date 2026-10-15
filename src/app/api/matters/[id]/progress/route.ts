import { progressSchema, pruneEmpty } from "@/shared/schema/hosts";
import { addProgress } from "@/app/lib/server/services/matters";
import { body, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 写一条案件进展（MATT-59）。
 *
 * 与评论/状态那几条**同一个形状**：先按范围谓词判可见，不可见一律 404 ——
 * 不给「能写进展但看不到案件」的缝隙（不可见时连写都写不进去，比只挡读更安全）。
 *
 * `pruneEmpty` 把「未填」与「填了空串」压成同一个 undefined，于是 `nextPlan`
 * 在服务层只判一次；`nodeId` 同理。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, progressSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const input = pruneEmpty(parsed.data);
  return withActor(async (actor) => {
    const r = await addProgress(actor, id, input);
    // null = 不可见或不存在，两者对外同形（404）。给 403 会让攻击者知道那个 id 存在。
    return r ? json(r, 201) : notFound();
  });
}

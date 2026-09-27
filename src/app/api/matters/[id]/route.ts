import { getMatter } from "@/app/lib/server/services/matters";
import { json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 详情。**不可见与不存在都走 404**（权限草案 §1 元规则 3）：
 * 403 等于向探测者确认"这条案卷存在"，而案号是可枚举的。
 *
 * id 先过 `pathId`：`BigInt("abc")` 抛 SyntaxError 会变成 500，
 * 那是"URL 写错了"，不是服务端坏了 —— 也不给 404，免得把前端路由 bug 伪装成权限收窄。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const row = await getMatter(actor, id);
    return row ? json(row) : notFound();
  });
}

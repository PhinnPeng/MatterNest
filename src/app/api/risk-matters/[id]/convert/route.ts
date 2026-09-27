import { convertSchema, pruneEmpty } from "@/shared/schema/hosts";
import { convertToCase } from "@/app/lib/server/services/risks";
import { body, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 转案件（修订稿 §3.4 + 映射矩阵 §2）。字段继承按 master P0-1：**描述不继承、金额留空逐案填**。
 * 同一事项可转多次 —— "已转案件"与"已结案"正交，所以是第二个徽标而不是第五个状态位。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, convertSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await convertToCase(actor, id, pruneEmpty(parsed.data));
    return r ? json(r, 201) : notFound();
  });
}

import { commentSchema, pruneEmpty } from "@/shared/schema/hosts";
import { addComment } from "@/app/lib/server/services/matters";
import { body, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/** 评论：写之前先按范围判可见，不可见宿主上的评论同样 404（不给"能评论但不能看"的缝隙） */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, commentSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const input = pruneEmpty(parsed.data);
  return withActor(async (actor) => {
    const r = await addComment(actor, id, input.body, input.parentId ?? null);
    return r ? json(r, 201) : notFound();
  });
}

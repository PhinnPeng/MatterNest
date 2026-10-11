import { z } from "zod";
import { commentSchema, pruneEmpty } from "@/shared/schema/hosts";
import { addRiskComment, editRiskComment } from "@/app/lib/server/services/risks";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/** 发处置记录（T1）。事项核查走评论，不靠节点（IQ-5）。 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, commentSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await addRiskComment(
      actor,
      id,
      parsed.data.body,
      pruneEmpty({ parentId: parsed.data.parentId }).parentId,
    );
    if (!r) return notFound();
    return json(r, 201);
  });
}

const editSchema = z.object({ body: z.string().trim().min(1, "评论不能为空").max(2000) }).strict();

/** 编辑处置记录。只允许作者本人改，改后显示「（已编辑）」并写 COMMENT_UPDATED。 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, editSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const url = new URL(req.url);
  const commentId = url.searchParams.get("commentId");
  const cid = pathId(commentId ?? undefined);
  if (!cid.ok) return cid.res;
  return withActor(async (actor) => {
    const r = await editRiskComment(actor, id, commentId!, parsed.data.body);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    return fail(403, "author_only", "只有评论作者本人可以编辑自己的处置记录");
  });
}

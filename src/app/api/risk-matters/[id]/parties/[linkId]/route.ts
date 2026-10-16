import { removeRiskParty, RISK_FROZEN_MESSAGE } from "@/app/lib/server/services/risks";
import { fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 摘除一条当事人挂接（T10）。
 *
 * 删的是**关联行**，不是当事人本体——后者归 T3 管的档案。
 * 路径参数是**关联行 id** 而不是当事人 id：同一个当事人可以以不同诉讼地位
 * 被挂两次（共同被告、共同申请人），按当事人 id 删会把另一条一起带走。
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; linkId: string }> },
) {
  const { id, linkId } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const lid = pathId(linkId);
  if (!lid.ok) return lid.res;

  return withActor(async (actor) => {
    const r = await removeRiskParty(actor, id, linkId);
    if (r.ok) return json({ removed: 1 });
    // 冻结必须走自己那一条（MATT-82 / ADR 0005）：掉进下面的 404 会说「这条当事人
    // 挂接不存在」，用户会去刷新页面重找，而真实原因是事项已转过案件、名单已移交。
    if (r.why === "frozen") return fail(422, "frozen", RISK_FROZEN_MESSAGE);
    return notFound();
  });
}

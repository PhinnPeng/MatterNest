import { riskPartyAppendSchema } from "@/shared/schema/hosts";
import {
  appendRiskParties,
  listRiskParties,
  RISK_FROZEN_MESSAGE,
} from "@/app/lib/server/services/risks";
import { UnknownPartyError } from "@/app/lib/server/services/parties";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 事项的当事人区：读全部 + 追加若干（T10）。
 *
 * 这是转案件能走通的前提：`convertToCase` 的前置是"事项至少 1 个当事人"，
 * 而在本入口之前 `riskMatterParty` 全仓只有读没有写——任何走 UI 建的事项
 * 转案件都必然 422，而那条 422 叫用户「请先在事项上添加再转」，那个入口当时不存在。
 *
 * 追加而非"整体替换"：整体替换要求前端每次先拉全量再提交全量，
 * 两人同时改会静默丢对方的改动。追加只提交增量，冲突面小得多。
 *
 * 摘除一条挂接在 `[linkId]/route.ts` 的 DELETE——按**关联行 id** 删而不是按当事人 id，
 * 因为同一个当事人可以以不同诉讼地位被挂两次（共同被告）。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const rows = await listRiskParties(actor, id);
    // null = 这条事项你看不见或不存在 → 404，与元规则 3 一致
    if (rows === null) return notFound();
    return json(rows);
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, riskPartyAppendSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    try {
      const r = await appendRiskParties(actor, id, parsed.data.parties);
      if (r.ok) return json({ added: r.added });
      // 冻结必须走自己那一条（MATT-82 / ADR 0005）：掉进下面的 404 会把
      // 「这条事项已转过案件、当事人名单已移交」说成「不存在或已归档」，
      // 用户会去核对 id 与归档态，而真正的原因在案件那边。
      if (r.why === "frozen") return fail(422, "frozen", RISK_FROZEN_MESSAGE);
      // 不可见 / 已归档一律 404。归档是终态（§5.2），对已归档事项改当事人同样不该放行。
      return notFound();
    } catch (e) {
      /**
       * 与 `/api/risk-matters`（建事项）和 `/api/matters`（建案件）同形。
       *
       * 这条入口是事项**事后**追加当事人的唯一路径，而它此前没有任何 catch
       * ⇒ 输入本企业名或引用一个不存在的 partyId 都得到 500。
       * AC 第 4 条要求"提示而非建档"，500 既不是提示也没说下一步。
       */
      if (e instanceof UnknownPartyError) return fail(400, "unknown_party", e.message);
      throw e;
    }
  });
}

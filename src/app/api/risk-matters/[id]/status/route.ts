import { statusChangeSchema } from "@/shared/schema/hosts";
import { changeHostStatus } from "@/app/lib/server/services/status-change";
import { RISK_FROZEN_MESSAGE } from "@/app/lib/server/services/risk-freeze";
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
 * 事项状态变更。判定顺序与案件侧**同一份实现**（`services/status-change.ts`），
 * 差异只有三处，全部在 `host-status-policy.ts`：
 *
 *   · 冻结门（ADR-0005）—— 案件没有这个概念；
 *   · 经办人可空 —— 无主事项谁都能推（否则永久卡死）；
 *   · 没有结案日期、没有归档就绪判定。
 *
 * ## 冻结答复用哪一句
 *
 * `frozen` 有两种来路，说法的分寸不同：
 *   · 推状态被冻结门挡住 → `RISK_FROZEN_MESSAGE`（讲"哪些不能再改、该去哪儿改"）；
 *   · 撤销转案件被挡住   → `RISK_UNCONVERT_FROZEN_MESSAGE`（讲"这是规则，不是故障"），
 *     那一句在 `unconvert` 路由里，不在这里。
 *
 * **2026-10-24 的答复口径订正**：过去"已归档但没撤销权限"在路由里先判，
 * 于是冻结+归档的事项会回 403「需要撤销归档权限」—— 用户去找持特权的人，
 * 对方也解不开。现在冻结排在前面，答复是 422 `frozen`，指向"去案件上做"。
 *
 * 归档要撤销权限、且归档不是终点（撤销归档是正常路径），所以 403 保留特权语义。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, statusChangeSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await changeHostStatus({
      host: "risk_matter",
      actor,
      id,
      to: parsed.data.to,
      reason: parsed.data.reason ?? null,
    });
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "frozen") return fail(422, "frozen", RISK_FROZEN_MESSAGE);
    if (r.why === "reason_required") return reasonRequired();
    if (r.why === "privilege_required")
      return fail(403, "privilege_required", "撤销归档需要「撤销归档」权限，当前角色未持有");
    // 可见但不是经办人：403 是诚实的答复（这条你看得见，只是轮不到你推状态）
    if (r.why === "forbidden") return attributionRequired();
    return fail(422, "unchanged", "目标状态与当前状态相同");
  });
}

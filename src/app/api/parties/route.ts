import { partySearchSchema } from "@/shared/schema/hosts";
import { searchVisibleParties } from "@/app/lib/server/services/parties";
import { json, query, withActor } from "@/app/lib/server/http";

/**
 * 当事人检索 —— 建案/转案件里「引用既有当事人」下拉的数据源（master F2-15）。
 *
 * 三条口径都不是风格：
 *   · 谓词是草案 §7.2「我对它关联的至少一个宿主可见」，**不是**当事人自己的范围 ——
 *     `mn_party` 是跨案件共享实体，没有 owner_id，照抄宿主谓词会套不上；
 *   · 关键字必填（`partySearchSchema.min(1)`）：空关键字等于全公司当事人一次列举，
 *     与 §4.1 拒绝裸 `/users` 列表同一个理由；
 *   · 只回证件号**尾四位**用于消歧。明文查看是另一条链路（§7.3：要 `can_read_plain`
 *     且记 `SENSITIVE_FIELD_READ`），一个搜索下拉不构成那次查看。
 *
 * 结果只有 20 条时 `truncated=true`，前端必须显示「部分结果因权限未显示」（§7.2 原话），
 * 否则用户会以为"库里没有这家"，转而新建一份重复当事人 —— 那正是这张接口要防的事。
 */
export async function GET(req: Request) {
  const q = await query(req, partySearchSchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => json(await searchVisibleParties(actor, q.data.q)));
}

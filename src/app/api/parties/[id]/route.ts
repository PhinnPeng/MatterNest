import { getParty, partyUpdateSchema, updateParty } from "@/app/lib/server/services/parties";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 档案详情（F3-4）。**不可见与不存在都走 404**（权限草案 §1 元规则 3）：
 * 403 等于向探测者确认"这份档案存在"，而当事人名称是可枚举的。
 *
 * id 先过 `pathId`：`BigInt("abc")` 抛 SyntaxError 会变成 500，那是"URL 写错了"，
 * 不是服务端坏了 —— 也不给 404，免得把前端路由 bug 伪装成权限收窄。
 *
 * 读出口的证件号/手机号是**明文**（IQ-12 展示层全明文，无"显示明文"按钮、无逐次审计）；
 * 留痕的是导出两档（`/api/parties?export=`）。所以这里**不**做任何脱敏，
 * 也不接受"要不要明文"的参数 —— 那会把这个读出口变成第三个导出档。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const row = await getParty(actor, pid.id);
    return row ? json(row) : notFound();
  });
}

/**
 * 编辑对手方（F3-2）。与新建同一套值域（`partyUpdateSchema` 是它的 `.partial()`），
 * 改哪个传哪个。
 *
 * 审计里证件号/手机号**只记"改过"的布尔**，不记旧值与新值 —— 审计表是长期留存的明文表，
 * 把敏感值抄进去等于给加密开了一个后门（服务层 `updateParty` 里落这一条）。
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const parsed = await body(req, partyUpdateSchema);
  if (!parsed.ok) return parsed.res;
  return withActor(async (actor) => {
    const r = await updateParty(actor, pid.id, parsed.data);
    if (r === null) return notFound();
    if (!r.ok) {
      if (r.why === "own_company")
        return fail(
          422,
          "own_company",
          `「${r.name}」是本企业名称，我方永不进当事人表；它在案件上的地位由该案的「我方诉讼地位」表达`,
        );
      return json(
        {
          error: "identity_exists",
          message: `库里已有同证件号的档案：${r.name}`,
          partyId: r.partyId,
        },
        409,
      );
    }
    return json({ ok: true });
  });
}

import { partyMergeSchema } from "@/app/lib/server/services/parties";
import { MergeInputError, mergeParties } from "@/app/lib/server/services/party-merge";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 合并重复档案（F3-9）。路径里的 `[id]` 是**主记录**（surviving），body 里是要并进去的那几条。
 *
 * 三种答复分工明确，都不是随手挑的：
 *   · **404** —— 主记录/任一被并方不存在、已软删（含"已经被并走"）、或落在操作者的数据范围之外。
 *     四种都归到同一句"没有找到这条记录，或你没有访问它的权限"（元规则 3）；
 *   · **400** —— 形状不对（一条都没选、超过 20 条）：那是请求写错了，与权限无关；
 *   · **200** —— 回 `moved` / `dropped`。`dropped` 必须给出来：同一案卷上主记录已在该当事人时，
 *     被并方那一行会被丢掉（撞 `uk_mn_*_party`），丢掉多少条不能悄悄咽下去。
 *
 * 合并**不可撤销**（一期无反合并），所以界面上那句"不可撤销"要写在按钮旁边，
 * 不能只藏在弹窗小字里（前端 `party-detail.tsx` 的合并弹窗照此实现）。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const parsed = await body(req, partyMergeSchema);
  if (!parsed.ok) return parsed.res;
  return withActor(async (actor) => {
    try {
      const r = await mergeParties(
        actor,
        pid.id,
        parsed.data.mergedIds.map(BigInt),
        parsed.data.reason || null,
      );
      return r ? json(r) : notFound();
    } catch (e) {
      // 形状错误（空选择/超上限）是可预期的请求问题，给 400 并回原话；
      // 其余错误一律冒泡（不吞成 500 的统一包装）
      if (e instanceof MergeInputError) return fail(400, "bad_merge_input", e.message);
      throw e;
    }
  });
}

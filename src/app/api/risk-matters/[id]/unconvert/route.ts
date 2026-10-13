import { unconvertSchema } from "@/shared/schema/hosts";
import { unconvertFromCase, type UnconvertBlocker } from "@/app/lib/server/services/risks";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 撤销转案件关联（修订稿 §3.4 / 映射矩阵 §5.1）。
 *
 * **只删关联，案件保留为独立案件**——修订稿原话是"只能删除 `risk_matter_case` 关联行"。
 * 这条路由刻意不接受 `caseId` 之外的任何案件字段：要是允许顺手改案件字段，
 * "撤销"就成了"改案"，两件事混在一个事务里谁也说不清。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, unconvertSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    const r = await unconvertFromCase(actor, id, parsed.data.caseId, {
      reason: parsed.data.reason,
    });
    if (r.ok) return json({ caseId: r.caseId, remaining: r.remaining });
    // 两个 404 合成一个条件先处理掉，再 switch：
    //   · 空 case 会被 eslint 的 no-fallthrough 挑出来；
    //   · 剩下的分支用 switch 是为了「漏掉一个新 why 时编译期报错」——
    //     一串 if 链会把未预期状态静默落到最后一句，当成 422 回给用户。
    // 404 的两个来源：不可见（权限草案：不可见一律 404 不返 403）；
    // 以及无关联行——那说明这条路径不归本动作管，走 F2-5 软删，
    // 对外也报 404，因为说"有这回事但你没权限"本身就是泄露。
    if (r.why === "not_found" || r.why === "not_linked") return notFound();

    switch (r.why) {
      case "reason_required":
        return fail(422, "reason_required", "撤销必须填原因——这条会写进审计，且不可逆。");
      case "blocked": {
        // 前置不满足：逐条告诉用户还差什么，别只回一句"不能撤"
        const reasons: Record<UnconvertBlocker, string> = {
          progress: "案件上已经登记了进展",
          nodes: "案件上有非系统生成的节点",
          // MATT-47 接上的第三条（映射矩阵 §5.1：无进展 / 无费用 / 无非预设节点）
          expenses: "案件上已经登记了费用",
        };
        return fail(
          422,
          "blocked",
          `不能撤销：${r.blockers.map((b) => reasons[b]).join("；")}。关联已产生实际投入，撤掉会让这些记录失去归属。`,
        );
      }
    }
  });
}

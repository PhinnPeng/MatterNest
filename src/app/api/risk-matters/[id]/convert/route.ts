import { convertSchema, pruneEmpty } from "@/shared/schema/hosts";
import { convertToCase } from "@/app/lib/server/services/risks";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

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
    // 逐张卡清洗空串（表单里清空的输入会落成 ""，而服务层要的是 undefined）。
    // 不用整体 pruneEmpty：它把数组结构擦成 Record<string, unknown>，类型就没了。
    const cases = parsed.data.cases.map((c) => pruneEmpty(c) as typeof c);
    const r = await convertToCase(actor, id, cases);
    if (r.ok) return json({ cases: r.cases }, 201);
    if (r.why === "not_found") return notFound();
    if (r.why === "archived") {
      // 归档是终态（映射矩阵 §5.2）：要转得先撤归档，而撤销要 can_unarchive 特权
      return fail(422, "archived", "这条风险事项已归档。归档是终态，请先撤销归档再转案件。");
    }
    if (r.why === "too_many_cases") {
      return fail(422, "too_many_cases", "一次最多转 20 个案件，请分批提交。");
    }
    // 给 422 + 下一步动作，不给 400：这不是"请求写错了"，是"前置数据还没齐"
    return fail(
      422,
      "parties_required",
      "这条风险事项还没有关联当事人。转案件要求每案至少 1 个当事人，请先在事项上添加再转。",
    );
  });
}

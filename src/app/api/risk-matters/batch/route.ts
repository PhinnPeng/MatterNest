import { batchSchema } from "@/shared/schema/batch";
import {
  batchArchiveRiskMatters,
  batchChangeRiskStatus,
  batchTagRiskMatters,
} from "@/app/lib/server/services/risks";
import { body, fail, json, withActor } from "@/app/lib/server/http";

/**
 * 事项侧的批量低风险动作（MATT-45）：改状态 / 归档 / 加标签。
 *
 * 与案件侧 `/api/matters/batch` **逐条同构**，包括响应语义那三条留白
 * （不可见不进任何一栏 / `skipped` 只算看得见但没做成 / 4xx 只留给与行无关的问题）
 * ——完整理由见那个 handler 的文件头，这里不抄第二份：抄一份的代价是两处会漂，
 * 而漂了的形态是"案件页说跳过 2 条、事项页说跳过 3 条"，用户只会怀疑哪个是真的。
 *
 * 两侧确实不同的只有一件事：事项的经办人**可空**（IQ-5），无主事项谁都能推它的状态
 * （`changeHostStatus` 里那条 `ownerId !== null` 判断）。批量沿用同一个判定——
 * 这里不另判一次归属，否则"单条能推、批量推不动"就出现了。
 */
export async function POST(req: Request) {
  const parsed = await body(req, batchSchema);
  if (!parsed.ok) return parsed.res;
  return withActor(async (actor) => {
    const input = parsed.data;

    if (input.action === "status") {
      const r = await batchChangeRiskStatus(actor, input.ids, input.to, input.reason ?? null);
      if (!r.ok) return fail(422, "bad_status", "目标状态不存在，或它已被停用");
      return json({ applied: r.applied, skipped: r.skipped });
    }

    if (input.action === "archive") {
      const r = await batchArchiveRiskMatters(actor, input.ids, input.reason);
      return json({ applied: r.applied, skipped: r.skipped });
    }

    const r = await batchTagRiskMatters(actor, input.ids, input.tagIds);
    if (!r.ok) return fail(422, "bad_tag", "选中的标签不存在，或不属于事项这一类记录");
    return json({ applied: r.applied, skipped: r.skipped });
  });
}

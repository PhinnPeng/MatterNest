import { hostExportQuerySchema } from "@/shared/schema/expenses";
import { exportHostFile } from "@/app/lib/server/services/exports";
import { json, notFound, pathId, query, requirePrivilege, withActor } from "@/app/lib/server/http";

/**
 * 案件整卷导出（US-42 / IQ-12 的第三重防线）：**两档**。
 *
 *   · 默认（`?plain` 不传）→ **脱敏档**：人人可导（看得见这条案卷就能导它），
 *     当事人证件号/联系方式只留尾四位；
 *   · `?plain=1` → **明文档**：**先过 `can_read_plain`**，否则 403
 *     （`privilege_required`），且整卷写一条 `EXPORT` 审计。
 *
 * 特权判定在**这一层**（`requirePrivilege`），服务层不再判第二次 ——
 * 与当事人导出同一条理由：两处各判一次就会出现两套口径。
 *
 * 两档**都**写 `EXPORT`（载荷 `{target_type, scope, rows, count, plain}`，**不含内容**）：
 * 这就是"整卷记审计"—— 一次导出记一条，不是一行记一条。
 *
 * 可见性：`exportHostFile` 先过 `scopedWhere`，看不见 → 404（与"不存在"同一响应）。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const q = await query(req, hostExportQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => {
    if (q.data.plain) {
      const denied = requirePrivilege(actor, "canReadPlain", "明文导出");
      if (denied) return denied;
    }
    const r = await exportHostFile(actor, "matter", id, { plain: q.data.plain });
    if (!r) return notFound();
    return json(r);
  });
}

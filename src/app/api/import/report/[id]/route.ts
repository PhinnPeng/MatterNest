import { importReportCsv } from "@/app/lib/server/services/import";
import { canImport } from "@/app/lib/server/scope/guards";
import { importForbidden, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 错误报告下载（票面 AC「逐行跳过并产出**可下载**的错误报告」）。
 *
 * 报告引用 = **批次 id**，它同时是 `BULK_IMPORT` 载荷里的 `report_ref` ——
 * 审计日志与这份报告因此指向同一个东西，而不是"日志里记了个查不到的编号"。
 *
 * 出口形状与模板下载一致（JSON 带 `csv`，前端落盘）。
 *
 * `pathId` 先拦非法 id（400 而不是 500）；批次不存在给 404 —— 报告只有 L1 能看，
 * 而 L1 看得见全部批次，所以这里不存在"不可见 vs 不存在"的区分问题（元规则 3 的
 * 那套措辞在这里没有第二种含义）。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    if (!canImport(actor)) return importForbidden();
    const r = await importReportCsv(String(pid.id));
    return r ? json(r) : notFound();
  });
}

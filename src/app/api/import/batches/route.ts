import { listImportBatches } from "@/app/lib/server/services/import";
import { canImport } from "@/app/lib/server/scope/guards";
import { importForbidden, json, withActor } from "@/app/lib/server/http";

/**
 * 最近几次导入（含 `reportRef`，即报告下载引用）。
 *
 * 为什么需要它：导入的响应里已经带了 `reportRef`，但**用户会把标签页关掉**。
 * 没有这一条，"三个月前那批到底哪些行没进去"就只能翻审计日志里的一个 id，
 * 而那个 id 用不了 —— 报告入口必须能从列表回到手上。
 *
 * 不做分页：`IMPORT_BATCH_LIST_LIMIT`（20）是"最近几次"的量级，导入是低频动作
 * （三年台账一次性迁入），做分页等于给一个不会翻页的列表加一套状态。
 */
export async function GET() {
  return withActor(async (actor) => {
    if (!canImport(actor)) return importForbidden();
    return json(await listImportBatches());
  });
}

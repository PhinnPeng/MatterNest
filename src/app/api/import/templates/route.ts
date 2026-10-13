import { z } from "zod";
import { IMPORT_KINDS } from "@/shared/enums/import";
import { importTemplate } from "@/app/lib/server/services/import";
import { canImport } from "@/app/lib/server/scope/guards";
import { importForbidden, json, query, withActor } from "@/app/lib/server/http";

/**
 * 三张导入模板的下载口（F7-4「事项 / 案件 / 当事人三模板」）。
 *
 * 出口形状与另外两条导出链路一致（**JSON 里带 `csv` 文本**，前端 `downloadCsv` 落盘）：
 * 本仓没有任何路由直接吐 `text/csv` —— 中文文件名要靠 `Content-Disposition` 编码，
 * 而两处各写一套的结果是"同一份导出在两条链路上文件名编码不同"。
 *
 * 权限与导入本身同一道门（`canImport`）：模板里没有业务数据，但它与导入是同一件事的
 * 两半，只放一半等于让非 L1 拿到"怎么填"的说明书却没有"能不能导"的答案。
 */
const templateQuerySchema = z.object({
  hostType: z.enum(IMPORT_KINDS, { message: "请选择要下载的模板类型" }),
});

export async function GET(req: Request) {
  const q = await query(req, templateQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => {
    if (!canImport(actor)) return importForbidden();
    return json(await importTemplate(q.data.hostType));
  });
}

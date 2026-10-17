import { useQuery } from "@tanstack/react-query";

import type { ImportKind } from "@/shared/enums/import";
import { api } from "./api";
import type { ImportBatchListDto, ImportCsvDto, ImportSummaryDto } from "./import-ui";

/**
 * 批量导入（F7-4 / P14）的客户端读取层 —— 与 `api-parties.ts` / `api-reports.ts` 同形。
 *
 * 口径与 `api.ts` 顶部那条注释一致：**页面壳不预取业务数据**（禁令⑥），真数据由
 * 客户端经 `/api/**` 取、鉴权在 handler 内做（禁令⑤）。401 由 `api.ts` 统一跳登录。
 *
 * ⚠ 这里的返回类型与四条路由的响应逐字对应：服务端改了字段，这一层先在 `tsc` 上红。
 * 类型定义住在 `./import-ui`（与计数口径同处一个纯模块），本文件只做"取"。
 */

/**
 * 三张模板的下载（`GET /api/import/templates?hostType=…`）。
 *
 * 出口形状与整卷导出、当事人导出一致：**JSON 里带 `csv` 文本**，前端 `downloadCsv` 落盘。
 * 本仓没有任何路由直接吐 `text/csv`（中文文件名要靠 `Content-Disposition` 编码，两处各写一套
 * 会让同一份导出在两条链路上文件名编码不同），所以这里也走同一条路。
 */
export function fetchTemplate(kind: ImportKind): Promise<ImportCsvDto> {
  return api.get<ImportCsvDto>(`/api/import/templates?hostType=${encodeURIComponent(kind)}`);
}

/** 错误报告下载。`reportRef` = 批次 id（与 `BULK_IMPORT` 载荷里的 `report_ref` 同源） */
export function fetchReport(reportRef: string): Promise<ImportCsvDto> {
  return api.get<ImportCsvDto>(`/api/import/report/${encodeURIComponent(reportRef)}`);
}

/** 提交一次导入。请求体是 JSON `{hostType, fileName, csv}`（不是 multipart，理由见路由文件头） */
export function runImport(payload: {
  hostType: ImportKind;
  fileName: string;
  csv: string;
}): Promise<ImportSummaryDto> {
  return api.post<ImportSummaryDto>("/api/import", payload);
}

/**
 * 最近几次导入。存在的理由就是路由文件头那句：**用户会把标签页关掉**，
 * 而报告入口必须能从列表回到手上 —— 否则"三个月前那批哪些行没进去"就只剩审计里的一个 id。
 *
 * `retry: false`：403 是**确定的**结果，重试三次只是把同一句拒绝念三遍。
 */
export function useImportBatches() {
  return useQuery({
    queryKey: ["import-batches"],
    queryFn: () => api.get<ImportBatchListDto>("/api/import/batches"),
    retry: false,
  });
}

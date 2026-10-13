import { useQuery } from "@tanstack/react-query";

import { api, type PartySearchResult } from "./api";
import { toQuery, type ListState } from "./use-list-state";

/**
 * 当事人（对手方档案）的客户端读取层 —— MATT-40 的列表页与详情页共用。
 *
 * 为什么另起一个文件而不是塞进 `api.ts`：那张文件已被另一条并行流占用（本票写范围外），
 * 而当事人这一块自己就有五组类型（列表行/详情/导出载荷/写载荷/合并结果）。
 * 口径与 `api.ts` 一致：**页面壳不预取业务数据**（禁令⑥），真数据由客户端经 `/api/**` 取，
 * 鉴权在 handler 内做；401 由 `api.ts` 的 `request` 统一跳登录。
 *
 * ⚠ 这里的字段名与 `/api/parties` 的响应**逐字对应**：服务层改了 select 列，
 * 这一层会先在 `tsc` 上红，而不是让页面某处 `undefined`（`api.ts` 顶部那条注释同一个理由）。
 */

export type PartyRow = {
  id: string;
  name: string;
  type: string;
  idType: string | null;
  /** 展示层全明文（IQ-12）：列表里也是明文，**没有"显示明文"按钮** */
  idNumber: string | null;
  contact: string | null;
  remark: string | null;
  /** 只数"我看得见的"宿主 —— 与详情页列出来的行数对得上 */
  matterCount: number;
  riskCount: number;
  updatedAt: string;
};

export type PartyListResult = {
  items: PartyRow[];
  page: number;
  pageSize: number;
  total: number;
};

export type PartyInvolvedMatterDto = {
  id: string;
  internalCode: string;
  name: string;
  status: string;
  isArchived: boolean;
  /** 对方在该案中的地位（E06，相对我方视角） */
  partyRole: string;
  /** 我方在该案中的地位（E12）—— 与上一列并排才是"相对我方视角" */
  ourLitigationRole: string;
  updatedAt: string;
};

export type PartyInvolvedRiskDto = {
  id: string;
  code: string;
  name: string;
  status: string;
  isArchived: boolean;
  partyRole: string;
  updatedAt: string;
};

export type PartyDetailDto = {
  id: string;
  name: string;
  type: string;
  idType: string | null;
  idNumber: string | null;
  contact: string | null;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  /** 并进本档案的那些（主记录才有）。被并方自己是软删行，接口给 404 —— 去向只在主记录这一页看 */
  mergedIn: { id: string; name: string; mergedAt: string | null }[];
  matters: PartyInvolvedMatterDto[];
  risks: PartyInvolvedRiskDto[];
  /** 库里有、但你的数据范围看不到的条数 —— 界面必须说出来（§7.2） */
  hidden: { matters: number; risks: number };
  truncated: { matters: boolean; risks: boolean };
};

export type PartyExportPayload = {
  plain: boolean;
  count: number;
  /** 命中超过上限（1000 行）时为 true —— 静默截断等于给了一份假全量 */
  truncated: boolean;
  csv: string;
};

export type PartyCreatePayload = {
  name: string;
  type: string;
  idType?: string;
  idNumber?: string;
  contact?: string;
  remark?: string;
};

export type PartyMergeResult = {
  survivingId: string;
  mergedIds: string[];
  /** 改挂到主记录的关联行数 */
  moved: number;
  /** 同一宿主上主记录已在该当事人、因此被丢掉的关联行数 */
  dropped: number;
};

export function useParties(state: ListState) {
  return useQuery({
    queryKey: ["parties", state],
    queryFn: () => api.get<PartyListResult>(`/api/parties?${toQuery(state)}`),
  });
}

export function useParty(id: string) {
  return useQuery({
    queryKey: ["party", id],
    queryFn: () => api.get<PartyDetailDto>(`/api/parties/${id}`),
  });
}

/**
 * 名字查重 + 本企业名提示（防呆的**提示面**，写路径的闸门在服务端）。
 *
 * 走的就是建案下拉那个检索接口（`?q=`）：它顺带回一个 `ownCompany` 布尔，
 * 判定在服务端一处实现（`isOwnCompanyName`）—— 前端再写一份"像不像本企业名"的
 * 比较逻辑，就会有两份会漂移的规则，而防呆的失败形态恰恰是"界面说没问题、服务端拒了"。
 * 同一次请求还带回了同名命中（检索本来就是按名称模糊匹配的），于是
 * "库里已有同名"这句提示也不需要第二个接口。
 *
 * `staleTime` 60 秒：同一个名字在表单里被反复读到，不该反复敲库。
 */
export function usePartyNameCheck(name: string) {
  const kw = name.trim();
  return useQuery({
    queryKey: ["party-name-check", kw],
    queryFn: () =>
      api.get<PartySearchResult & { ownCompany: boolean }>(
        `/api/parties?q=${encodeURIComponent(kw)}`,
      ),
    enabled: kw.length > 0,
    staleTime: 60_000,
  });
}

/**
 * 下载服务端拼好的 CSV。
 *
 * 为什么不在浏览器里拼 CSV：格式（引号、逗号、换行、BOM）只有一处实现，
 * 它才能被离线单测；浏览器只负责"把这段文本变成一次下载"。
 * BOM 由服务端写在文本开头（Excel 认它），这里用 `text/csv;charset=utf-8` 保持一致。
 */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

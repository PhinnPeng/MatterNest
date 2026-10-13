import { useQuery } from "@tanstack/react-query";

import { api } from "./api";

/**
 * 报表两卡的客户端读取层（MATT-46）。
 *
 * 类型与服务层 `services/reports.ts` 的返回形状逐字对应，**但不 import 服务层**：
 * 那会把 DB 驱动拖进浏览器 bundle（禁令⑥ 的同一理由，只是那条只扫 page/layout）。
 * 两份声明能同时存在是因为这里只有类型——没有一处会跑的逻辑被抄第二遍。
 *
 * 这个文件里没有求和、没有分组：行、列、合计都由 `/api/reports` 摆好，
 * 界面拿到的就是格子本身（§4.7 第 5 条）。
 */

export type MatrixColumn = { code: string; total: number };

export type MatterMatrix = {
  total: number;
  /** 列 = 我方诉讼地位（只有有数据的那些），顺序由服务端按枚举表 E12 排 */
  roles: MatrixColumn[];
  /** 行 = 状态 × 等级；同一状态的行相邻，`statusTotal` 是状态小计（画合并单元格用） */
  rows: {
    status: string;
    statusTotal: number;
    level: string;
    total: number;
    /** 诉讼地位 code → 计数；缺键 = 该格为 0 */
    counts: Record<string, number>;
  }[];
};

export type RiskMatrix = {
  total: number;
  /** 列 = 风险等级（只有有数据的那些），顺序由服务端按配置 sort_order 排 */
  levels: MatrixColumn[];
  rows: { status: string; total: number; counts: Record<string, number> }[];
};

export type NodeDeadlineCard = {
  total: number;
  /** 档位与中文名都随响应下发：界面按这个顺序画列，不自己定义档位 */
  buckets: { key: string; label: string }[];
  rows: { kind: string; total: number; counts: Record<string, number> }[];
  /** 每档合计（表尾那一行）。服务端算好——界面连表尾都不求和 */
  bucketTotals: Record<string, number>;
};

export type ReportsPayload = {
  archivedOnly: boolean;
  matters: MatterMatrix;
  risks: RiskMatrix;
  nodes: NodeDeadlineCard;
};

/**
 * `staleTime` 60 秒：到期档与计数都是按"现在"算的，隔一分钟就可能变档；
 * 但报表不该每次进页面都敲一遍库，所以给一分钟新鲜度 + 页头的手动刷新
 * （与工作台 `/api/overview` 同一个口径）。
 */
export function useReports(archivedOnly: boolean) {
  return useQuery({
    queryKey: ["reports", archivedOnly],
    queryFn: () => api.get<ReportsPayload>(`/api/reports${archivedOnly ? "?archivedOnly=1" : ""}`),
    staleTime: 60_000,
  });
}

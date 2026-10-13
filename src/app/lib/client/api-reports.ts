import { useQuery } from "@tanstack/react-query";

import { api, type HostKind } from "./api";

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
  /**
   * 两个宿主恒各一行（0 也留着）。`kind` 收成 `HostKind` 而不是 `string`：
   * 界面要用它去查 `HOST_TYPE_LABELS`，收窄之后"服务端加了第三个宿主、界面还是两行"
   * 这种事编译期就红，不用等看到一张少一行的卡。
   */
  rows: { kind: HostKind; total: number; counts: Record<string, number> }[];
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
 * 读数。`query` 是**已经拼好的请求串**（`use-list-state.ts` 的 `toReportQuery`），
 * 不是一堆参数：这样 queryKey 与真正发出去的请求逐字同源——"参数变了但 key 没变"
 * （于是卡片不跟着筛选变）在类型层就写不出来。
 *
 * 没有 `staleTime`：卡片现在长在列表页顶部，而列表的契约是"每次筛选都重新取"。
 * 给 60 秒新鲜度会让"列表 21 行、卡片 20"同时成立——两个数字挨着显示却对不上，
 * 比多敲一次库贵得多（上一版独立报表页给 60 秒是因为它自己就是一张页）。
 */
export function useReports(query: string) {
  return useQuery({
    queryKey: ["reports", query],
    queryFn: () => api.get<ReportsPayload>(`/api/reports${query ? `?${query}` : ""}`),
  });
}

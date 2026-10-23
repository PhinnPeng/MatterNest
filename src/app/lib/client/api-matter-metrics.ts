import { useQuery } from "@tanstack/react-query";

import { api } from "./api";
import type { ListState } from "./use-list-state";
import { toQuery } from "./use-list-state";

/**
 * 案件列表顶部六格指标的客户端读取层（2026-10-19，canon `matters.html` 的 `.metrics`）。
 *
 * 类型与服务层 `services/matters.ts` 的 `MatterMetrics` 逐字对应，**但不 import 服务层**
 * ——那会把 DB 驱动拖进浏览器 bundle（与 `api-reports.ts` 同一条理由）。
 * 两份声明并存是安全的：这里只有类型，没有一处会跑的逻辑被抄第二遍。
 *
 * 请求串直接用列表那份 `toQuery`：**指标按什么筛，必须与列表按什么筛逐字相同**。
 * 各拼一份请求串的失败形态是"列表 3 行、卡片说 12 条"，而两边都不报错
 * （`ownerEmpty` 漏进 `toQuery` 时就出过这种事故，见 `use-list-state.spec.ts` 文件头）。
 */
export type MatterMetrics = {
  total: number;
  overdue: number;
  soon: number;
  unassigned: number;
  timeUnconfirmed: number;
  createdThisMonth: number;
};

export function useMatterMetrics(filters: ListState) {
  return useQuery({
    // key 里带整份筛选：筛选一变就重取，不会把上一组条件的读数当成这一组的
    queryKey: ["matters-metrics", filters],
    queryFn: () => api.get<MatterMetrics>(`/api/matters/metrics?${toQuery(filters)}`),
  });
}

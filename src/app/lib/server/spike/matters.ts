import type { ListQuery } from "@/shared/schema/list-query";

/**
 * N7 spike 的假数据源与查询实现（**不是业务代码**，W1-1 真表落地后整目录删掉）。
 *
 * 存在的意义：让"服务端分页/排序/筛选"这条链路在没有数据库和 `ScopeResolver` 的情况下
 * 也能被真实调用与测试。`queryMatters` 是纯函数——Route Handler 只做参数解析与响应封装，
 * 这样排序/筛选/分页的正确性才能在 vitest 里断言（W2-1 的仓储层也按这个形状写）。
 */

import type { SpikeMatter } from "@/shared/schema/spike-matter";

const OWNERS = ["陈律师", "李律师", "王律师", "赵实习"];
const STATUSES = ["pending", "in_progress", "closed", "archived"] as const;
const LEVELS = ["high", "medium", "low"] as const;

/** 确定性生成（不引随机库，也不 Math.random）：同一 seed 序列在测试与 dev 里结果一致。 */
export function buildSpikeRows(count: number): SpikeMatter[] {
  const rows: SpikeMatter[] = [];
  for (let i = 0; i < count; i += 1) {
    const day = String((i % 28) + 1).padStart(2, "0");
    rows.push({
      id: String(1_000_000_000_000_000_000n + BigInt(i)),
      code: `AJ-202609${String((i % 12) + 1).padStart(2, "0")}-${day}`,
      name: `事项 ${i + 1} 号合同纠纷`,
      status: STATUSES[i % STATUSES.length] as (typeof STATUSES)[number],
      risk_level: LEVELS[(i >> 1) % LEVELS.length] as (typeof LEVELS)[number],
      owner_name: OWNERS[i % OWNERS.length] as string,
      amount: `${(i + 1) * 1000}.00`,
      updated_at: `2026-09-${day}T09:00:00Z`,
    });
  }
  return rows;
}

export const SPIKE_ROWS: SpikeMatter[] = buildSpikeRows(237);

const NUMERIC_COLUMNS = new Set(["amount"]);

function compare(a: SpikeMatter, b: SpikeMatter, key: keyof SpikeMatter): number {
  const av = a[key];
  const bv = b[key];
  if (NUMERIC_COLUMNS.has(key)) return Number(av) - Number(bv);
  return String(av).localeCompare(String(bv), "zh-Hans-CN");
}

/** 排序 → 筛选 → 分页。**分页在服务端做**，客户端拿到的永远是当页。 */
export function queryMatters(
  rows: SpikeMatter[],
  q: Pick<ListQuery, "page" | "pageSize" | "sortBy" | "sortDir" | "status" | "keyword">,
): { items: SpikeMatter[]; total: number } {
  let out = rows;

  if (q.status) out = out.filter((r) => r.status === q.status);
  if (q.keyword) {
    const kw = q.keyword.toLowerCase();
    out = out.filter((r) => `${r.code} ${r.name} ${r.owner_name}`.toLowerCase().includes(kw));
  }

  const sorted = [...out].sort((x, y) => compare(x, y, q.sortBy));
  if (q.sortDir === "desc") sorted.reverse();

  const start = (q.page - 1) * q.pageSize;
  return { items: sorted.slice(start, start + q.pageSize), total: sorted.length };
}

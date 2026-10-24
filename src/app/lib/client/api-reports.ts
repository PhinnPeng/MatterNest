"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/app/lib/client/api";
import type {
  RecentProgressDays,
  RecentProgressPayload,
  RecentProgressScope,
} from "@/shared/schema/reports";

/**
 * 报表 · 最近进展（2026-10-24）。
 *
 * queryKey 用真正发出去的那组参数：scope/days/page 任一变化都必须重取，
 * 否则切到「最近事项」会拿到案件那一页的缓存。
 */
export type RecentProgressParams = {
  scope: RecentProgressScope;
  days: RecentProgressDays;
  page: number;
  pageSize: number;
};

export function recentProgressQuery(p: RecentProgressParams): string {
  return new URLSearchParams({
    scope: p.scope,
    days: p.days,
    page: String(p.page),
    pageSize: String(p.pageSize),
  }).toString();
}

export function useRecentProgress(p: RecentProgressParams) {
  return useQuery({
    queryKey: ["recent-progress", p.scope, p.days, p.page, p.pageSize],
    queryFn: () =>
      api.get<RecentProgressPayload>(`/api/reports/recent-progress?${recentProgressQuery(p)}`),
  });
}

/** 导出的响应形状与列表导出同形（`downloadCsv` 只认 `csv`）。 */
export type RecentProgressExport = { rows: number; truncated: boolean; csv: string };

export function recentProgressExportPath(scope: RecentProgressScope, days: RecentProgressDays) {
  return `/api/reports/recent-progress/export?${new URLSearchParams({ scope, days })}`;
}

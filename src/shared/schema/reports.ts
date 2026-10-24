import { z } from "zod";

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./list-query";

/**
 * 「报表 · 最近进展」的查询契约（2026-10-24 用户裁定新增）。
 *
 * 与列表分开的一份：报表按**最近进展的录入时刻**排序，没有关键词/状态那套筛选。
 * `scope` 沿用宿主名（`matter` / `risk_matter`），页面用「最近案件 / 最近事项」两个入口。
 */
export const RECENT_PROGRESS_SCOPES = ["matter", "risk_matter"] as const;
export const RECENT_PROGRESS_DAYS = ["7", "30", "90", "all"] as const;

export type RecentProgressScope = (typeof RECENT_PROGRESS_SCOPES)[number];
export type RecentProgressDays = (typeof RECENT_PROGRESS_DAYS)[number];

export const recentProgressQuerySchema = z.object({
  scope: z.enum(RECENT_PROGRESS_SCOPES).default("matter"),
  days: z.enum(RECENT_PROGRESS_DAYS).default("30"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type RecentProgressQuery = z.infer<typeof recentProgressQuerySchema>;

/** 导出跟列表导出同一条口径：没有分页，只有当前筛选。 */
export const recentProgressExportQuerySchema = z.object({
  scope: z.enum(RECENT_PROGRESS_SCOPES).default("matter"),
  days: z.enum(RECENT_PROGRESS_DAYS).default("30"),
});
export type RecentProgressExportQuery = z.infer<typeof recentProgressExportQuerySchema>;

export type RecentProgressItem = {
  hostId: string;
  /** 案件 = 案号（可空 → "—"），事项 = 编号 */
  code: string;
  name: string;
  progressType: string;
  progressLabel: string;
  content: string;
  /** 录入时刻：排序与时间窗口都用它 */
  progressAt: string;
  owner: string | null;
};

export type RecentProgressPayload = {
  scope: RecentProgressScope;
  days: RecentProgressDays;
  page: number;
  pageSize: number;
  total: number;
  items: RecentProgressItem[];
};

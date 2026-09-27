"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/shared/schema/list-query";

/**
 * 列表状态放在 **URL** 里，而不是组件 state。
 *
 * 四个理由，按分量排：
 *   1. 内网系统里"把这个筛选结果发给同事看"是真实诉求，URL 是唯一能承载它的地方；
 *   2. 浏览器的前进/后退自然回到上一个筛选态，不需要自己维护历史；
 *   3. 详情页返回列表时筛选不丢（组件被卸载了，URL 还在）；
 *   4. 服务端只认查询串，所以"前端传什么服务端信什么"这条越权面在这里被压成零：
 *      参数照样要过 `listQuerySchema`（禁令⑧），URL 只是搬运工。
 *
 * `pageSize` 越界**不在这里夹**：让 URL 上的 `pageSize=500` 原样发出去，
 * 由服务端 400 + 前端显示错误条。静默夹小等于把违规参数藏起来。
 */
export type ListState = {
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  keyword: string;
  status: string;
  includeArchived: boolean;
};

export function useListState(defaults?: Partial<ListState>) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const state = useMemo<ListState>(
    () => ({
      page: Number(sp.get("page") ?? 1) || 1,
      pageSize:
        Number(sp.get("pageSize") ?? defaults?.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE,
      sortBy: sp.get("sortBy") ?? defaults?.sortBy ?? "updated_at",
      sortDir: sp.get("sortDir") === "asc" ? "asc" : "desc",
      keyword: sp.get("keyword") ?? "",
      status: sp.get("status") ?? "",
      includeArchived: sp.get("includeArchived") === "1" || sp.get("includeArchived") === "true",
    }),
    [sp, defaults?.pageSize, defaults?.sortBy],
  );

  /** `patch` 里值为空/默认值的键会被删掉，URL 保持干净（`?status=&page=1` 那种噪音） */
  const push = useCallback(
    (patch: Partial<Record<keyof ListState, string | number | boolean>>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === "" || v === undefined || v === false) next.delete(k);
        else next.set(k, String(v));
      }
      // 改了筛选条件就回到第 1 页——除非这次调用本身就是在改页码
      if (!("page" in patch)) next.delete("page");
      const q = next.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [router, pathname, sp],
  );

  const href = useCallback(
    (patch: Partial<Record<keyof ListState, string | number | boolean>>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === "" || v === undefined || v === false) next.delete(k);
        else next.set(k, String(v));
      }
      if (!("page" in patch)) next.delete("page");
      const q = next.toString();
      return q ? `${pathname}?${q}` : pathname;
    },
    [sp, pathname],
  );

  return { state, push, href, maxPageSize: MAX_PAGE_SIZE };
}

/** 把状态拼成请求串（空值不发，免得服务端收到 `keyword=`）。 */
export function toQuery(s: ListState): string {
  const p = new URLSearchParams();
  p.set("page", String(s.page));
  p.set("pageSize", String(s.pageSize));
  p.set("sortBy", s.sortBy);
  p.set("sortDir", s.sortDir);
  if (s.keyword) p.set("keyword", s.keyword);
  if (s.status) p.set("status", s.status);
  if (s.includeArchived) p.set("includeArchived", "1");
  return p.toString();
}

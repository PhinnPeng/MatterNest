"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { type LegacyColumnDef } from "@tanstack/react-table/legacy";

import { DataTable, selectionColumn } from "@/app/components/ui/data-table/DataTable";
import { listQuerySchema, type ListQuery } from "@/shared/schema/list-query";
import { format } from "date-fns";
import { APP_LOCALE, DATE_COMPACT_PATTERN } from "@/shared/time/zh-cn";

import { spikeMatterListResultSchema, type SpikeMatter } from "@/shared/schema/spike-matter";

const STATUS_LABEL: Record<string, string> = {
  pending: "待受理",
  in_progress: "进行中",
  closed: "已结案",
  archived: "已归档",
};

const LEVEL_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };

/**
 * N7 的表格半截：参数放 **URL 搜索参数**（`state-management.md` 里那条"URL 态"口径的实测），
 * 翻页/排序都只改 URL，react-query 的 key 跟着变 → 分享链接能复现同一视图。
 */
export function N7Table() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // 同一份 schema 在客户端也 parse 一次：URL 是用户可改的，不能当可信输入
  const query: ListQuery = useMemo(
    () => listQuerySchema.parse(Object.fromEntries(sp.entries())),
    [sp],
  );

  const { data, isFetching } = useQuery({
    queryKey: ["spike-matters", query],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(query.page),
        pageSize: String(query.pageSize),
        sortBy: query.sortBy,
        sortDir: query.sortDir,
        ...(query.status ? { status: query.status } : {}),
        ...(query.keyword ? { keyword: query.keyword } : {}),
      });
      const res = await fetch(`/api/spike/matters?${params.toString()}`);
      if (!res.ok) throw new Error(`接口返回 ${res.status}`);
      // 响应也过一遍 DTO：接口形状变了当场红，而不是渲染时 undefined
      return spikeMatterListResultSchema.parse(await res.json());
    },
    staleTime: 30_000,
  });

  const push = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    router.replace(`${pathname}?${next.toString()}`);
  };

  const columns = useMemo<LegacyColumnDef<SpikeMatter, unknown>[]>(
    () => [
      selectionColumn<SpikeMatter>(),
      { id: "code", header: "案号", cell: ({ row }) => row.original.code },
      { id: "name", header: "案件名称", cell: ({ row }) => row.original.name },
      {
        id: "status",
        header: "状态",
        cell: ({ row }) => STATUS_LABEL[row.original.status] ?? row.original.status,
      },
      {
        id: "risk_level",
        header: "风险等级",
        cell: ({ row }) => LEVEL_LABEL[row.original.risk_level] ?? "-",
      },
      { id: "owner_name", header: "承办人", cell: ({ row }) => row.original.owner_name },
      { id: "amount", header: "标的金额", cell: ({ row }) => row.original.amount },
      {
        id: "updated_at",
        header: "更新时间",
        cell: ({ row }) =>
          format(new Date(row.original.updated_at), DATE_COMPACT_PATTERN, { locale: APP_LOCALE }),
      },
    ],
    [],
  );

  return (
    <DataTable
      columns={columns}
      rows={data?.items ?? []}
      total={data?.total ?? 0}
      page={query.page}
      pageSize={query.pageSize}
      sortBy={query.sortBy}
      sortDir={query.sortDir}
      loading={isFetching}
      onPageChange={(p) => push({ page: String(p) })}
      onSortChange={(col, dir) => push({ sortBy: col, sortDir: dir, page: "1" })}
    />
  );
}

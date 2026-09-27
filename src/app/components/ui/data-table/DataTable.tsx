"use client";

import { flexRender } from "@tanstack/react-table";
import {
  getCoreRowModel,
  useLegacyTable,
  type LegacyColumnDef,
  type LegacyRow,
} from "@tanstack/react-table/legacy";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { MAX_PAGE_SIZE } from "@/shared/schema/list-query";

/**
 * `DataTable` —— 全项目唯一的数据表入口（禁令⑧）。
 *
 * ### 为什么 import 来自 `@tanstack/react-table/legacy`
 * N7 spike 实测：`@tanstack/react-table` 已出到 **v9.2.4**，而 v9 是破坏性重设计——主入口没有
 * `useReactTable` / `getCoreRowModel` / `VisibilityState`，泛型也改成 **feature-first**
 * （`ColumnDef<TFeatures, TData, TValue>`，把 TData 写在第一位会报 "does not satisfy the constraint
 * TableFeatures"）。shadcn 的 Data Table 文档与 registry 示例全部按 v8 形状写。
 * v9 官方留了兼容层 `useLegacyTable` + `getXRowModel`，所以**留在 v9、显式走 legacy 入口**：
 * 比降级版本好（不锁死升级路），也比改学新 API 好（`useLegacyTable` 这个名字本身就声明了"这是 v8 形状"）。
 *
 * ### 三条不可商量的设计点
 * 1. **受控**：`page / pageSize / sortBy / sortDir` 由调用方给，组件内部不维护分页与排序态；
 * 2. **只装 core row model**：不装 `getSortedRowModel` / `getPaginationRowModel` / `getFilteredRowModel`——
 *    装了就等于允许客户端全量排序，而禁令⑧ 的理由是权限不是性能（客户端全量筛＝绕过 `ScopeResolver`）；
 * 3. `pageSize > MAX_PAGE_SIZE` **直接抛**，不静默夹小——静默夹小会让调用方以为已经拉全了。
 */
export interface DataTableProps<TData extends Record<string, unknown>> {
  columns: LegacyColumnDef<TData, unknown>[];
  /** **只当页数据**。传全量进来就是误用。 */
  rows: TData[];
  page: number;
  pageSize: number;
  total: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  onPageChange: (page: number) => void;
  onSortChange: (column: string, dir: "asc" | "desc") => void;
  onSelectionChange?: (rows: TData[]) => void;
  loading?: boolean;
  emptyHint?: ReactNode;
}

export function DataTable<TData extends Record<string, unknown>>(props: DataTableProps<TData>) {
  const {
    columns,
    rows,
    page,
    pageSize,
    total,
    sortBy,
    sortDir,
    onPageChange,
    onSortChange,
    onSelectionChange,
    loading = false,
    emptyHint = "没有符合条件的记录",
  } = props;

  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});
  // v9 的 RowSelectionState 是 Record<string, true>（不是 boolean）——写错会在 state 上传不进去
  const [rowSelection, setRowSelection] = useState<Record<string, true>>({});

  if (pageSize > MAX_PAGE_SIZE) {
    throw new Error(`DataTable: pageSize=${pageSize} 超过上限 ${MAX_PAGE_SIZE}（禁令⑧）`);
  }

  const table = useLegacyTable<TData>({
    data: rows,
    columns,
    state: { sorting: [{ id: sortBy, desc: sortDir === "desc" }], columnVisibility, rowSelection },
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    getCoreRowModel: getCoreRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: (updater) => {
      const next = typeof updater === "function" ? updater({}) : updater;
      setRowSelection(next);
      onSelectionChange?.(pickSelected(rows, next));
    },
  });

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const selectedCount = Object.values(rowSelection).filter(Boolean).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          共 {total} 条 · 第 {page}/{pageCount} 页 · 每页 {pageSize} 条 · 本页已选 {selectedCount}{" "}
          条
        </p>
        <div className="flex flex-wrap gap-1">
          {table
            .getAllColumns()
            .filter((col) => col.getCanHide())
            .map((col) => (
              <Button
                key={String(col.id)}
                type="button"
                size="sm"
                variant={col.getIsVisible() ? "outline" : "ghost"}
                className={cn("text-xs", !col.getIsVisible() && "text-muted-foreground")}
                onClick={() => col.toggleVisibility()}
              >
                {typeof col.columnDef.header === "string" ? col.columnDef.header : String(col.id)}
              </Button>
            ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full caption-bottom text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b bg-muted/40">
                {hg.headers.map((header) => {
                  const id = String(header.column.id);
                  const active = sortBy === id;
                  return (
                    <th key={header.id} className="h-9 px-3 text-left align-middle font-medium">
                      {header.isPlaceholder ? null : (
                        <button
                          type="button"
                          disabled={!header.column.getCanSort()}
                          className="inline-flex items-center gap-1 enabled:hover:underline"
                          onClick={() =>
                            onSortChange(id, active && sortDir === "asc" ? "desc" : "asc")
                          }
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {active ? (
                            sortDir === "asc" ? (
                              <ArrowUp className="size-3" />
                            ) : (
                              <ArrowDown className="size-3" />
                            )
                          ) : (
                            <ChevronsUpDown className="size-3 opacity-40" />
                          )}
                        </button>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="h-16 px-3 text-center text-sm text-muted-foreground"
                >
                  {loading ? "加载中…" : emptyHint}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id} className={cn("border-b", row.getIsSelected() && "bg-muted/40")}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-1.5 align-middle">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          上一页
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}

function pickSelected<TData extends Record<string, unknown>>(
  rows: TData[],
  selection: Record<string, boolean>,
): TData[] {
  const out: TData[] = [];
  for (const [index, selected] of Object.entries(selection)) {
    const row = rows[Number(index)];
    if (selected && row !== undefined) out.push(row);
  }
  return out;
}

/** 选择列的公共实现，避免每张表各写一遍 checkbox。 */
export function selectionColumn<TData extends Record<string, unknown>>(): LegacyColumnDef<
  TData,
  unknown
> {
  return {
    id: "select",
    enableSorting: false,
    enableHiding: false,
    header: ({ table }) => (
      <input
        type="checkbox"
        aria-label="全选本页"
        checked={table.getIsAllPageRowsSelected()}
        onChange={table.getToggleAllPageRowsSelectedHandler()}
      />
    ),
    cell: ({ row }: { row: LegacyRow<TData> }) => (
      <input
        type="checkbox"
        aria-label="选择该行"
        checked={row.getIsSelected()}
        onChange={row.getToggleSelectedHandler()}
      />
    ),
  };
}

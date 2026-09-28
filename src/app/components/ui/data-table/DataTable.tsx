"use client";

import { flexRender } from "@tanstack/react-table";
import {
  getCoreRowModel,
  useLegacyTable,
  type LegacyColumnDef,
  type LegacyRow,
} from "@tanstack/react-table/legacy";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/app/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { StateBlock } from "@/app/components/ui/state-block";
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
 * ### 四条不可商量的设计点
 * 1. **受控**：`page / pageSize / sortBy / sortDir` 由调用方给，组件内部不维护分页与排序态；
 * 2. **只装 core row model**：不装 `getSortedRowModel` / `getPaginationRowModel` / `getFilteredRowModel`——
 *    装了就等于允许客户端全量排序，而禁令⑧ 的理由是权限不是性能（客户端全量筛＝绕过 `ScopeResolver`）；
 * 3. `pageSize > MAX_PAGE_SIZE` **直接抛**，不静默夹小——静默夹小会让调用方以为已经拉全了；
 * 4. 表格骨架一律走 `ui/table.tsx` 那组原语，本文件不再自带一份 `<thead>/<tbody>` 样式：
 *    两张列表页 + 详情页内嵌表共用一套单元格刻度，这是"一套组件体系"（禁令⑦）在这张组件上的落点。
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
  /** 行主键，用于 React key 与"点行跳转"；不给则退回行号 */
  rowKey?: (row: TData) => string;
  onRowOpen?: (row: TData) => void;
  empty?: ReactNode;
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
    rowKey,
    onRowOpen,
    empty = "没有符合条件的记录",
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
  const selectedCount = Object.keys(rowSelection).length;
  const visible = table.getVisibleLeafColumns();

  /**
   * 空态**不画表头**。半张空表格比什么都没有更容易被读成"接口挂了"，
   * 而这里的空绝大多数时候是真的空（范围收窄或筛得太窄），要给用户下一步。
   */
  if (!loading && rows.length === 0) {
    return <StateBlock title="这张列表现在是空的" hint={empty} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          共 <span className="num">{total}</span> 条 · 第 <span className="num">{page}</span>/
          <span className="num">{pageCount}</span> 页 · 每页 <span className="num">{pageSize}</span>{" "}
          条{selectedCount ? ` · 本页已选 ${selectedCount} 条` : ""}
        </p>
        <div className="flex flex-wrap gap-1">
          {/* 列显隐：内网系统里"我只看编号/状态/到期"是真实诉求，做在一处比每张表各写一遍强 */}
          {table
            .getAllColumns()
            .filter((col) => col.getCanHide())
            .map((col) => (
              <Button
                key={String(col.id)}
                type="button"
                size="xs"
                variant={col.getIsVisible() ? "outline" : "ghost"}
                className={cn(!col.getIsVisible() && "text-muted-foreground")}
                onClick={() => col.toggleVisibility()}
              >
                {typeof col.columnDef.header === "string" ? col.columnDef.header : String(col.id)}
              </Button>
            ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table className="table-fixed">
          {/*
            table-fixed 只尊重**显式列宽**，所以尺寸必须从这里给。
            之前只在列定义里传了 `size`——那是 TanStack 的元数据，没有 colgroup 消费它，
            实测「程序」「等级」两列被 auto layout 压到 45px（刚好包住表头文字）。
            flexRender 出来的列顺序（含列显隐后的可见列）都按 getVisibleLeafColumns 走，
            所以 colgroup 与 th/td 永远是同一套宽度，不会错位。
          */}
          <colgroup>
            {table.getVisibleLeafColumns().map((col) => (
              <col key={String(col.id)} style={{ width: `${col.getSize()}px` }} />
            ))}
          </colgroup>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => {
                  const id = String(header.column.id);
                  const active = sortBy === id;
                  const sortable = header.column.getCanSort();
                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : sortable ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                          aria-sort={
                            active ? (sortDir === "asc" ? "ascending" : "descending") : "none"
                          }
                          onClick={() =>
                            onSortChange(id, active && sortDir === "asc" ? "desc" : "asc")
                          }
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {active ? (
                            sortDir === "asc" ? (
                              <ArrowUpIcon className="size-3 text-primary" />
                            ) : (
                              <ArrowDownIcon className="size-3 text-primary" />
                            )
                          ) : (
                            <ChevronsUpDownIcon className="size-3 opacity-30" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody className={cn(loading && "opacity-60")}>
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={rowKey ? rowKey(row.original) : row.id}
                data-state={row.getIsSelected() ? "selected" : undefined}
                className={onRowOpen ? "cursor-pointer" : undefined}
                onClick={onRowOpen ? () => onRowOpen(row.original) : undefined}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {/* 列数为 0 时（全部隐藏）TableBody 什么都不渲染，这里补一句而不是留一张空壳 */}
        {visible.length === 0 ? (
          <p className="border-t border-border px-3 py-6 text-center text-xs text-muted-foreground">
            所有列都被隐藏了，点上面的列名恢复。
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <p className="text-[0.68rem] text-muted-foreground">
          排序与分页都在服务端做，这里只装当页。
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={page <= 1 || loading}
            onClick={() => onPageChange(page - 1)}
          >
            上一页
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={page >= pageCount || loading}
            onClick={() => onPageChange(page + 1)}
          >
            下一页
          </Button>
        </div>
      </div>
    </div>
  );
}

function pickSelected<TData extends Record<string, unknown>>(
  rows: TData[],
  selection: Record<string, true>,
): TData[] {
  const out: TData[] = [];
  for (const index of Object.keys(selection)) {
    const row = rows[Number(index)];
    if (row !== undefined) out.push(row);
  }
  return out;
}

/**
 * 列定义类型也从这一层再导出。
 * 业务页直连 `@tanstack/react-table/legacy` 拿类型会被 lint-guard 的禁令⑦ 拦下 ——
 * 那不是误伤：类型 import 是"开始自己拼引擎"的第一步，下一步就是 `getSortedRowModel`。
 */
export type { LegacyColumnDef };

/**
 * 选择列的公共实现，避免每张表各写一遍 checkbox。
 */
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
        className="size-3.5 accent-(--primary)"
        checked={table.getIsAllPageRowsSelected()}
        onChange={table.getToggleAllPageRowsSelectedHandler()}
      />
    ),
    cell: ({ row }: { row: LegacyRow<TData> }) => (
      <input
        type="checkbox"
        aria-label="选择该行"
        className="size-3.5 accent-(--primary)"
        checked={row.getIsSelected()}
        onChange={row.getToggleSelectedHandler()}
        onClick={(e) => e.stopPropagation()}
      />
    ),
  };
}

"use client";

import { useMemo, useState } from "react";
import { Button, Card, Checkbox, Dropdown, Flex, Pagination, Table, Typography } from "antd";
import type { TableColumnsType } from "antd";

import { INK } from "@/app/theme/brand";
import { MAX_PAGE_SIZE } from "@/shared/schema/list-query";

/**
 * `DataTable` —— 全站唯一的数据表入口（禁令⑧）。
 *
 * `@ant-design/pro-components` 的 peer 是 `antd ^4.24 || ^5.11`，**不含 antd 6**，
 * 所以 ProTable 那层（查询区 + 工具栏 + 服务端分页表）在这里自己写。它本来就是薄封装，
 * 不可替代的能力没有丢：丢的是"少写 80 行"。
 *
 * 四条不变的东西（换库前后同口径）：
 *   1. **受控**：`page / pageSize / sortBy / sortDir` 由调用方给，本组件不自己维护态
 *      ——状态落在 URL 上（`use-list-state`），刷新、后退、发链接给同事才对得上同一视图；
 *   2. **只声明可排序，不在前端排**：列上给 `sorter: true` 就够了，
 *      **绝不给函数形态的 `sorter`**——那是客户端全量排序，而禁令⑧ 的理由是权限不是性能
 *      （客户端全量筛＝绕过 `scopedWhere`，见 spec/backend）；
 *   3. `pageSize > MAX_PAGE_SIZE` **直接抛**，不静默夹小：静默夹小会让调用方以为已经拉全了；
 *   4. 空态交给 antd 的 `emptyText` 渲染在表体里，但**没有数据时不画合计行**，
 *      避免出现"合计 0 / 共 0 条"这种看起来像算错了的行。
 *
 * 列宽这次是真的生效：给了 `width` + `scroll.x` 之后 antd 走 `table-layout: fixed`。
 * 上一轮在 shadcn 那边就是栽在这——列定义里的 `size` 只是 TanStack 的元数据，没人消费它。
 */
export type DataTableProps<T> = {
  columns: TableColumnsType<T>;
  /** **只当页数据**。传全量进来就是误用。 */
  rows: T[];
  rowKey: (r: T) => string;
  total: number;
  page: number;
  pageSize: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  onSortChange: (key: string, dir: "asc" | "desc") => void;
  onRowOpen?: (row: T) => void;
  /** 可隐藏列的清单；不传就不显示「列」按钮 */
  hideable?: { key: string; title: string }[];
  empty?: React.ReactNode;
  /** 表尾合计行等说明文字 */
  footer?: React.ReactNode;
};

export function DataTable<T extends object>({
  columns,
  rows,
  rowKey,
  total,
  page,
  pageSize,
  loading = false,
  onPageChange,
  onSortChange,
  onRowOpen,
  hideable,
  empty,
  footer,
}: DataTableProps<T>) {
  const [hidden, setHidden] = useState<string[]>([]);

  // 这条抛错是禁令⑧ 的门，不是防御式编程：调用方拿到 500 条就会以为"已经全在这里了"
  if (pageSize > MAX_PAGE_SIZE) {
    throw new Error(`DataTable: pageSize=${pageSize} 超过上限 ${MAX_PAGE_SIZE}（禁令⑧）`);
  }

  const shown = useMemo(
    () => columns.filter((c) => !hidden.includes(String((c as { key?: string }).key ?? ""))),
    [columns, hidden],
  );
  const sumWidth = shown.reduce(
    (acc, c) => acc + (Number((c as { width?: number }).width) || 120),
    0,
  );

  return (
    <Card
      size="small"
      styles={{ body: { padding: 0 } }}
      title={
        <Typography.Text style={{ fontSize: 12, color: INK.muted, fontWeight: 400 }}>
          共 <span className="num">{total}</span> 条
        </Typography.Text>
      }
      extra={
        hideable?.length ? (
          <Dropdown
            trigger={["click"]}
            menu={{
              items: hideable.map((h) => ({
                key: h.key,
                // Checkbox 在 menu item 里要点两下才生效，所以让 Dropdown 的 onClick 关菜单
                label: (
                  <Checkbox
                    checked={!hidden.includes(h.key)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) =>
                      setHidden((prev) =>
                        e.target.checked ? prev.filter((k) => k !== h.key) : [...prev, h.key],
                      )
                    }
                  >
                    {h.title}
                  </Checkbox>
                ),
              })),
            }}
          >
            <Button size="small">列</Button>
          </Dropdown>
        ) : null
      }
    >
      <Table<T>
        size="small"
        rowKey={(r) => rowKey(r)}
        columns={shown}
        dataSource={rows}
        loading={loading}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: sumWidth }}
        locale={empty ? { emptyText: empty } : undefined}
        onChange={(_p, _f, sorter) => {
          const s = Array.isArray(sorter) ? sorter[0] : sorter;
          if (!s?.columnKey || s.order == null) return;
          onSortChange(String(s.columnKey), s.order === "ascend" ? "asc" : "desc");
        }}
        onRow={
          onRowOpen
            ? (record) => ({ onClick: () => onRowOpen(record), style: { cursor: "pointer" } })
            : undefined
        }
        summary={
          footer && rows.length
            ? () => (
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={shown.length} index={0}>
                    <span style={{ fontSize: 12 }}>{footer}</span>
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              )
            : undefined
        }
      />

      {total > pageSize ? (
        <Flex
          align="center"
          justify="space-between"
          gap={12}
          style={{
            borderTop: `1px solid ${INK.line}`,
            padding: "10px 12px",
          }}
        >
          <Typography.Text style={{ fontSize: 12, color: INK.muted }}>
            第 <span className="num">{page}</span> /{" "}
            <span className="num">{Math.ceil(total / pageSize)}</span> 页 · 每页{" "}
            <span className="num">{pageSize}</span> 条
          </Typography.Text>
          {/* showSizeChanger 关掉：每页条数由 URL 参数决定，页内改会让"分享出去的链接"对不上 */}
          <Pagination
            size="small"
            current={page}
            pageSize={pageSize}
            total={total}
            showSizeChanger={false}
            onChange={(p) => onPageChange(p)}
          />
        </Flex>
      ) : null}
    </Card>
  );
}

/**
 * 列上要不要画排序箭头。
 * 单独导出是为了让两张列表共用同一个判断——排序态只有一份（URL），
 * 列定义自己再算一遍就会出现"表头箭头与真实顺序不一致"。
 */
export function sortOrderOf(key: string, sortBy: string, sortDir: "asc" | "desc") {
  if (key !== sortBy) return undefined;
  return sortDir === "asc" ? ("ascend" as const) : ("descend" as const);
}

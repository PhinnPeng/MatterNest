"use client";

import { isValidElement, useMemo, useState } from "react";
import { Checkbox, Dropdown } from "antd";
import type { TableColumnsType } from "antd";

import { MAX_PAGE_SIZE } from "@/shared/schema/list-query";

/**
 * `DataTable` —— 全站唯一的数据表入口（禁令⑧），同时是"表格区卡片"这层壳。
 *
 * ## 2026-10-18（MATT-99）：表格换成 canon 的 `<table class="tb">`
 *
 * 原型 `.impeccable/mocks/pages/canon.css` 的表格是**朴素 table**：行高 40、
 * 表头 `--th` 底、`<colgroup>` 显式列宽、可伸缩列挂 `.ellip`、分页是 `.pager` 一行。
 * antd `Table` 自带的表头底、行高（由 `cellPaddingBlockSM` 推）、分页器都是**另一套尺寸**，
 * 与 canon 的密度刻度对不齐 —— 所以这里不再把 antd `Table` 当渲染器，改为直接铺
 * canon 的语义标签。**列的声明形状不变**（仍然是 antd 的 `TableColumnsType`），
 * 于是六个列表页的列定义一个字都不用改。
 *
 * 仍然由本组件承担、换渲染器不能丢的四条：
 *   1. **受控**：`page / pageSize / sortBy / sortDir` 由调用方给，本组件不自己维护态
 *      ——状态落在 URL 上（`use-list-state`），刷新、后退、发链接给同事才对得上同一视图；
 *   2. **只声明可排序，不在前端排**：列上给 `sorter: true` 就够，点击表头只把
 *      `key + dir` 交回调用方（`onSortChange`）。
 *      **绝不做客户端排序**——那是绕过 `scopedWhere`（禁令⑧ 的理由是权限不是性能）；
 *   3. `pageSize > MAX_PAGE_SIZE` **直接抛**，不静默夹小；
 *   4. **标题是页面主标题**：列表页不再单独渲染 PageHeader，`h2` 由这里的卡片头承担
 *      （canon 的结构是顶栏 `h1` 页名 → 页面内 `.pagehead h2` / 卡片头 `h2`）。
 *
 * ## 列宽预算 ≤1100 @1366
 *
 * `<colgroup>` 里逐列给 `<col style="width">`；没给 `width` 的列就是**可伸缩列**，
 * 它的单元格加 `.ellip`（`white-space:nowrap + overflow:hidden + text-overflow:ellipsis`），
 * 窄屏也不撑破布局。`align` 映射到 canon 的 `.r` / `.c`。
 */

type Align = "left" | "right" | "center";

/** 本组件真正读的那几个列字段（`TableColumnsType` 是它的超集）。 */
type ColumnLike<T> = {
  key?: string;
  title?: React.ReactNode;
  dataIndex?: string;
  width?: number;
  align?: Align;
  ellipsis?: boolean;
  render?: (value: unknown, record: T, index: number) => React.ReactNode;
  sorter?: boolean | unknown;
  sortOrder?: "ascend" | "descend" | null;
};

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
  /** 卡片头主标题（承担页面主区块的 h2） */
  title: React.ReactNode;
  /** 卡片头右侧工具：刷新 / 新建 等。列设置由本组件自己渲染在最前 */
  tools?: React.ReactNode;
  /** 可隐藏列的清单；不传就不显示「列设置」 */
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
  title,
  tools,
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
    () =>
      (columns as ColumnLike<T>[]).filter(
        (c) => !hidden.includes(String(c.key ?? c.dataIndex ?? "")),
      ),
    [columns, hidden],
  );

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const canPrev = page > 1;
  const canNext = page < pageCount;

  return (
    <div className="card">
      <div className="card-h">
        <h2>{title}</h2>
        <span className="sp" />
        {hideable?.length ? (
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
            <button type="button" className="btn sm">
              列设置
            </button>
          </Dropdown>
        ) : null}
        {tools}
      </div>

      <table className="tb" aria-busy={loading || undefined}>
        <colgroup>
          {shown.map((c, i) => (
            <col
              key={String(c.key ?? c.dataIndex ?? i)}
              style={c.width ? { width: c.width } : undefined}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            {shown.map((c, i) => {
              const key = String(c.key ?? c.dataIndex ?? i);
              const sortable = Boolean(c.sorter);
              const order = c.sortOrder;
              return (
                <th
                  key={key}
                  className={alignClass(c.align)}
                  aria-sort={
                    order === "ascend"
                      ? "ascending"
                      : order === "descend"
                        ? "descending"
                        : undefined
                  }
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => onSortChange(key, order === "ascend" ? "desc" : "asc")}
                      style={{
                        font: "inherit",
                        color: "inherit",
                        background: "none",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      {c.title as React.ReactNode}
                      {/* 排序指示：词 + 字形双通道（色不作唯一通道），无排序时留一个淡的 ⇅ */}
                      <span aria-hidden="true" className={order ? undefined : "mut3"}>
                        {order === "ascend" ? "▲" : order === "descend" ? "▼" : "⇅"}
                      </span>
                    </button>
                  ) : (
                    (c.title as React.ReactNode)
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              {/* 调用方给的 `empty` 自带 `.empty` 外壳（StateBlock 的空态）；没给就兜一句 */}
              <td colSpan={shown.length}>{empty ?? <div className="empty">暂无数据</div>}</td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={rowKey(r)}
                onClick={onRowOpen ? () => onRowOpen(r) : undefined}
                style={onRowOpen ? { cursor: "pointer" } : undefined}
              >
                {shown.map((c, i) => {
                  const key = String(c.key ?? c.dataIndex ?? i);
                  const value =
                    c.dataIndex != null ? (r as Record<string, unknown>)[c.dataIndex] : undefined;
                  const content = c.render
                    ? c.render(value, r, i)
                    : ((value ?? null) as React.ReactNode);
                  return (
                    <td
                      key={key}
                      className={cellClass(c)}
                      title={c.ellipsis ? cellTitle(content) : undefined}
                    >
                      {content}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
        {footer && rows.length ? (
          <tfoot>
            <tr>
              <td colSpan={shown.length} className="mut" style={{ fontSize: 12 }}>
                {footer}
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>

      <div className="pager">
        <span className="num">共 {total} 条</span>
        <span className="sp" />
        <button
          type="button"
          className="btn sm"
          disabled={!canPrev}
          onClick={() => onPageChange(page - 1)}
        >
          上一页
        </button>
        <span className="num">
          {page} / {pageCount}
        </span>
        <button
          type="button"
          className="btn sm"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}

/** `align` → canon 的对齐类（`.r` 右 / `.c` 居中） */
function alignClass(align?: Align): string | undefined {
  if (align === "right") return "r";
  if (align === "center") return "c";
  return undefined;
}

/**
 * 单元格的类：对齐 + `ellipsis` 映射到 `.ellip`（显式列宽之外的列补省略号）。
 * `.ellip` 只给声明了 `ellipsis` 的列，不给所有列——把每一格都 nowrap 会让
 * 需要换行的单元格（备注类）也失去换行，那是另一种越界。
 */
function cellClass<T>(c: ColumnLike<T>): string | undefined {
  const parts = [alignClass(c.align), c.ellipsis ? "ellip" : null].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * `ellipsis` 列的原生 `title`（悬停找回被裁的文字）。
 *
 * ## 为什么不能省掉这一行
 *
 * 换渲染器前 antd 的 `Table` 走 rc-table 的 `getTitleFromCellRenderChildren`：
 * 单元格内容是**纯字符串/数字**、或**单元素且它的 `children` 是字符串**时，
 * 由 `ellipsis` 自动补 `title`。MATT-99 换成手写 `<table>` 后那一层没了，
 * 这里逐字补回同一口径——否则「文本被裁、悬停无提示」会在 render 包了一层的列上重现。
 *
 * ⚠ **这一条与「`.ellip` 真的会裁」是两件事**：当前 `<table class="tb">` 是 auto layout，
 * `.ellip` 的 `overflow:hidden` 在 `<td>` 上量不出裁剪（实测：长文本把列撑宽、表格横向溢出，
 * `scrollWidth === clientWidth`）。真正被裁的是**内容自己限了宽**的那些格
 * （如案件名那列内层 `span` 的 `max-width:220`）。所以这里只按内容形状给 `title`，
 * 不假装所有单元格都被裁：多给一个 `title` 是无害的（值与可见文本一致），
 * 而少给一个就丢了找回路径——与 component-guidelines 规则 3 同一条判断。
 */
function cellTitle(content: React.ReactNode): string | undefined {
  if (typeof content === "string") return content;
  if (typeof content === "number") return String(content);
  if (isValidElement(content)) {
    const inner = (content.props as { children?: unknown }).children;
    if (typeof inner === "string" || typeof inner === "number") return String(inner);
  }
  return undefined;
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

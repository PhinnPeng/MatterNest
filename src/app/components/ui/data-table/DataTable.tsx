"use client";

import { useMemo, useState } from "react";
import { Button, Card, Checkbox, Dropdown, Flex, Pagination, Space, Table, Tooltip } from "antd";
import type { TableColumnsType, TableProps } from "antd";
import { ControlOutlined } from "@ant-design/icons";

import { INK } from "@/app/theme/brand";
import { MAX_PAGE_SIZE } from "@/shared/schema/list-query";

/**
 * `DataTable` —— 全站唯一的数据表入口（禁令⑧），同时是"表格区卡片"这层壳。
 *
 * ## 2026-10-19：渲染器回到 antd `Table`
 *
 * 2026-10-18 的 MATT-99 一度把它换成手写 `<table class="tb">`，理由是 canon 的朴素表格
 * 与 antd 的密度刻度对不齐。**该决定已被推翻**（用户 2026-10-19 明确要求
 * "相关组件使用 AntD 开发，不要自开发"）：组件体系只有一套（禁令⑦），
 * 手写表格等于在 antd 之外另养一层表格实现——表头排序、空态、合计行、列显隐
 * 每一样都要自己维护，而它们 antd 都有。
 *
 * **列的声明形状从头到尾没变**（一直是 antd 的 `TableColumnsType`），所以五个列表页的
 * 列定义一个字都不用改；这次换的只是把那份声明交给谁去画。
 *
 * 密度不靠手写 `style` 对齐，靠 `theme/antd.ts` 的 token：`size="small"` 是全局口径，
 * 单元格内边距由 `components.Table.cellPaddingBlockSM / cellPaddingInlineSM` 定。
 *
 * ## 换渲染器不能丢的六条
 *
 *   1. **受控**：`page / pageSize / sortBy / sortDir` 由调用方给，本组件不自己维护态
 *      ——状态落在 URL 上（`use-list-state`），刷新、后退、发链接给同事才对得上同一视图。
 *      所以分页器是 `Pagination`（受控 current），不是 `Table` 自带的那个。
 *   2. **只声明可排序，不在前端排**：列上给 `sorter: true` 就够，点击表头只把
 *      `key + dir` 交回调用方（`onSortChange`）。
 *      **绝不给函数形态的 `sorter`**——那是客户端全量排序，而禁令⑧ 的理由是权限不是性能
 *      （客户端全量筛 = 绕过 `scopedWhere`）。
 *   3. `pageSize > MAX_PAGE_SIZE` **直接抛**，不静默夹小：夹小会让调用方以为已经拉全了。
 *   4. **空态与合计行**：空态交给 `locale.emptyText` 渲染在表体里；**没有数据时不画合计行**，
 *      避免"合计 0 / 共 0 条"那种看起来像算错了的行。
 *      「共 N 条」**不写在卡头**：它现在只在常驻分页条里出现一次（原型 `.pager` 的落点）。
 *      卡头再写一遍就是同一个数字两处 —— 改了 `total` 两处都得改，漏一处就是"卡头说 5、
 *      分页条说 6"。
 *   5. **标题层级**：列表页不再单独渲染 `PageHeader`，本卡片的标题承担页面主区块的 `h2`
 *      （顶栏 `h1` 页名 → 页面内 `h2`）。这里用真 `h2` 而不是 `Typography.Title level={1}`：
 *      canon 与 DESIGN.md 的层级契约是标签层面的，读屏与视觉要看同一个东西。
 *   6. **列宽**：`tableLayout="fixed"` + `scroll.x` = 列宽合计。给了 `width` 才生效，
 *      没给 `width` 的列按剩余空间伸缩（列宽预算见 component-guidelines「表格密度契约」）。
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
  /** 行选择（受控）。给了就自动多出表头全选 + 行首勾选列，宽度计入 `scroll.x` */
  rowSelection?: NonNullable<TableProps<T>["rowSelection"]>;
  /** 表头与表体之间的一条选中工具条（canon `.tool`）：只在有选中项时由调用方渲染 */
  toolbar?: React.ReactNode;
  /** 卡片头主标题（承担页面主区块的 h2） */
  title: React.ReactNode;
  /**
   * 卡片头右端的**动作**：新建 / 导入 / 导出。
   * 顺序按调用方给的来（2026-10-21 用户定的序：新建 → 导入 → 导出），
   * 本组件不再在其前后插东西——「列设置」与 `refresh` 另成一组排在最右。
   */
  tools?: React.ReactNode;
  /** 页面自己的「刷新」件：与「列设置」并成一枚视图控件组，排在动作之右 */
  refresh?: React.ReactNode;
  /** 可隐藏列的清单；不传就不显示「列设置」 */
  hideable?: { key: string; title: string }[];
  empty?: React.ReactNode;
  /** 表尾合计行等说明文字 */
  footer?: React.ReactNode;
  /** 页面大小改变时的回调：由调用方持久化到 URL，本组件不自行维护分页状态 */
  onPageSizeChange?: (size: number) => void;
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
  rowSelection,
  toolbar,
  title,
  tools,
  refresh,
  hideable,
  empty,
  footer,
  onPageSizeChange,
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
  // 列宽合计：没给 width 的列按 120 估一个，只为让 `scroll.x` 有个合理的下界
  const sumWidth =
    shown.reduce((acc, c) => acc + (Number((c as { width?: number }).width) || 120), 0) +
    (rowSelection ? 44 : 0);

  /**
   * 「列设置」下拉。触发件的**形态**由调用点给（文字按钮 / 纯图标），因为 live 的三个变体
   * 分别把它收成图标、降成 quiet 文字、或并进一枚分组控件——菜单本身四处共用同一份。
   */
  const hasSettings = Boolean(hideable?.length) || Boolean(refresh);

  const columnMenu = (trigger: React.ReactNode) =>
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
        {trigger}
      </Dropdown>
    ) : null;

  return (
    <Card
      size="small"
      variant="outlined"
      styles={{ body: { padding: 0 } }}
      title={
        <Flex align="baseline" gap={8} style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, lineHeight: "22px" }}>{title}</h2>
        </Flex>
      }
      extra={
        tools || hasSettings ? (
          <Flex align="center" gap={10} style={{ minWidth: 0 }}>
            <Space size={8}>{tools}</Space>
            {hasSettings ? (
              <div className="hgroup">
                {columnMenu(
                  <Tooltip title="列设置">
                    <Button size="small" type="text" icon={<ControlOutlined />} />
                  </Tooltip>,
                )}
                {refresh}
              </div>
            ) : null}
          </Flex>
        ) : null
      }
    >
      {/*
        选中工具条（canon `.tool` 的实现侧形态）：卡片头与表格之间，只在有选中项时出现。
        样式在 `globals.css` 的 `.selbar`（含三条设计判断的来历），这里只负责摆放。
        调用方只在有选中项时给内容（见 `toolbar` 的注释），所以这里不判空。
      */}
      {toolbar ? <div className="selbar">{toolbar}</div> : null}
      <Table<T>
        size="small"
        rowKey={(r) => rowKey(r)}
        rowSelection={rowSelection}
        columns={shown}
        dataSource={rows}
        loading={loading}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: sumWidth }}
        locale={empty ? { emptyText: empty } : undefined}
        /**
         * 排序：只读回调，不接管顺序。`s.order` 变成 `null`（第三次点击取消）时不发请求——
         * 取消排序要回到"服务端默认序"，而那由列表的默认 `sortBy` 决定，不是本组件能选择的。
         */
        onChange={(_p, _f, sorter) => {
          const s = Array.isArray(sorter) ? sorter[0] : sorter;
          if (!s?.columnKey || s.order == null) return;
          onSortChange(String(s.columnKey), s.order === "ascend" ? "asc" : "desc");
        }}
        onRow={
          onRowOpen
            ? (record) => ({
                onClick: (e) => {
                  // 勾选框那一格不进详情：rowSelection 的 checkbox 在 antd 6 里会把 click
                  // 冒泡到 <tr>，直接绑 onRowOpen 就变成"勾选顺手打开了详情页"
                  if ((e.target as HTMLElement).closest(".ant-checkbox")) return;
                  onRowOpen(record);
                },
                style: { cursor: "pointer" },
              })
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

      {/*
        分页条（canon `.pager`）：**常驻**，不是"多页才画"。
        原型 `matters.html` 的五张列表页都画着 `.pager`，里面是「共 N 条 + 上一页/下一页」；
        "只有一页就整条消失"会让这一行的位置在翻页前后跳动，且"共 N 条"是这一屏唯一的
        总量读数 —— 它不该在翻页后凭空出现或消失。
      */}
      <Flex
        align="center"
        justify="space-between"
        gap={12}
        style={{ borderTop: `1px solid ${INK.line}`, padding: "10px 12px" }}
      >
        <span style={{ fontSize: 12, color: INK.muted }}>
          共 <span className="num">{total}</span> 条 · 第 <span className="num">{page}</span> /{" "}
          <span className="num">{Math.max(1, Math.ceil(total / pageSize))}</span> 页
        </span>
        {/* 页面大小选择：页面改由用户定，不是组件固定；调用方按需持久化到 URL */}
        <Pagination
          size="small"
          current={page}
          pageSize={pageSize}
          total={total}
          disabled={total === 0}
          showSizeChanger
          pageSizeOptions={[20, 50, 100]}
          onChange={(p) => onPageChange(p)}
          onShowSizeChange={(_current, size) => void onPageSizeChange?.(size)}
        />
      </Flex>
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

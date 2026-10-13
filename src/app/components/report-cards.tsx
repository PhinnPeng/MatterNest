"use client";

import { useMemo } from "react";
import { Button, Card, Flex, Table, Tooltip } from "antd";
import type { TableColumnsType } from "antd";

import { StateBlock } from "@/app/components/ui/state-block";
import { useMeta, type HostKind } from "@/app/lib/client/api";
import { useReports } from "@/app/lib/client/api-reports";
import type { MatterMatrix, NodeDeadlineCard, RiskMatrix } from "@/app/lib/client/api-reports";
import { toReportQuery, type ListState } from "@/app/lib/client/use-list-state";
import { DEADLINE_TONE } from "@/app/theme/antd";
import { INK } from "@/app/theme/brand";
import { LITIGATION_ROLE_LABELS } from "@/shared/enums/business";
import { HOST_TYPE_LABELS } from "@/shared/enums/targets";

/**
 * 报表两卡（MATT-46 / F8-1 + F8-2），挂在**两个列表页顶部**：P7 案件列表与 P4 事项列表。
 *
 * 形态由 P0-2 裁定：**不建报表页、不进菜单**（§4.7）。所以这里没有页头、没有自己的刷新按钮、
 * 没有自己的归档开关——页面上已有的那些控件就是它的控件，`filters` 就是当前那份筛选。
 *
 * ## 一个组件，两处调用
 *
 * 两张卡在两个列表页上**逐字相同**，差别只有 `host`（画哪张矩阵）与 `filters`（当前筛选）。
 * 各写一遍会得到两份会漂的实现：一处改了列宽或档位说明，另一处看不出来。
 *
 * ## 为什么这两张表不是 `DataTable`
 *
 * `DataTable` 的契约是**受控分页的服务端列表**（`page/pageSize/total/onSortChange`，
 * 页大小 > 100 直接抛）——它存在的理由是禁令⑧：不许"拉全量再本地筛"。
 * 而这两张卡是**固定维度的计数矩阵**：行是状态（× 等级）、列是配置里的几档，
 * 没有分页也没有排序可言，总数就在表尾合计行里。所以照 `(desk)/config/config-view.tsx`
 * 那张只读字典表的写法（`Card` + `pagination={false}` 的小表），
 * 密度契约仍照旧：每列给 `width` 与 `ellipsis`，`scroll.x` = 列宽合计。
 *
 * ## 口径的落点（副标题纪律）
 *
 * 卡片头上没有第二行说明。两条读者会问的规则各挂在自己的 tooltip 上：
 *   · 「这些数字是哪些行的」→ 卡片标题（`SCOPE_HINT`）；
 *   · 「为什么未指派时案件那一行是 0」→ 节点卡的「宿主」列头（`HOST_HINT`）；
 *   · 「临期」按每个节点自己的提醒档算 → 各档列头（`BUCKET_HINT`）。
 *
 * ## 数字全部来自服务端
 *
 * 这个文件不做任何求和、分组或二次取数：行、列、合计（含表尾）都由 `/api/reports` 摆好
 * （§4.7 第 5 条）。这里只把 code 换成配置里的显示名（`/api/meta` 是字典的唯一出口）。
 */
export function ReportCards({ host, filters }: { host: HostKind; filters: ListState }) {
  /**
   * queryKey 就是真正发出去的那个请求串（`toReportQuery`）：筛选一变、请求串一变、
   * key 跟着变——"筛选变了但卡片不重新取"在类型层写不出来。
   */
  const { data, isPending, isError, error, refetch } = useReports(toReportQuery(filters));
  // 状态与等级是**配置驱动**的字典，唯一出口是 `/api/meta`（工作台的状态分布也这么取）。
  // 服务层只给 code，所以运营在配置页改一次显示名，报表与列表一起变。
  const { data: dict } = useMeta(host);
  const statusNames = useMemo(() => nameMap(dict?.statuses), [dict]);
  const levelNames = useMemo(() => nameMap(dict?.levels), [dict]);

  if (isError) {
    // 读数失败**只塌掉这两张卡**：下面的列表照常可用（它有自己的错误态），
    // 所以这里不接管整页，也不把列表的错误混进来。
    return (
      <Card size="small" style={{ marginBottom: 12 }}>
        <StateBlock
          tone="error"
          title="统计卡读数没拿到"
          hint={error instanceof Error ? error.message : "未知错误"}
          action={
            <Button size="small" onClick={() => void refetch()}>
              重试
            </Button>
          }
        />
      </Card>
    );
  }

  const loading = isPending || !data;
  const name = (code: string) => statusNames.get(code) ?? code;
  const level = (code: string) => levelNames.get(code) ?? code;

  return (
    <Flex vertical gap={12} style={{ marginBottom: 12 }}>
      <Card size="small" title={cardTitle("总览")} loading={loading}>
        {data ? (
          host === "matter" ? (
            <MatterMatrixTable
              m={data.matters}
              name={name}
              level={level}
              emptyText={emptyText(filters, data.archivedOnly, "案件")}
            />
          ) : (
            <RiskMatrixTable
              m={data.risks}
              name={name}
              level={level}
              emptyText={emptyText(filters, data.archivedOnly, "事项")}
            />
          )
        ) : null}
      </Card>

      <Card size="small" title={cardTitle("节点到期")} loading={loading}>
        {data ? <NodeDeadlineTable card={data.nodes} /> : null}
      </Card>
    </Flex>
  );
}

/**
 * 卡片头上的规则。tooltip 是"规则类的话"的合法落点之一（另外三类：空态/错误态、
 * 控件说明、字段表）——把同一句话写成卡片下的第二行说明就是被禁的那种旁白。
 */
const SCOPE_HINT =
  "这些数字按当前筛选算：状态、经办人未指派、在办 / 已归档。关键词、排序与翻页不参与统计。";

/** 节点卡两行的范围。`owner_id` 案件侧 NOT NULL（IQ-6），所以「未指派」下案件那行是 0 */
const HOST_HINT = "两行都按当前筛选算。案件必有负责人，所以「经办人未指派」下案件那一行是 0。";

function cardTitle(text: string) {
  return (
    <Tooltip title={SCOPE_HINT}>
      {/* 虚线下划线是"这里有一条规则"的既有读法（与列头上的 tooltip 同一个信号） */}
      <span style={{ borderBottom: `1px dashed ${INK.line}`, cursor: "help" }}>{text}</span>
    </Tooltip>
  );
}

/**
 * 空态文案：有筛选时说清"是筛没了"，没筛选时才说"还没有"——两者要用户做的事不一样。
 *
 * 「在办还是归档」这一半用**服务端回显的 `data.archivedOnly`**，不用本地状态猜：
 * 回显存在的意义就是"这两张卡算的是哪个范围"由服务端说了算（`ReportsPayload` 的注释）。
 */
function emptyText(filters: ListState, archivedOnly: boolean, what: string): string {
  if (filters.status || filters.ownerEmpty || archivedOnly) {
    return `当前筛选下没有可见${what}`;
  }
  return `还没有在办${what}`;
}

/** 字典数组 → code→名 的查表；配置里已经没有的 code 由调用方回落成 code 本身 */
function nameMap(rows: { code: string; name: string }[] | undefined) {
  return new Map((rows ?? []).map((r) => [r.code, r.name]));
}

/** 诉讼地位的中文名来自枚举表 E12（与 `/api/meta` 下发的是同一份，不在这里抄第二份） */
function roleName(code: string): string {
  return (LITIGATION_ROLE_LABELS as Record<string, string>)[code] ?? code;
}

/* ─────────────────────── 卡①·案件：状态 × 等级 × 诉讼地位 ─────────────────────── */

function MatterMatrixTable({
  m,
  name,
  level,
  emptyText,
}: {
  m: MatterMatrix;
  name: (code: string) => string;
  level: (code: string) => string;
  emptyText: string;
}) {
  /**
   * 状态列合并单元格：同一状态跨等级只写一次，格子里带该状态的小计。
   * `rowSpan` 先按行键算好，不在 `onCell` 里数——那是渲染期副作用，
   * antd 重渲染几次就会数出不同的值（合并单元格最常见的错法）。
   */
  const rowSpans = useMemo(() => {
    const perStatus = new Map<string, number>();
    for (const r of m.rows) perStatus.set(r.status, (perStatus.get(r.status) ?? 0) + 1);
    const spans = new Map<string, number>();
    const done = new Set<string>();
    for (const r of m.rows) {
      const key = `${r.status}\u0000${r.level}`;
      if (done.has(r.status)) spans.set(key, 0);
      else {
        spans.set(key, perStatus.get(r.status) ?? 1);
        done.add(r.status);
      }
    }
    return spans;
  }, [m.rows]);

  const columns: TableColumnsType<MatterMatrix["rows"][number]> = [
    {
      title: "状态",
      key: "status",
      width: 120,
      ellipsis: true,
      onCell: (row) => ({ rowSpan: rowSpans.get(`${row.status}\u0000${row.level}`) ?? 1 }),
      render: (_, row) => (
        <Flex vertical gap={2}>
          {/* render 包了元素，antd 的 ellipsis 不会再补 title，所以自己写 */}
          <span title={name(row.status)}>{name(row.status)}</span>
          <span className="num" style={{ fontSize: 11, color: INK.muted }}>
            共 {row.statusTotal}
          </span>
        </Flex>
      ),
    },
    {
      title: "等级",
      key: "level",
      width: 84,
      ellipsis: true,
      render: (_, row) => <span title={level(row.level)}>{level(row.level)}</span>,
    },
    ...m.roles.map((role) => ({
      title: roleName(role.code),
      key: `role:${role.code}`,
      width: 84,
      align: "right" as const,
      ellipsis: true,
      render: (_: unknown, row: MatterMatrix["rows"][number]) => (
        <span className="num">{row.counts[role.code] ?? 0}</span>
      ),
    })),
    {
      title: "合计",
      key: "total",
      width: 84,
      align: "right" as const,
      ellipsis: true,
      render: (_, row) => (
        <span className="num" style={{ fontWeight: 600 }}>
          {row.total}
        </span>
      ),
    },
  ];

  const width = columns.reduce((acc, c) => acc + (Number(c.width) || 84), 0);

  return (
    <Table
      size="small"
      rowKey={(r) => `${r.status}\u0000${r.level}`}
      columns={columns}
      dataSource={m.rows}
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: width }}
      locale={{ emptyText }}
      summary={() => (
        <Table.Summary.Row>
          <Table.Summary.Cell index={0} colSpan={2}>
            合计
          </Table.Summary.Cell>
          {m.roles.map((role, i) => (
            <Table.Summary.Cell key={role.code} index={i + 2} align="right">
              <span className="num">{role.total}</span>
            </Table.Summary.Cell>
          ))}
          <Table.Summary.Cell index={m.roles.length + 2} align="right">
            <span className="num" style={{ fontWeight: 600 }}>
              {m.total}
            </span>
          </Table.Summary.Cell>
        </Table.Summary.Row>
      )}
    />
  );
}

/* ─────────────────────────── 卡①·事项：状态 × 等级 ─────────────────────────── */

function RiskMatrixTable({
  m,
  name,
  level,
  emptyText,
}: {
  m: RiskMatrix;
  name: (code: string) => string;
  level: (code: string) => string;
  emptyText: string;
}) {
  const columns: TableColumnsType<RiskMatrix["rows"][number]> = [
    {
      title: "状态",
      key: "status",
      width: 140,
      ellipsis: true,
      render: (_, row) => <span title={name(row.status)}>{name(row.status)}</span>,
    },
    ...m.levels.map((lv) => ({
      title: level(lv.code),
      key: `level:${lv.code}`,
      width: 84,
      align: "right" as const,
      ellipsis: true,
      render: (_: unknown, row: RiskMatrix["rows"][number]) => (
        <span className="num">{row.counts[lv.code] ?? 0}</span>
      ),
    })),
    {
      title: "合计",
      key: "total",
      width: 84,
      align: "right" as const,
      ellipsis: true,
      render: (_, row) => (
        <span className="num" style={{ fontWeight: 600 }}>
          {row.total}
        </span>
      ),
    },
  ];

  const width = columns.reduce((acc, c) => acc + (Number(c.width) || 84), 0);

  return (
    <Table
      size="small"
      rowKey={(r) => r.status}
      columns={columns}
      dataSource={m.rows}
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: width }}
      locale={{ emptyText }}
      summary={() => (
        <Table.Summary.Row>
          <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
          {m.levels.map((lv, i) => (
            <Table.Summary.Cell key={lv.code} index={i + 1} align="right">
              <span className="num">{lv.total}</span>
            </Table.Summary.Cell>
          ))}
          <Table.Summary.Cell index={m.levels.length + 1} align="right">
            <span className="num" style={{ fontWeight: 600 }}>
              {m.total}
            </span>
          </Table.Summary.Cell>
        </Table.Summary.Row>
      )}
    />
  );
}

/* ──────────────────────────── 卡②：节点到期 ──────────────────────────── */

/**
 * 档位说明。**键由服务端给**（`buckets[].key`），这里只负责把规则说清楚——
 * "临期"按每个节点自己的提醒档算，这件事从列名看不出来，只能落在 tooltip 上。
 */
const BUCKET_HINT: Record<string, string> = {
  overdue: "期限已过且节点未完成。未确认时间的节点不进任何一档。",
  soon: "已进入该节点自己的提醒档：remind_days 里最远的那一档（空则按 7 天）。",
  later: "还没进该节点自己的提醒档。",
};

/** 颜色只做强调，数字本身才是通道（灰阶打印与色觉障碍都要能读） */
const BUCKET_TONE: Record<string, string> = {
  overdue: DEADLINE_TONE.overdue.color,
  soon: DEADLINE_TONE.soon.color,
  later: DEADLINE_TONE.later.color,
};

function NodeDeadlineTable({ card }: { card: NodeDeadlineCard }) {
  const columns: TableColumnsType<NodeDeadlineCard["rows"][number]> = [
    {
      title: (
        <Tooltip title={HOST_HINT}>
          <span>宿主</span>
        </Tooltip>
      ),
      key: "kind",
      width: 140,
      ellipsis: true,
      render: (_, row) => <span title={hostName(row.kind)}>{hostName(row.kind)}</span>,
    },
    ...card.buckets.map((b) => ({
      title: (
        <Tooltip title={BUCKET_HINT[b.key]}>
          <span>{b.label}</span>
        </Tooltip>
      ),
      key: `bucket:${b.key}`,
      width: 96,
      align: "right" as const,
      ellipsis: true,
      render: (_: unknown, row: NodeDeadlineCard["rows"][number]) => {
        const n = row.counts[b.key] ?? 0;
        return (
          <span
            className="num"
            style={{ color: n ? BUCKET_TONE[b.key] : undefined, fontWeight: n ? 600 : 400 }}
          >
            {n}
          </span>
        );
      },
    })),
    {
      title: "合计",
      key: "total",
      width: 96,
      align: "right" as const,
      ellipsis: true,
      render: (_, row) => (
        <span className="num" style={{ fontWeight: 600 }}>
          {row.total}
        </span>
      ),
    },
  ];

  const width = columns.reduce((acc, c) => acc + (Number(c.width) || 96), 0);

  return (
    <Table
      size="small"
      rowKey={(r) => r.kind}
      columns={columns}
      dataSource={card.rows}
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: width }}
      locale={{ emptyText: "这个范围里没有到期节点" }}
      summary={() => (
        <Table.Summary.Row>
          <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
          {card.buckets.map((b, i) => (
            <Table.Summary.Cell key={b.key} index={i + 1} align="right">
              <span className="num">{card.bucketTotals[b.key] ?? 0}</span>
            </Table.Summary.Cell>
          ))}
          <Table.Summary.Cell index={card.buckets.length + 1} align="right">
            <span className="num" style={{ fontWeight: 600 }}>
              {card.total}
            </span>
          </Table.Summary.Cell>
        </Table.Summary.Row>
      )}
    />
  );
}

function hostName(kind: HostKind): string {
  return HOST_TYPE_LABELS[kind] ?? kind;
}

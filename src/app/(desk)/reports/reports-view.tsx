"use client";

import { useMemo } from "react";
import { Button, Card, Flex, Segmented, Table, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { ReloadOutlined } from "@ant-design/icons";

import { PageHeader, SectionTitle } from "@/app/components/page-header";
import { StateBlock } from "@/app/components/ui/state-block";
import { useMeta } from "@/app/lib/client/api";
import { useReports } from "@/app/lib/client/api-reports";
import type { MatterMatrix, NodeDeadlineCard, RiskMatrix } from "@/app/lib/client/api-reports";
import { useListState } from "@/app/lib/client/use-list-state";
import { DEADLINE_TONE } from "@/app/theme/antd";
import { INK } from "@/app/theme/brand";
import { LITIGATION_ROLE_LABELS } from "@/shared/enums/business";
import { HOST_TYPE_LABELS, type HostType } from "@/shared/enums/targets";

/**
 * 报表两卡（MATT-46 / F8-1 + F8-2）。口径写在 `docs/PRD-phase1-master.md` §4.7，
 * 聚合全在 `/api/reports`（这个文件不做任何求和、分组，也不按行二次取数）。
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
 * ## 口径的落点
 *
 * "临期"不是一眼能看出来的词（它按每个节点自己的提醒档算），所以它的定义挂在列头 tooltip 上
 * ——规则类的话落在动作发生处，不占版面写第二行说明。
 */
export function ReportsView() {
  const { state, push } = useListState();
  const archivedOnly = state.archivedOnly;
  const { data, isPending, isError, error, isFetching, refetch } = useReports(archivedOnly);

  // 状态与等级是**配置驱动**的字典，唯一出口是 `/api/meta`（工作台的状态分布也这么取）。
  // 服务层只给 code，所以运营在配置页改一次显示名，报表与列表一起变。
  const { data: matterMeta } = useMeta("matter");
  const { data: riskMeta } = useMeta("risk_matter");
  const statusNames = useMemo(() => nameMap(matterMeta?.statuses), [matterMeta]);
  const levelNames = useMemo(() => nameMap(matterMeta?.levels), [matterMeta]);
  const riskStatusNames = useMemo(() => nameMap(riskMeta?.statuses), [riskMeta]);

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="报表读数没拿到"
        hint={error instanceof Error ? error.message : "未知错误"}
        action={
          <Button size="small" onClick={() => void refetch()}>
            重试
          </Button>
        }
      />
    );
  }
  if (isPending || !data) {
    return <Card size="small" loading style={{ maxWidth: 1180, margin: "0 auto" }} />;
  }

  const empty = data.matters.total === 0 && data.risks.total === 0 && data.nodes.total === 0;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      <PageHeader
        title="报表"
        actions={
          <>
            {/* 二态开关，与两张列表同一个语义（`archivedOnlyField`）：在办与归档互为补集，不混着看 */}
            <Segmented
              value={archivedOnly ? "archived" : "live"}
              onChange={(v) => push({ archivedOnly: v === "archived" })}
              options={[
                { label: "在办", value: "live" },
                { label: "已归档", value: "archived" },
              ]}
            />
            <Button icon={<ReloadOutlined />} loading={isFetching} onClick={() => void refetch()}>
              刷新
            </Button>
          </>
        }
      />

      {empty ? (
        <Card size="small">
          <StateBlock
            title={archivedOnly ? "这个范围里还没有归档记录" : "这个范围里还没有在办记录"}
            hint="报表只统计你能看见的记录；在办与已归档互为补集，切上面那个开关看另一半。"
          />
        </Card>
      ) : (
        <Flex vertical gap={16}>
          <Card size="small" title="总览">
            <SectionTitle count={data.matters.total}>案件</SectionTitle>
            <MatterMatrixTable
              m={data.matters}
              loading={isFetching}
              name={(code) => statusNames.get(code) ?? code}
              level={(code) => levelNames.get(code) ?? code}
            />
            <div className="h-4" />
            <SectionTitle count={data.risks.total}>事项</SectionTitle>
            <RiskMatrixTable
              m={data.risks}
              loading={isFetching}
              name={(code) => riskStatusNames.get(code) ?? code}
              level={(code) => levelNames.get(code) ?? code}
            />
          </Card>

          <Card size="small" title="节点到期">
            <NodeDeadlineTable card={data.nodes} loading={isFetching} />
          </Card>
        </Flex>
      )}
    </div>
  );
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
  loading,
  name,
  level,
}: {
  m: MatterMatrix;
  loading: boolean;
  name: (code: string) => string;
  level: (code: string) => string;
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
      loading={loading}
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: width }}
      locale={{ emptyText: "这个范围里没有案件" }}
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
  loading,
  name,
  level,
}: {
  m: RiskMatrix;
  loading: boolean;
  name: (code: string) => string;
  level: (code: string) => string;
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
      loading={loading}
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: width }}
      locale={{ emptyText: "这个范围里没有事项" }}
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

function NodeDeadlineTable({ card, loading }: { card: NodeDeadlineCard; loading: boolean }) {
  const columns: TableColumnsType<NodeDeadlineCard["rows"][number]> = [
    {
      title: "宿主",
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
      loading={loading}
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

function hostName(kind: string): string {
  return HOST_TYPE_LABELS[kind as HostType] ?? kind;
}

"use client";

import { INK } from "@/app/theme/brand";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button, Space, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";

import { api, useMeta } from "@/app/lib/client/api";
import { toQuery, useListState } from "@/app/lib/client/use-list-state";
import { calDate, fromNow, money } from "@/app/lib/client/format";
import { ListToolbar } from "@/app/components/list-toolbar";
import { MetaItem, PageHeader } from "@/app/components/page-header";
import { DataTable, sortOrderOf } from "@/app/components/ui/data-table/DataTable";
import { FlagMark, StatusMark } from "@/app/components/ui/status-mark";
import { StateBlock } from "@/app/components/ui/state-block";
import { ConvertDialog } from "./convert-dialog";
import { RiskCreateDialog } from "./risk-create-dialog";

type RiskRow = {
  id: string;
  code: string;
  name: string;
  type: string;
  level: string;
  amount: string;
  status: string;
  conversionStatus: number;
  convertedCaseCount: number;
  isArchived: boolean;
  discoverDate: string;
  updatedAt: string;
  ownerName: string;
};
type ListResult = { items: RiskRow[]; page: number; pageSize: number; total: number };

/**
 * 事项列表。
 *
 * 与案件列表差两件事，都写在规格里：
 *   · 状态筛选**不收进枚举**而用配置字典（事项状态同样配置驱动，见 `/api/risk-matters` 那段注释）；
 *   · 行上没有"改状态"，旗舰动作是**转案件**（修订稿 §3.4）。
 *
 * 事项侧**没有单独详情页**，也**没有状态流转端点**——这是范围决定不是遗漏，
 * 已记在 CHANGELOG 的「未做」与 MATT-1 的「已知会误导人的两处」里。
 * 转案件成功后把新案件编号与链接一起显出来：这条链上最容易出的故障是"案件建好了但事项还显示未转"，
 * 两个编号同时摆出来，用户当场就能验它俩都在。
 */
export function RisksView() {
  const router = useRouter();
  const { state, push } = useListState();
  const { data: meta } = useMeta("risk_matter");
  const [converting, setConverting] = useState<RiskRow | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isFetching, isError, error } = useQuery({
    queryKey: ["risk-matters", state],
    queryFn: () => api.get<ListResult>(`/api/risk-matters?${toQuery(state)}`),
  });

  const statusOptions = useMemo(
    () => (meta?.statuses ?? []).map((s) => ({ value: s.code, label: s.name })),
    [meta],
  );

  const columns = useMemo<TableColumnsType<RiskRow>>(
    () => [
      {
        key: "code",
        title: "编号",
        width: 128,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("code", state.sortBy, state.sortDir),
        render: (_, r) => <span className="num">{r.code}</span>,
      },
      {
        key: "name",
        title: "事项名称",
        width: 220,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("name", state.sortBy, state.sortDir),
        render: (_, r) => (
          <Space size={6}>
            <span
              title={r.name}
              style={{ maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {r.name}
            </span>
            {r.isArchived ? <FlagMark>归档</FlagMark> : null}
          </Space>
        ),
      },
      {
        key: "type",
        title: "类型",
        width: 76,
        ellipsis: true,
        render: (_, r) => meta?.enums.riskTypes[r.type] ?? r.type,
      },
      {
        key: "risk_level",
        title: "等级",
        width: 76,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("risk_level", state.sortBy, state.sortDir),
        render: (_, r) => meta?.levels.find((l) => l.code === r.level)?.name ?? r.level,
      },
      {
        key: "status",
        title: "状态",
        width: 78,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("status", state.sortBy, state.sortDir),
        render: (_, r) => <StatusMark host="risk_matter" code={r.status} />,
      },
      {
        key: "conversion",
        title: "转案件",
        width: 88,
        ellipsis: true,
        render: (_, r) =>
          r.conversionStatus === 1 ? (
            <FlagMark tone="info" title={`已由该事项建了 ${r.convertedCaseCount} 个案卷`}>
              已转 · {r.convertedCaseCount}
            </FlagMark>
          ) : (
            <span style={{ fontSize: 12, color: INK.faint }}>未转</span>
          ),
      },
      {
        key: "amount",
        title: "预估影响",
        width: 108,
        ellipsis: true,
        align: "right",
        sorter: true,
        sortOrder: sortOrderOf("amount", state.sortBy, state.sortDir),
        render: (_, r) => <span className="num">{money(r.amount)}</span>,
      },
      {
        key: "discover",
        title: "发现日",
        width: 88,
        ellipsis: true,
        render: (_, r) => (
          <span className="num" style={{ fontSize: 12 }}>
            {calDate(r.discoverDate)}
          </span>
        ),
      },
      {
        key: "owner_name",
        title: "负责人",
        width: 96,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("owner_name", state.sortBy, state.sortDir),
        render: (_, r) => r.ownerName,
      },
      {
        key: "updated_at",
        title: "更新",
        width: 78,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("updated_at", state.sortBy, state.sortDir),
        render: (_, r) => (
          <span style={{ fontSize: 12, color: INK.muted }}>{fromNow(r.updatedAt)}</span>
        ),
      },
      {
        key: "actions",
        title: "操作",
        width: 72,
        fixed: "right",
        render: (_, r) => (
          <Button
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              setConverting(r);
            }}
          >
            转案件
          </Button>
        ),
      },
    ],
    [meta, state.sortBy, state.sortDir],
  );

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="事项列表读不到"
        hint={error instanceof Error ? error.message : "未知错误"}
        action={
          <Button size="small" onClick={() => push({})}>
            重试
          </Button>
        }
      />
    );
  }

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <PageHeader
        title="风险事项"
        meta={
          <MetaItem label="">
            报备后跟踪，够立案条件的转成案件 —— 两本台账靠外键连起来，中间不断链。
          </MetaItem>
        }
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            新建事项
          </Button>
        }
      />

      <ListToolbar
        keyword={state.keyword}
        onKeyword={(v) => push({ keyword: v })}
        status={state.status}
        onStatus={(v) => push({ status: v })}
        statusOptions={statusOptions}
        sortBy={state.sortBy}
        sortDir={state.sortDir}
        onSort={(k, d) => push({ sortBy: k, sortDir: d })}
        sortOptions={[
          { value: "code", label: "编号" },
          { value: "name", label: "名称" },
          { value: "status", label: "状态" },
          { value: "risk_level", label: "等级" },
          { value: "owner_name", label: "负责人" },
          { value: "amount", label: "预估影响" },
          { value: "updated_at", label: "最近更新" },
        ]}
        includeArchived={state.includeArchived}
        onIncludeArchived={(v) => push({ includeArchived: v })}
        busy={isFetching}
      />

      <DataTable<RiskRow>
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(r) => r.id}
        total={data?.total ?? 0}
        page={state.page}
        pageSize={state.pageSize}
        loading={isFetching}
        onPageChange={(p) => push({ page: p })}
        onSortChange={(k, d) => push({ sortBy: k, sortDir: d })}
        hideable={[
          { key: "type", title: "类型" },
          { key: "discover", title: "发现日" },
        ]}
        empty={
          <Typography.Text style={{ fontSize: 12 }}>
            {state.keyword || state.status
              ? "当前筛选下没有可见事项。清掉条件再看一次；范围不同看到的条数就不同。"
              : "还没有风险事项。点右上「新建事项」报备一条。"}
          </Typography.Text>
        }
      />

      <ConvertDialog
        source={converting}
        onClose={() => setConverting(null)}
        onOpenCase={(cid) => router.push(`/matters/${cid}`)}
      />
      <RiskCreateDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

"use client";

import { INK } from "@/app/theme/brand";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button, Input, Select, Space, Typography } from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";

import { api, useMeta } from "@/app/lib/client/api";
import { toQuery, useListState } from "@/app/lib/client/use-list-state";
import { calDate, fromNow, money } from "@/app/lib/client/format";
import { FilterField, QueryFilter } from "@/app/components/query-filter";
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
 * 风险事项列表（在办）。
 *
 * 与案件列表**同一套壳**（查询区卡 + 表格卡），差两件事，都写在规格里：
 *   · 状态筛选**不收进枚举**而用配置字典（事项状态同样配置驱动，见 `/api/risk-matters` 那段注释）；
 *   · 行上没有"改状态"，旗舰动作是**转案件**（修订稿 §3.4）。
 *
 * 归档不在这里：这是在办列表，只出 待受理/进行中/已结案，已归档由 `/archive` 承接。
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

  const [kw, setKw] = useState(state.keyword);
  const [st, setSt] = useState(state.status);
  useEffect(() => {
    setKw(state.keyword);
    setSt(state.status);
  }, [state.keyword, state.status]);

  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ["risk-matters", state],
    queryFn: () => api.get<ListResult>(`/api/risk-matters?${toQuery(state)}`),
  });

  /** 状态值域来自 `/api/meta`，剔掉归档（它属于归档视图）；按 semantics 判而非硬编码 code。 */
  const statusOptions = useMemo(
    () =>
      (meta?.statuses ?? [])
        .filter((s) => s.semantics !== "archived")
        .map((s) => ({ value: s.code, label: s.name })),
    [meta],
  );

  function submit() {
    push({ keyword: kw.trim(), status: st });
  }

  function reset() {
    setKw("");
    setSt("");
    push({ keyword: "", status: "" });
  }

  const columns = useMemo<TableColumnsType<RiskRow>>(
    () => [
      {
        key: "code",
        title: "编号",
        width: 128,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("code", state.sortBy, state.sortDir),
        render: (_, r) => (
          <span className="num" style={{ fontSize: 12, color: INK.secondary }}>
            {r.code}
          </span>
        ),
      },
      {
        key: "name",
        title: "事项名称",
        width: 204,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("name", state.sortBy, state.sortDir),
        render: (_, r) => (
          <span
            title={r.name}
            style={{
              display: "block",
              maxWidth: 200,
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontWeight: 500,
            }}
          >
            {r.name}
          </span>
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
            <span style={{ fontSize: 12, color: INK.muted }}>未转</span>
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
        // 112 而不是 88：`calDate` 输出的是"2026年9月22日"，88 会把日号截成"2026年9月2…"。
        // 日期被裁掉一位比名字被裁危险得多——它看起来仍像一个完整日期。
        width: 112,
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
        width: 72,
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
      <QueryFilter onSearch={submit} onReset={reset} busy={isFetching}>
        <FilterField label="关键词" htmlFor="risk-keyword" width={280}>
          <Input
            id="risk-keyword"
            allowClear
            value={kw}
            placeholder="编号 / 名称 / 措施"
            onChange={(e) => setKw(e.target.value)}
            onPressEnter={submit}
          />
        </FilterField>
        <FilterField label="状态" width={160}>
          <Select
            allowClear
            placeholder="全部"
            value={st || undefined}
            options={statusOptions}
            onChange={(v) => setSt(v ?? "")}
          />
        </FilterField>
      </QueryFilter>

      <DataTable<RiskRow>
        title="风险事项列表"
        tools={
          <Space size={8}>
            <Button icon={<ReloadOutlined />} onClick={() => void refetch()} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              新建事项
            </Button>
          </Space>
        }
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
              : "还没有在办风险事项。点右上「新建事项」报备一条。"}
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

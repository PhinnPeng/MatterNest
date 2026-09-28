"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";

import { api, useMeta } from "@/app/lib/client/api";
import { toQuery, useListState } from "@/app/lib/client/use-list-state";
import { calDate, fromNow, money } from "@/app/lib/client/format";
import { ListToolbar } from "@/app/components/list-toolbar";
import { PageHeader } from "@/app/components/page-header";
import { DataTable, type LegacyColumnDef } from "@/app/components/ui/data-table/DataTable";
import { StatusMark, FlagMark } from "@/app/components/ui/status-mark";
import { Button } from "@/app/components/ui/button";
import { StateBlock } from "@/app/components/ui/state-block";
import { ConvertDialog } from "./convert-dialog";
import { RiskCreateDialog } from "./risk-create-dialog";

type RiskRow = {
  id: string;
  code: string;
  name: string;
  type: string;
  level: string;
  source: string | null;
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
 * 与案件列表差两件事，都是规格里的：
 *   · 状态筛选**不用枚举**而用配置字典（事项状态同样配置驱动）；
 *   · 行上没有"改状态"，旗舰动作是**转案件**（修订稿 §3.4）。
 *
 * 转案件对话框做完会把新案件的编号直接显示出来，并给一个跳过去的链接 ——
 * 这条链上最容易出的故障是"案件建好了但事项还显示未转"，把两个编号同时摆出来，
 * 用户当场就能验它俩都在。
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

  const columns = useMemo<LegacyColumnDef<RiskRow, unknown>[]>(
    () => [
      {
        id: "code",
        header: "编号",
        size: 116,
        cell: ({ row }) => <span className="num">{row.original.code}</span>,
      },
      {
        id: "name",
        header: "事项名称",
        size: 224,
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate">{row.original.name}</span>
            {row.original.isArchived ? <FlagMark>归档</FlagMark> : null}
          </span>
        ),
      },
      {
        id: "type",
        header: "类型",
        size: 96,
        enableSorting: false,
        cell: ({ row }) => meta?.enums.riskTypes[row.original.type] ?? row.original.type,
      },
      {
        id: "risk_level",
        header: "等级",
        size: 66,
        cell: ({ row }) =>
          meta?.levels.find((l) => l.code === row.original.level)?.name ?? row.original.level,
      },
      {
        id: "status",
        header: "状态",
        size: 92,
        cell: ({ row }) => <StatusMark host="risk_matter" code={row.original.status} />,
      },
      {
        id: "conversion",
        header: "转案件",
        size: 104,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.conversionStatus === 1 ? (
            <FlagMark
              tone="info"
              title={`已由该事项建了 ${row.original.convertedCaseCount} 个案卷`}
            >
              已转 · {row.original.convertedCaseCount}
            </FlagMark>
          ) : (
            <span className="text-xs text-muted-foreground">未转</span>
          ),
      },
      {
        id: "amount",
        header: "预估影响",
        size: 98,
        cell: ({ row }) => (
          <span className="num block text-right">{money(row.original.amount)}</span>
        ),
      },
      {
        id: "discover",
        header: "发现日",
        size: 96,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="num text-xs">{calDate(row.original.discoverDate)}</span>
        ),
      },
      {
        id: "owner_name",
        header: "负责人",
        size: 100,
        cell: ({ row }) => row.original.ownerName,
      },
      {
        id: "updated_at",
        header: "更新",
        size: 78,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{fromNow(row.original.updatedAt)}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        size: 76,
        enableSorting: false,
        enableHiding: false,
        cell: ({ row }) => (
          <Button
            size="xs"
            variant="outline"
            aria-label={`把 ${row.original.code} 转为案件`}
            onClick={(e) => {
              e.stopPropagation();
              setConverting(row.original);
            }}
          >
            转案件
          </Button>
        ),
      },
    ],
    [meta],
  );

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="事项列表读不到"
        hint={error instanceof Error ? error.message : "未知错误"}
        action={
          <Button variant="outline" size="sm" onClick={() => push({})}>
            重试
          </Button>
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="风险事项"
        meta={
          <>
            <span>报备后跟踪，够立案条件的转成案件 —— 两本台账靠外键连起来，中间不断链。</span>
            <Link href="/matters" className="text-primary underline-offset-4 hover:underline">
              看案件侧
            </Link>
          </>
        }
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon />
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

      <div className="pt-3">
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          total={data?.total ?? 0}
          page={state.page}
          pageSize={state.pageSize}
          /* 事项列表服务端只按更新时间排（同构表但排序白名单不同），
             所以这里把 sortBy 固定成 updated_at：表头点了也不改请求，避免"点了没反应"。 */
          sortBy="updated_at"
          sortDir={state.sortDir}
          loading={isFetching}
          rowKey={(r) => r.id}
          onPageChange={(p) => push({ page: p })}
          onSortChange={(_, d) => push({ sortDir: d })}
          empty={
            state.keyword || state.status ? (
              <>当前筛选下没有可见事项。清掉条件再看一次；范围不同看到的条数就不同。</>
            ) : (
              "还没有风险事项。点右上「新建事项」报备一条。"
            )
          }
        />
      </div>

      <ConvertDialog
        source={converting}
        onClose={() => setConverting(null)}
        onCreated={(caseId) => router.push(`/matters/${caseId}`)}
      />
      <RiskCreateDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

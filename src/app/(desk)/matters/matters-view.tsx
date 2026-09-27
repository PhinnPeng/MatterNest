"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";

import { api, useMeta, type Meta } from "@/app/lib/client/api";
import { toQuery, useListState } from "@/app/lib/client/use-list-state";
import { fromNow, money } from "@/app/lib/client/format";
import { SORTABLE_COLUMNS } from "@/shared/schema/list-query";
import { ListToolbar } from "@/app/components/list-toolbar";
import { PageHeader } from "@/app/components/page-header";
import { DataTable, type LegacyColumnDef } from "@/app/components/ui/data-table/DataTable";
import { StatusMark, FlagMark } from "@/app/components/ui/status-mark";
import { DeadlineMark } from "@/app/components/ui/deadline-mark";
import { Button } from "@/app/components/ui/button";
import { StateBlock } from "@/app/components/ui/state-block";
import { MatterCreateDialog } from "./matter-create-dialog";

type MatterRow = {
  id: string;
  internalCode: string;
  caseNo: string;
  name: string;
  cause: string;
  procedure: string;
  level: string;
  status: string;
  isArchived: boolean;
  amount: string;
  ownerName: string;
  updatedAt: string;
  nextDeadline: string | null;
};
type ListResult = { items: MatterRow[]; page: number; pageSize: number; total: number };

const SORT_LABEL: Record<string, string> = {
  code: "内部编号",
  name: "案件名称",
  status: "状态",
  risk_level: "风险等级",
  owner_name: "承办人",
  amount: "标的额",
  created_at: "创建时间",
  updated_at: "最近更新",
};

export function MattersView() {
  const router = useRouter();
  const { state, push } = useListState();
  const { data: meta } = useMeta("matter");
  const [creating, setCreating] = useState(false);

  /**
   * key 里带全部查询参数：换页/换筛选时旧请求的结果不会被当成新数据的缓存命中，
   * 而 `placeholderData: undefined` 是故意的 —— 保留上一页会让"点了没变"和"正在加载"分不开。
   */
  const { data, isFetching, isError, error } = useQuery({
    queryKey: ["matters", state],
    queryFn: () => api.get<ListResult>(`/api/matters?${toQuery(state)}`),
  });

  const statusOptions = useMemo(
    () => (meta?.statuses ?? []).map((s) => ({ value: s.code, label: s.name })),
    [meta],
  );

  const columns = useMemo<LegacyColumnDef<MatterRow, unknown>[]>(() => matterColumns(meta), [meta]);

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="案件列表读不到"
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
        title="案件"
        meta={
          <>
            <span>立案到归档一条链；可见范围由服务端逐条判定，不是前端筛的。</span>
            {state.includeArchived ? <FlagMark tone="warn">已含归档</FlagMark> : null}
          </>
        }
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon />
            新建案件
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
        sortOptions={SORTABLE_COLUMNS.map((k) => ({ value: k, label: SORT_LABEL[k] ?? k }))}
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
          sortBy={state.sortBy}
          sortDir={state.sortDir}
          loading={isFetching}
          rowKey={(r) => r.id}
          onRowOpen={(r) => router.push(`/matters/${r.id}`)}
          onPageChange={(p) => push({ page: p })}
          onSortChange={(k, d) => push({ sortBy: k, sortDir: d })}
          empty={
            state.keyword || state.status ? (
              <>
                当前筛选下没有可见案件。清掉关键词或状态再看一次；如果同事能看见而你不能，
                那是数据范围（<span className="num">L1/L2/L3</span>）的差异。
              </>
            ) : (
              "还没有案件。点右上「新建案件」，内部编号会由数据库单语句取号。"
            )
          }
        />
      </div>

      <MatterCreateDialog open={creating} onOpenChange={setCreating} meta={meta} />
    </div>
  );
}

/** 列定义。id 一律用服务端白名单里的那 8 个键（表头点击即排序），非排序列显式 `enableSorting: false`。 */
function matterColumns(meta: Meta | undefined): LegacyColumnDef<MatterRow, unknown>[] {
  const levelName = (code: string) => meta?.levels.find((l) => l.code === code)?.name ?? code;
  const procName = (code: string) => meta?.enums.procedures[code] ?? code;

  return [
    {
      id: "code",
      header: "内部编号",
      size: 132,
      cell: ({ row }) => (
        <Link
          href={`/matters/${row.original.id}`}
          className="num text-primary underline-offset-4 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {row.original.internalCode}
        </Link>
      ),
    },
    {
      id: "name",
      header: "案件名称",
      size: 300,
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate">{row.original.name}</span>
          {row.original.isArchived ? (
            <FlagMark title="已归档：默认不出现在列表里">归档</FlagMark>
          ) : null}
        </span>
      ),
    },
    {
      id: "cause",
      header: "案由",
      size: 150,
      enableSorting: false,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.cause}</span>,
    },
    {
      id: "procedure",
      header: "程序",
      size: 96,
      enableSorting: false,
      cell: ({ row }) => procName(row.original.procedure),
    },
    {
      id: "risk_level",
      header: "等级",
      size: 80,
      cell: ({ row }) => levelName(row.original.level),
    },
    {
      id: "status",
      header: "状态",
      size: 104,
      cell: ({ row }) => <StatusMark host="matter" code={row.original.status} />,
    },
    {
      id: "amount",
      header: "标的额",
      size: 110,
      cell: ({ row }) => <span className="num block text-right">{money(row.original.amount)}</span>,
    },
    {
      id: "owner_name",
      header: "承办人",
      size: 120,
      cell: ({ row }) => row.original.ownerName,
    },
    {
      id: "next_deadline",
      header: "最近到期",
      size: 150,
      enableSorting: false,
      cell: ({ row }) => <DeadlineMark iso={row.original.nextDeadline} />,
    },
    {
      id: "updated_at",
      header: "更新",
      size: 90,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">{fromNow(row.original.updatedAt)}</span>
      ),
    },
  ];
}

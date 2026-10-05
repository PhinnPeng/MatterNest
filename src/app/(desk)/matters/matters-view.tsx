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
import { fromNow, money } from "@/app/lib/client/format";
import { ListToolbar } from "@/app/components/list-toolbar";
import { PageHeader } from "@/app/components/page-header";
import { DataTable, sortOrderOf } from "@/app/components/ui/data-table/DataTable";
import { StatusMark, FlagMark } from "@/app/components/ui/status-mark";
import { DeadlineMark } from "@/app/components/ui/deadline-mark";
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

/** 排序键 → 表头文案。键集合与 `SORTABLE_COLUMNS` 逐字相等，那条约束由服务层编译期守着。 */
const SORT_LABEL: Record<string, string> = {
  code: "内部编号",
  name: "案件名称",
  status: "状态",
  risk_level: "风险等级",
  owner_name: "负责人",
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
   * queryKey 里带全部查询参数：换页/换筛选时旧结果不会被当成新数据的缓存命中。
   * 不保留上一页的占位数据——那会让"点了没变"和"正在加载"分不开。
   */
  const { data, isFetching, isError, error } = useQuery({
    queryKey: ["matters", state],
    queryFn: () => api.get<ListResult>(`/api/matters?${toQuery(state)}`),
  });

  const statusOptions = useMemo(
    () => (meta?.statuses ?? []).map((s) => ({ value: s.code, label: s.name })),
    [meta],
  );

  const columns = useMemo<TableColumnsType<MatterRow>>(() => {
    const levelName = (code: string) => meta?.levels.find((l) => l.code === code)?.name ?? code;
    return [
      {
        key: "code",
        title: "内部编号",
        width: 130,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("code", state.sortBy, state.sortDir),
        render: (_, r) => (
          <span className="num" style={{ fontSize: 12, color: INK.secondary }}>
            {r.internalCode}
          </span>
        ),
      },
      {
        key: "name",
        title: "案件名称",
        width: 248,
        sorter: true,
        sortOrder: sortOrderOf("name", state.sortBy, state.sortDir),
        ellipsis: true,
        render: (_, r) => (
          <Space size={6}>
            <span
              style={{
                maxWidth: 190,
                overflow: "hidden",
                textOverflow: "ellipsis",
                fontWeight: 500,
              }}
              title={r.name}
            >
              {r.name}
            </span>
            {r.isArchived ? <FlagMark title="已归档：默认不出现在列表里">归档</FlagMark> : null}
          </Space>
        ),
      },
      {
        key: "cause",
        title: "案由",
        width: 120,
        ellipsis: true,
        // 1366 下这一列几乎每行都被裁（案由普遍 8–12 字），所以必须给 title：
        // antd 的 ellipsis 只在单元格内容是**纯字符串**时自动补 title，包一层 span 就没了。
        render: (_, r) => (
          <span title={r.cause} style={{ color: INK.secondary }}>
            {r.cause}
          </span>
        ),
      },
      {
        key: "procedure",
        title: "程序",
        width: 56,
        ellipsis: true,
        render: (_, r) => meta?.enums.procedures[r.procedure] ?? r.procedure,
      },
      {
        key: "risk_level",
        title: "等级",
        width: 76,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("risk_level", state.sortBy, state.sortDir),
        render: (_, r) => levelName(r.level),
      },
      {
        key: "status",
        title: "状态",
        width: 78,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("status", state.sortBy, state.sortDir),
        render: (_, r) => <StatusMark host="matter" code={r.status} />,
      },
      {
        key: "amount",
        title: "标的额",
        width: 112,
        ellipsis: true,
        align: "right",
        sorter: true,
        sortOrder: sortOrderOf("amount", state.sortBy, state.sortDir),
        render: (_, r) => <span className="num">{money(r.amount)}</span>,
      },
      {
        key: "owner_name",
        title: "负责人",
        width: 104,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("owner_name", state.sortBy, state.sortDir),
        render: (_, r) => r.ownerName,
      },
      {
        key: "next_deadline",
        title: "最近到期",
        width: 96,
        ellipsis: true,
        render: (_, r) => <DeadlineMark iso={r.nextDeadline} />,
      },
      {
        key: "updated_at",
        title: "更新",
        width: 80,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("updated_at", state.sortBy, state.sortDir),
        render: (_, r) => (
          <span style={{ fontSize: 12, color: INK.muted }}>{fromNow(r.updatedAt)}</span>
        ),
      },
    ];
  }, [meta, state.sortBy, state.sortDir]);

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="案件列表读不到"
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
        title="案件"
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
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
        sortOptions={Object.entries(SORT_LABEL).map(([value, label]) => ({ value, label }))}
        includeArchived={state.includeArchived}
        onIncludeArchived={(v) => push({ includeArchived: v })}
        busy={isFetching}
      />

      <DataTable<MatterRow>
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(r) => r.id}
        total={data?.total ?? 0}
        page={state.page}
        pageSize={state.pageSize}
        loading={isFetching}
        onRowOpen={(r) => router.push(`/matters/${r.id}`)}
        onPageChange={(p) => push({ page: p })}
        onSortChange={(k, d) => push({ sortBy: k, sortDir: d })}
        hideable={[
          { key: "cause", title: "案由" },
          { key: "procedure", title: "程序" },
        ]}
        empty={
          state.keyword || state.status ? (
            <Typography.Text style={{ fontSize: 12 }}>
              当前筛选下没有可见案件。清掉关键词或状态再看一次；如果同事能看见而你不能，
              那是数据范围（L1/L2/L3）的差异。
            </Typography.Text>
          ) : (
            <Typography.Text style={{ fontSize: 12 }}>
              还没有案件。点右上「新建案件」，内部编号会由数据库单语句取号。
            </Typography.Text>
          )
        }
      />

      <MatterCreateDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

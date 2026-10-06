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
import { fromNow, money } from "@/app/lib/client/format";
import { FilterField, QueryFilter } from "@/app/components/query-filter";
import { DataTable, sortOrderOf } from "@/app/components/ui/data-table/DataTable";
import { StatusMark } from "@/app/components/ui/status-mark";
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

/**
 * 案件列表（在办）。
 *
 * 结构是 ProTable 的两段式：**上面一张查询区卡、下面一张表格卡**。
 * 与上一版的差别，以及为什么：
 *   · 排序交给**表头**（原来工具栏里还有一个"排序列"下拉）——同一件事两个入口只会让人
 *     怀疑哪个才是真的；表头箭头是 Pro 的默认读法。
 *   · 归档不在这里。这是**在办列表**，只出 待受理/进行中/已结案；
 *     已归档由 `/archive` 承接（`archivedOnly` 二态开关，见 `shared/schema/list-query`）。
 *   · 页头不再单独渲染：`DataTable` 的卡片头就是本页的 h1。
 */
export function MattersView() {
  const router = useRouter();
  const { state, push } = useListState();
  const { data: meta } = useMeta("matter");
  const [creating, setCreating] = useState(false);

  /**
   * 查询区的草稿态：输入不立刻进 URL，「查询」/回车才提交。
   * 外部改了 URL（后退、点侧栏、清空筛选）要跟着回显，所以下面用 effect 同步。
   */
  const [kw, setKw] = useState(state.keyword);
  const [st, setSt] = useState(state.status);
  useEffect(() => {
    setKw(state.keyword);
    setSt(state.status);
  }, [state.keyword, state.status]);

  /**
   * queryKey 里带全部查询参数：换页/换筛选时旧结果不会被当成新数据的缓存命中。
   * 不保留上一页的占位数据——那会让"点了没变"和"正在加载"分不开。
   */
  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ["matters", state],
    queryFn: () => api.get<ListResult>(`/api/matters?${toQuery(state)}`),
  });

  /**
   * 状态值域来自 `/api/meta`，但**剔掉归档**：归档是另一个视图的事。
   * 按 `semantics` 判而不是按 `code === "archived"` 硬编码——语义是配置表的字段，
   * code 只是运营取的名字（枚举表 §0 的口径）。
   */
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
          <span
            style={{
              display: "block",
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontWeight: 500,
            }}
            title={r.name}
          >
            {r.name}
          </span>
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
      <QueryFilter onSearch={submit} onReset={reset} busy={isFetching}>
        <FilterField label="关键词" htmlFor="matter-keyword" width={280}>
          <Input
            id="matter-keyword"
            allowClear
            value={kw}
            placeholder="案号 / 名称 / 案由"
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

      <DataTable<MatterRow>
        title="案件列表"
        tools={
          <Space size={8}>
            <Button icon={<ReloadOutlined />} onClick={() => void refetch()} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              新建案件
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
        onRowOpen={(r) => router.push(`/matters/${r.id}`)}
        onPageChange={(p) => push({ page: p })}
        onSortChange={(k, d) => push({ sortBy: k, sortDir: d })}
        hideable={[
          { key: "cause", title: "案由" },
          { key: "procedure", title: "程序" },
        ]}
        empty={
          <Typography.Text style={{ fontSize: 12 }}>
            {state.keyword || state.status
              ? "当前筛选下没有可见案件。清掉关键词或状态再看一次；如果同事能看见而你不能，那是数据范围（L1/L2/L3）的差异。"
              : "还没有在办案件。点右上「新建案件」，内部编号会由数据库单语句取号。"}
          </Typography.Text>
        }
      />

      <MatterCreateDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

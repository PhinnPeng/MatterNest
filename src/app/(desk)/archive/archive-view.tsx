"use client";

import { INK } from "@/app/theme/brand";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button, Input, Segmented, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";

import { api, useMeta } from "@/app/lib/client/api";
import { toQuery, useListState } from "@/app/lib/client/use-list-state";
import { calDate, money } from "@/app/lib/client/format";
import { FilterField, QueryFilter } from "@/app/components/query-filter";
import { DataTable, sortOrderOf } from "@/app/components/ui/data-table/DataTable";
import { StateBlock } from "@/app/components/ui/state-block";

type Host = "matter" | "risk_matter";

/**
 * 归档行。两张宿主的字段名不同（案件是 `internalCode`、事项是 `code`），
 * 所以两张都声明成可选，渲染时取非空的那个——比搞两个 DataTable 实例、两套分页状态
 * 要简单，也不会出现"切了宿主还留着上个宿主的页码"。
 */
type ArchiveRow = {
  id: string;
  internalCode?: string | null;
  code?: string | null;
  name: string;
  cause?: string | null;
  type?: string | null;
  level: string;
  amount: string;
  ownerName: string;
  archivedAt: string | null;
};

type ListResult = { items: ArchiveRow[]; page: number; pageSize: number; total: number };

/**
 * 已归档（"归档走其他模块"这条要求的落点）。
 *
 * 它和两张在办列表是**同一套壳**（查询区卡 + 表格卡），差别只有三处，都是"归档"这件事本身：
 *   1. 查询条件里没有状态——这里的行全是归档态，给一个恒为单值的筛选项等于装饰；
 *   2. 请求恒带 `archivedOnly=1`（二态开关，见 `shared/schema/list-query`），
 *      与在办列表互为补集，不会出现"同一条既在办又归档"；
 *   3. 没有「新建」——归档是终态，只能从在办记录流转进来。
 *
 * **本页只读**：撤销归档走记录自己的「变更状态」（详情页），那里才拿得到 `can_unarchive`
 * 特权与"必须填原因"的判定。在这里放一个按钮等于把那条口径抄第二遍。
 */
export function ArchiveView() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const host: Host = sp.get("host") === "risk_matter" ? "risk_matter" : "matter";
  const { state, push } = useListState();
  const { data: meta } = useMeta(host);

  const [kw, setKw] = useState(state.keyword);
  useEffect(() => setKw(state.keyword), [state.keyword]);

  /**
   * 恒为归档视图：`archivedOnly` 与 `status` 都在这里定死，
   * 不走 URL（否则一条被分享出去的链接可能把归档页变成在办页）。
   */
  const query = useMemo(() => toQuery({ ...state, status: "", archivedOnly: true }), [state]);

  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ["archive", host, state],
    queryFn: () =>
      api.get<ListResult>(`/api/${host === "matter" ? "matters" : "risk-matters"}?${query}`),
  });

  function setHost(next: Host) {
    const params = new URLSearchParams(sp.toString());
    if (next === "matter") params.delete("host");
    else params.set("host", next);
    // 换宿主回第一页；关键词也不沿用——案件搜的是案号/案由，事项搜的是编号/措施
    params.delete("page");
    params.delete("keyword");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }

  const isMatter = host === "matter";

  const columns = useMemo<TableColumnsType<ArchiveRow>>(() => {
    const levelName = (code: string) => meta?.levels.find((l) => l.code === code)?.name ?? code;
    return [
      {
        key: "code",
        title: "编号",
        width: 132,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("code", state.sortBy, state.sortDir),
        render: (_, r) => (
          <span className="num" style={{ fontSize: 12, color: INK.secondary }}>
            {r.internalCode ?? r.code ?? "—"}
          </span>
        ),
      },
      {
        key: "name",
        title: isMatter ? "案件名称" : "事项名称",
        width: 248,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("name", state.sortBy, state.sortDir),
        render: (_, r) => (
          <span
            title={r.name}
            style={{
              display: "block",
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontWeight: 500,
            }}
          >
            {r.name}
          </span>
        ),
      },
      isMatter
        ? {
            key: "cause",
            title: "案由",
            width: 124,
            ellipsis: true,
            render: (_: unknown, r: ArchiveRow) => (
              <span title={r.cause ?? ""} style={{ color: INK.secondary }}>
                {r.cause}
              </span>
            ),
          }
        : {
            key: "type",
            title: "类型",
            width: 96,
            ellipsis: true,
            render: (_: unknown, r: ArchiveRow) => meta?.enums.riskTypes[r.type ?? ""] ?? r.type,
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
        key: "amount",
        title: isMatter ? "标的额" : "预估影响",
        width: 116,
        align: "right",
        ellipsis: true,
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
        key: "archived_at",
        title: "归档时间",
        width: 120,
        ellipsis: true,
        render: (_, r) => (
          <span className="num" style={{ fontSize: 12, color: INK.muted }}>
            {calDate(r.archivedAt)}
          </span>
        ),
      },
    ];
  }, [isMatter, meta, state.sortBy, state.sortDir]);

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="归档列表读不到"
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
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <Segmented
          value={host}
          onChange={(v) => setHost(v as Host)}
          options={[
            { label: "案件", value: "matter" },
            { label: "风险事项", value: "risk_matter" },
          ]}
        />
        <Typography.Text style={{ fontSize: 12, color: INK.muted }}>
          归档是终态：默认不出现在办列表；撤销归档在记录的「变更状态」里做，需专门权限。
        </Typography.Text>
      </div>

      <QueryFilter
        onSearch={() => push({ keyword: kw.trim() })}
        onReset={() => {
          setKw("");
          push({ keyword: "" });
        }}
        busy={isFetching}
      >
        <FilterField label="关键词" htmlFor="archive-keyword" width={300}>
          <Input
            id="archive-keyword"
            allowClear
            value={kw}
            placeholder={isMatter ? "案号 / 名称 / 案由" : "编号 / 名称 / 措施"}
            onChange={(e) => setKw(e.target.value)}
            onPressEnter={() => push({ keyword: kw.trim() })}
          />
        </FilterField>
      </QueryFilter>

      <DataTable<ArchiveRow>
        title={isMatter ? "已归档案件" : "已归档风险事项"}
        tools={<Button icon={<ReloadOutlined />} onClick={() => void refetch()} />}
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(r) => r.id}
        total={data?.total ?? 0}
        page={state.page}
        pageSize={state.pageSize}
        loading={isFetching}
        // 只有案件有详情页；事项侧没有（范围决定，见 risks-view 的说明），所以不挂行点击
        onRowOpen={isMatter ? (r) => router.push(`/matters/${r.id}`) : undefined}
        onPageChange={(p) => push({ page: p })}
        onSortChange={(k, d) => push({ sortBy: k, sortDir: d })}
        hideable={isMatter ? [{ key: "cause", title: "案由" }] : [{ key: "type", title: "类型" }]}
        empty={
          <Typography.Text style={{ fontSize: 12 }}>
            {state.keyword
              ? "当前关键词下没有已归档记录。换个词或清掉关键词再看一次。"
              : isMatter
                ? "还没有已归档案件。在办案件走完流程、置为归档后才会出现在这里。"
                : "还没有已归档风险事项。"}
          </Typography.Text>
        }
      />
    </div>
  );
}

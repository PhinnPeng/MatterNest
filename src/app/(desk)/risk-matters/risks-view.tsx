"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { App as AntdApp, Button, Form, Input, Modal, Select, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";

import { api, ApiFailure, useMeta, type Meta } from "@/app/lib/client/api";
import { toQuery, useListState, type ListState } from "@/app/lib/client/use-list-state";
import { BATCH_SKIP_REASON_LABELS, MAX_BATCH_IDS, type BatchSummary } from "@/shared/schema/batch";
import { needsChangeReason } from "@/shared/schema/status-transition";
import { FilterField, QueryFilter } from "@/app/components/query-filter";
import { ExportListButton } from "@/app/components/export-file-button";
import { ReportCards } from "@/app/components/report-cards";
import { DataTable, sortOrderOf } from "@/app/components/ui/data-table/DataTable";
import { FlagMark, StatusMark } from "@/app/components/ui/status-mark";
import { DeadlineMark } from "@/app/components/ui/deadline-mark";
import { StateBlock } from "@/app/components/ui/state-block";
import { ConvertDialog } from "./convert-dialog";
import { RiskCreateDialog } from "./risk-create-dialog";
import { ImportDialog } from "@/app/components/import-dialog";

type RiskRow = {
  id: string;
  code: string;
  name: string;
  type: string;
  level: string;
  status: string;
  conversionStatus: number;
  convertedCaseCount: number;
  /** 已转案件时第一个案卷的 id（`操作`列「查看案件」跳过去）；未转为 null */
  convertedMatterId: string | null;
  isArchived: boolean;
  discoverDate: string;
  /** 上报时间：登记进系统的时刻（`created_at`） */
  createdAt: string;
  updatedAt: string;
  ownerName: string;
  /** 最近一个未决节点的期限（服务端 `nextDeadline` 投影）。事项侧无预设节点，常见为空 */
  nextDeadline: string | null;
};
type ListResult = { items: RiskRow[]; page: number; pageSize: number; total: number };

/**
 * 经办人下拉里「未指派」那一项的值。
 *
 * 不占 `owner` 的取值空间（那是指纹数字 id），也不与空串（= 全部）混淆：
 * 三态是"全部 / 某个人 / 未指派"，后端用 `owner` 与 `ownerEmpty` 两个键分别承接。
 */
const UNASSIGNED = "__unassigned__";

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
  const { message } = AntdApp.useApp();
  const { state, push } = useListState();
  const { data: meta } = useMeta("risk_matter");
  const [converting, setConverting] = useState<RiskRow | null>(null);
  const [creating, setCreating] = useState(false);
  /** 批量导入弹层（MATT-102）：类型锁定为 `risk_matter`，见页头那个按钮的注释 */
  const [importing, setImporting] = useState(false);
  /**
   * 批量动作的选中集合（MATT-45）——**受控，且只装当前页的 id**。
   *
   * 与案件列表逐条同构：勾选列由 `DataTable` 的 `rowSelection` 画（44px，含表头全选），
   * 选中之后才出现的那条工具条（改状态 / 归档 / 加标签）由 `toolbar` 承接；
   * 翻页/换筛选后旧 id 一律丢掉。
   *
   * ⚠ 事项侧的批量动作**不含"转案件"**：转案件是 N 张卡片的表单（每张卡的案由/审级/
   * 诉讼地位/法院/金额逐案不同），批量做会让"哪张卡对应哪个事项"无从表达。
   * 所以旗舰动作仍然只在行内那个「转案件」按钮上，一次一个事项。
   */
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState<BatchMode | null>(null);
  /** 上一次批量动作的结果摘要。**留在页面上**而不是只弹一个 toast：跳过原因要能对着列表读 */
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);

  const [kw, setKw] = useState(state.keyword);
  const [st, setSt] = useState(state.status);
  /** 经办人：某个人的 id，或 `UNASSIGNED`（未指派）。空串 = 全部（含未指派） */
  const [owner, setOwner] = useState(state.ownerEmpty ? UNASSIGNED : (state.owner ?? ""));
  /** 风险等级 / 上报时间：与关键词、状态一样是**草稿**，点「查询」才进 URL（提交式筛选） */
  const [lv, setLv] = useState(state.riskLevel ?? "");
  const [report, setReport] = useState(state.reportBucket ?? "");
  useEffect(() => {
    setKw(state.keyword);
    setSt(state.status);
    setOwner(state.ownerEmpty ? UNASSIGNED : (state.owner ?? ""));
    setLv(state.riskLevel ?? "");
    setReport(state.reportBucket ?? "");
  }, [
    state.keyword,
    state.status,
    state.owner,
    state.ownerEmpty,
    state.riskLevel,
    state.reportBucket,
  ]);

  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ["risk-matters", state],
    queryFn: () => api.get<ListResult>(`/api/risk-matters?${toQuery(state)}`),
  });

  /**
   * 经办人下拉的候选：**当前筛选下真实出现过的人**（端点口径同案件侧），
   * 不是花名册。`owner` 自己清掉，否则选了一个人下拉就只剩他。
   */
  const owners = useQuery({
    queryKey: ["risk-matter-owners", state.status, state.riskLevel, state.reportBucket],
    queryFn: () =>
      api.get<{ owners: { id: string; displayName: string }[] }>(
        `/api/risk-matters/owners?${toQuery({ ...state, owner: "", ownerEmpty: undefined })}`,
      ),
  });

  /** 当前页的行与 id：批量选中集合的取值域（`data` 不变时身份稳定，effect 才不会被空跑） */
  const pageRows = useMemo(() => data?.items ?? [], [data]);
  const pageIds = useMemo(() => pageRows.map((r) => r.id), [pageRows]);
  useEffect(() => {
    // 没变就返回**同一个数组**：每次 refetch 都会换掉 `pageIds` 的身份，
    // 无条件 `setSelected` 会让"刷新一下"多一次全表重渲染（选中集合其实没变）
    setSelected((prev) => {
      const next = prev.filter((id) => pageIds.includes(id));
      return next.length === prev.length ? prev : next;
    });
  }, [pageIds]);
  const selectedRows = useMemo(
    () => pageRows.filter((r) => selected.includes(r.id)),
    [pageRows, selected],
  );

  /** 状态值域来自 `/api/meta`，剔掉归档（它属于归档视图）；按 semantics 判而非硬编码 code。 */
  const statusOptions = useMemo(
    () =>
      (meta?.statuses ?? [])
        .filter((s) => s.semantics !== "archived")
        .map((s) => ({ value: s.code, label: s.name })),
    [meta],
  );

  function submit() {
    push({
      keyword: kw.trim(),
      status: st,
      // 二选一：选了具体的人就不能同时是「未指派」
      owner: owner === UNASSIGNED || !owner ? "" : owner,
      ownerEmpty: owner === UNASSIGNED ? "1" : undefined,
      riskLevel: lv,
      reportBucket: report || undefined,
    });
  }

  function reset() {
    setKw("");
    setSt("");
    setLv("");
    setReport("");
    setOwner("");
    push({
      keyword: "",
      status: "",
      owner: "",
      ownerEmpty: undefined,
      riskLevel: "",
      reportBucket: undefined,
    });
  }

  /**
   * 列集照 canon 原型 `risk-matters.html`（2026-10-22 用户裁定"按原型对齐"），
   * 读法与案件列表同一套：勾选列 44 → 事项编号 → 事项名称（伸缩）→ 风险等级 →
   * 事项状态 → 经办人 → 上报时间 → 期限 → 转案件 → 操作。
   *
   * 相比旧列集移走三样，都不是丢数据：
   *   · **类型** → 详情页「基本信息」（与案件侧去掉「类型」同一个理由：同一批事项
   *     几乎全是同一个词，占着 76px 却几乎不携带信息）；
   *   · **更新** → 那是"这一条最近动过没"，不是台账要读的日期；这一列的位置让给「期限」，
   *     因为期限是会被引用、会过期的东西（规则 3：临期与逾期必须一眼扫得到）；
   *   · **发现日** → 原型这一列是「上报时间」，即 `created_at`（报上来的时刻），
   *     不是 `discover_date`（什么时候发现的）。两者在建号时就可以不同，所以不混用。
   *
   * ⚠ 「经办人」90 而不是原型的 76：这一列可排序，箭头要占约 18px，
   * 76 会把表头本身裁成「经…」（案件侧同一个坑，见 `matters-view.tsx`）。
   * 宽度合计 ≈ 44+150+96+96+90+100+118+88+96 ≈ 878 + 名称列的弹性。
   */
  const columns = useMemo<TableColumnsType<RiskRow>>(
    () => [
      {
        key: "code",
        title: "事项编号",
        width: 150,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("code", state.sortBy, state.sortDir),
        render: (_, r) => <span className="num">{r.code}</span>,
      },
      {
        key: "name",
        title: "事项名称",
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("name", state.sortBy, state.sortDir),
        /**
         * 全名走 `Tooltip` 而不是原生 `title`：名称列吃剩余宽度，长名字会被省略号截断，
         * 而"被截断的那半截"往往正是分不出是哪条事项的地方（与案件列表同一个做法）。
         */
        render: (_, r) => (
          <Tooltip title={r.name} mouseEnterDelay={0.2}>
            <a href={`/risk-matters/${r.id}`} onClick={(e) => e.stopPropagation()}>
              {r.name}
            </a>
          </Tooltip>
        ),
      },
      {
        key: "risk_level",
        title: "风险等级",
        width: 96,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("risk_level", state.sortBy, state.sortDir),
        /**
         * 描边 `.tag` 而不是纯文字（原型：高风险红 / 中风险黄 / 低风险中性）。
         * 词还得留着——颜色不能是唯一通道；配色只表达"这一条有多急"。
         */
        render: (_, r) => {
          const name = meta?.levels.find((l) => l.code === r.level)?.name ?? r.level;
          const tone = r.level === "high" ? "danger" : r.level === "mid" ? "warn" : "neutral";
          // 原型写「高风险」——配置表里的名字是「高」；已经带"风险"两字的不再重复拼
          return <FlagMark tone={tone}>{name.endsWith("风险") ? name : `${name}风险`}</FlagMark>;
        },
      },
      {
        key: "status",
        title: "事项状态",
        width: 96,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("status", state.sortBy, state.sortDir),
        render: (_, r) => <StatusMark host="risk_matter" code={r.status} />,
      },
      {
        key: "owner_name",
        title: "经办人",
        width: 90,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("owner_name", state.sortBy, state.sortDir),
        // 空值必须**说出来**：事项侧经办人可空（IQ-5），留白会被读成"数据缺失"，
        // 而它是一个有业务含义的状态——待人接手。
        render: (_, r) =>
          r.ownerName ? (
            r.ownerName
          ) : (
            <span className="mut3" style={{ fontSize: 12 }}>
              未指派
            </span>
          ),
      },
      {
        key: "report",
        title: "上报时间",
        // 100 与案件侧「立案日期」同档：两边都是 ISO 日期（2026-10-12），
        // 同一屏里两个日期列长得一样，扫读时才不用换一种解析方式。
        width: 100,
        ellipsis: true,
        // `created_at` 是时间戳，列里只要日子（原型的写法）
        render: (_, r) => <span className="num">{r.createdAt.slice(0, 10)}</span>,
      },
      {
        key: "next_deadline",
        title: "期限",
        width: 118,
        ellipsis: true,
        /**
         * 逾期红 / 7 日内黄 / 其余灰，文案带"还剩几天"（`DeadlineMark`）。
         * 事项侧没有预设节点（IQ-5），所以这里大部分行会是「未定」——那是一个真实的读数，
         * 不是缺数据，所以不藏这一列。
         */
        render: (_, r) => <DeadlineMark iso={r.nextDeadline} />,
      },
      {
        key: "conversion",
        title: "转案件",
        width: 88,
        ellipsis: true,
        /**
         * 未转的行给**动作**，已转的行给**事实**（原型同一格两种形态）。
         * 已转的行不再给按钮：转案件不可撤销，摆一个点了必被 409 挡下的按钮是骗人。
         */
        render: (_, r) =>
          r.conversionStatus === 1 ? (
            <FlagMark tone="info" title={`已由该事项建了 ${r.convertedCaseCount} 个案卷`}>
              已转案件
            </FlagMark>
          ) : (
            <Button
              type="link"
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
      {
        key: "actions",
        title: "操作",
        width: 96,
        ellipsis: true,
        render: (_, r) => (
          <Button
            type="link"
            size="small"
            href={r.convertedMatterId ? `/matters/${r.convertedMatterId}` : `/risk-matters/${r.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            {r.convertedMatterId ? "查看案件" : "查看"}
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
          <button type="button" className="btn sm" onClick={() => push({})}>
            重试
          </button>
        }
      />
    );
  }

  return (
    <div className="stack list">
      {/* 报表两卡（MATT-46）。工作台的「事项报表」用 `#reports` 锚到这里 */}
      <div id="reports">
        <ReportCards host="risk_matter" filters={state} />
      </div>

      <QueryFilter onSearch={submit} onReset={reset} busy={isFetching}>
        <FilterField label="关键词" htmlFor="risk-keyword" width={200}>
          <Input
            id="risk-keyword"
            allowClear
            value={kw}
            placeholder="编号 / 事项名称 / 描述"
            onChange={(e) => setKw(e.target.value)}
            onPressEnter={submit}
          />
        </FilterField>
        <FilterField label="事项状态" htmlFor="risk-status" width={120}>
          <Select
            id="risk-status"
            allowClear
            placeholder="全部状态"
            value={st || undefined}
            options={statusOptions}
            onChange={(v) => setSt(v ?? "")}
          />
        </FilterField>
        <FilterField label="风险等级" htmlFor="risk-level" width={120}>
          <Select
            id="risk-level"
            allowClear
            placeholder="全部等级"
            value={lv || undefined}
            options={(meta?.levels ?? []).map((l) => ({ value: l.code, label: l.name }))}
            onChange={(v) => setLv(v ?? "")}
          />
        </FilterField>
        <FilterField label="经办人" htmlFor="risk-owner" width={150}>
          <Select
            id="risk-owner"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="全部（含未指派）"
            value={owner || undefined}
            options={[
              { value: UNASSIGNED, label: "未指派" },
              ...(owners.data?.owners ?? []).map((o) => ({ value: o.id, label: o.displayName })),
            ]}
            onChange={(v) => setOwner(v ?? "")}
          />
        </FilterField>
        <FilterField label="上报时间" htmlFor="risk-report" width={120}>
          <Select
            id="risk-report"
            allowClear
            placeholder="全部时间"
            value={report || undefined}
            options={[
              { value: "week", label: "近 7 天" },
              { value: "month", label: "近 30 天" },
              { value: "quarter", label: "近 90 天" },
            ]}
            onChange={(v) => setReport(v ?? "")}
          />
        </FilterField>
      </QueryFilter>

      {batchResult ? (
        <div role="status" className="card" style={{ padding: "12px 16px", fontSize: 13 }}>
          <div className="rowflex">
            <span>
              批量动作完成：成功 <span className="num">{batchResult.summary.applied}</span> 条
              {batchResult.summary.skipped.length ? (
                <>
                  {" "}
                  · 跳过 <span className="num">{batchResult.summary.skipped.length}</span> 条
                </>
              ) : null}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn link" onClick={() => setBatchResult(null)}>
              关闭
            </button>
          </div>
          {batchResult.summary.skipped.length ? (
            <ul className="tl" style={{ marginTop: 8 }}>
              {batchResult.summary.skipped.map((s) => (
                <li key={s.id} style={{ paddingBottom: 4 }}>
                  <span className="num">{batchResult.labels[s.id] ?? s.id}</span> —{" "}
                  {BATCH_SKIP_REASON_LABELS[s.reason]}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <DataTable<RiskRow>
        title="事项列表"
        rowSelection={{
          type: "checkbox",
          /** canon `risk-matters.html` 的勾选列 44px，与案件列表同一口径 */
          columnWidth: 44,
          selectedRowKeys: selected,
          /**
           * 一次批量最多 `MAX_BATCH_IDS`（50）条，而 `pageSize` 可以到 `MAX_PAGE_SIZE`（100）：
           * 表头全选会选出一个**注定 400** 的集合。所以在入口处截断并说明，而不是等提交后
           * 才让用户知道——静默只选前 50 条更糟，用户会以为全选就是全选（案件侧同款处理）。
           */
          onChange: (keys) => {
            const next = keys.map(String);
            if (next.length > MAX_BATCH_IDS) {
              setSelected(next.slice(0, MAX_BATCH_IDS));
              void message.warning(
                `一次批量最多 ${MAX_BATCH_IDS} 条，已保留前 ${MAX_BATCH_IDS} 条`,
              );
              return;
            }
            setSelected(next);
          },
          /** 已到上限时，未选中的行不能再勾——让上限在控件上看得见 */
          getCheckboxProps: (r) => ({
            disabled: !selected.includes(r.id) && selected.length >= MAX_BATCH_IDS,
          }),
        }}
        refresh={
          /*
            刷新是**视图控件**，与「列设置」并排放在右端（2026-10-21 用户定的次序）。
            本页顶部的统计卡已按原型撤掉（2026-10-22），所以只刷列表这一份读数。
          */
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void refetch()} />
        }
        tools={
          /*
            右端次序与案件列表一致：**新建 → 导入 → 导出**。
            主色落在「新建」上（2026-10-23 用户裁定：它属于表格体的动作，不进筛选区）。
          */
          <>
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setCreating(true)}
            >
              新建
            </Button>
            {/*
              批量导入（MATT-102）：类型由**本页**锁定为 `risk_matter`（弹层里不给类型选择器）。
              `canImport` 由服务端每个端点判（403），前端不镜像谓词（见 ImportDialog 文件头）。
            */}
            <Button size="small" onClick={() => setImporting(true)}>
              批量导入
            </Button>
            {/* 导出吃的是**当前筛选**（含「未指派」与新增两档）：`state` 自己进控件 */}
            <ExportListButton path="/api/risk-matters/export" fileBase="事项列表" state={state} />
          </>
        }
        toolbar={
          /*
            canon `.tool`：**选中之后才有意义**的动作放这一条（与案件列表分工相同）。
            放进卡片头会让"依赖选中"和"一直都在"的动作混成一行，也看不出谁要选中。
          */
          selected.length ? (
            <>
              <span className="selbar-count">
                已选 <span className="num">{selected.length}</span> 项
              </span>
              <Button className="primary" size="small" onClick={() => setBatch("status")}>
                改状态
              </Button>
              <Button size="small" onClick={() => setBatch("archive")}>
                归档
              </Button>
              <Button size="small" onClick={() => setBatch("tag")}>
                加标签
              </Button>
              <Button size="small" type="link" onClick={() => setSelected([])}>
                取消选择
              </Button>
            </>
          ) : null
        }
        columns={columns}
        rows={pageRows}
        rowKey={(r) => r.id}
        total={data?.total ?? 0}
        page={state.page}
        pageSize={state.pageSize}
        loading={isFetching}
        onRowOpen={(r) => router.push(`/risk-matters/${r.id}`)}
        onPageChange={(p) => push({ page: p })}
        onPageSizeChange={(size) => push({ pageSize: size })}
        onSortChange={(k, d) => push({ sortBy: k, sortDir: d })}
        hideable={[
          { key: "report", title: "上报时间" },
          { key: "next_deadline", title: "期限" },
        ]}
        empty={
          <StateBlock
            title={hasRiskFilter(state) ? "当前筛选下没有可见事项" : "还没有在办事项"}
            hint={
              hasRiskFilter(state)
                ? "清掉条件再看一次；范围不同看到的条数就不同。"
                : "点右上「新建」报备一条。"
            }
          />
        }
      />

      <BatchDialog
        mode={batch}
        rows={selectedRows}
        dict={meta}
        onClose={() => setBatch(null)}
        onDone={(summary, labels) => {
          setBatchResult({ summary, labels });
          // 没做成的那些**留在选中态**里：摘要说的是"哪几条没成、为什么"，
          // 而用户下一步要么改条件重试、要么把这几条剔掉——两种都需要它们还选着。
          setSelected(summary.skipped.map((s) => s.id));
          void refetch();
        }}
      />

      <ConvertDialog
        source={converting}
        onClose={() => setConverting(null)}
        onOpenCase={(cid) => router.push(`/matters/${cid}`)}
      />
      <RiskCreateDialog open={creating} onOpenChange={setCreating} />
      <ImportDialog hostType="risk_matter" open={importing} onOpenChange={setImporting} />
    </div>
  );
}

/**
 * 空态文案要能区分"筛空了"与"本来就没有"。
 *
 * 与 `matters-view.tsx` 的 `hasFilter` 同类，键集是事项侧的那一份：
 * 关键词 / 状态 / 风险等级 / 上报时间 / 经办人（两种形态）/ 归档视图。
 */
function hasRiskFilter(s: ListState) {
  return Boolean(
    s.keyword ||
    s.status ||
    s.riskLevel ||
    s.reportBucket ||
    s.owner ||
    s.ownerEmpty ||
    s.archivedOnly,
  );
}

/** 三个批量动作，与 `shared/schema/batch.ts` 的 `BATCH_ACTIONS` 是同一个集合（少一个就编译不过） */
type BatchMode = "status" | "archive" | "tag";
/**
 * 摘要 + **提交那一刻的编号字典**。
 *
 * 编号跟着摘要一起定格，而不是渲染时回当前页去找：用户看完摘要可能已经翻了页，
 * 那时"哪条被跳过了"就只剩一个雪花 id——一个 19 位数字对用户没有任何意义。
 */
type BatchResult = { summary: BatchSummary; labels: Record<string, string> };

/**
 * 批量动作对话框（三个动作共用一张壳）。与案件列表那份同构，差异只有两处：
 * 端点（`/api/risk-matters/batch`）与行上的编号字段（事项是 `code`）。
 *
 * 提交前的拦截只是**体验**（少撞一次 4xx）：真正的判定在服务层逐行跑，包括"要不要原因"
 * （`needsChangeReason`，与单条路径同一个谓词）与"能不能动这一行"（归属护栏 / 归档特权）。
 */
function BatchDialog({
  mode,
  rows,
  dict,
  onClose,
  onDone,
}: {
  mode: BatchMode | null;
  rows: RiskRow[];
  /**
   * `/api/meta` 的字典。**参数名不叫 `meta`**：`tools/lint-guard` 有一条按名字扫的
   * 源码断言（副标题纪律，防那两个插槽悄悄回来），而它自己写着"局部变量取这个名字
   * 会误报一次，是说清代价后接受的误报"。改名的代价是零，改断言的代价是松掉那条纪律
   * ——所以这里让路。
   */
  dict: Meta | undefined;
  onClose: () => void;
  onDone: (summary: BatchSummary, labels: Record<string, string>) => void;
}) {
  const { message } = AntdApp.useApp();
  const [to, setTo] = useState<string | undefined>();
  const [reason, setReason] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const open = mode !== null;
  // 每次打开都清空：上一次的目标状态/原因留在这里，会让"点开就提交"变成一次没读过的操作
  useEffect(() => {
    if (open) {
      setTo(undefined);
      setReason("");
      setTagIds([]);
    }
  }, [open, mode]);

  const statusRows = dict?.statuses ?? [];
  /**
   * 归档不混进这个下拉：它有自己那个按钮，而两者的护栏不同（归档恒要原因，
   * 服务层还会把归档行按"撤销归档"那一档处理）。同一件事两个入口只会让人怀疑哪个是真的。
   */
  const toOptions = statusRows
    .filter((s) => s.semantics !== "archived")
    .map((s) => ({ value: s.code, label: s.name }));
  const toRow = statusRows.find((s) => s.code === to);

  /**
   * 要不要原因：**逐行**跑单条路径那个谓词。批量里"有的行要、有的行不要"是常态，
   * 所以按"任意一行要"就亮出必填；服务层仍然逐行判。
   */
  const reasonRequired =
    mode === "status" &&
    rows.some((r) =>
      needsChangeReason({
        from: r.status,
        fromNextCodes: statusRows.find((s) => s.code === r.status)?.nextStatusCodes ?? [],
        to: to ?? "",
        toSemantics: toRow?.semantics ?? "",
      }),
    );

  const canSubmit =
    rows.length > 0 &&
    (mode === "status"
      ? Boolean(to) && (!reasonRequired || reason.trim().length > 0)
      : mode === "archive"
        ? reason.trim().length > 0
        : tagIds.length > 0);

  async function submit() {
    if (!canSubmit || mode === null) return;
    setBusy(true);
    try {
      const ids = rows.map((r) => r.id);
      const res =
        mode === "tag"
          ? await api.post<BatchSummary>("/api/risk-matters/batch", { action: "tag", ids, tagIds })
          : await api.post<BatchSummary>("/api/risk-matters/batch", {
              action: mode,
              ids,
              reason: reason.trim(),
              ...(mode === "status" ? { to } : {}),
            });
      onDone(res, Object.fromEntries(rows.map((r) => [r.id, r.code])));
      onClose();
    } catch (e) {
      message.error(e instanceof ApiFailure ? e.message : "批量操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="确认执行"
      okButtonProps={{ disabled: !canSubmit }}
      confirmLoading={busy}
      title={mode === "status" ? "批量改状态" : mode === "archive" ? "批量归档" : "批量加标签"}
      width={460}
    >
      <p className="mut3" style={{ fontSize: 12, margin: "4px 0 14px" }}>
        已选 <span className="num">{rows.length}</span> 条
        {rows.length > 0 && rows.length <= 3 ? `：${rows.map((r) => r.code).join("、")}` : ""}
      </p>
      <Form layout="vertical" requiredMark={false}>
        {mode === "status" ? (
          <Form.Item label="目标状态" required>
            <Select
              placeholder="选择要转到的状态"
              value={to}
              onChange={setTo}
              options={toOptions}
            />
          </Form.Item>
        ) : null}

        {mode === "tag" ? (
          <Form.Item label="标签" required help="追加，不是替换：这些记录上已有的标签不会被去掉。">
            <Select
              mode="multiple"
              placeholder="选择要加的标签"
              value={tagIds}
              onChange={setTagIds}
              options={(dict?.tags ?? []).map((t) => ({ value: t.id, label: t.name }))}
            />
          </Form.Item>
        ) : null}

        {mode === "status" || mode === "archive" ? (
          <Form.Item
            label="原因"
            required={mode === "archive" || reasonRequired}
            help={
              mode === "archive"
                ? "归档后这些记录从在办列表消失；撤销归档需要「撤销归档」权限。"
                : reasonRequired
                  ? "这些行里有的不在推荐路径上，要写一句为什么。"
                  : "走推荐路径，不需要原因；写了会一起进活动记录。"
            }
          >
            <Input.TextArea
              rows={3}
              maxLength={500}
              showCount
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={mode === "archive" ? "为什么现在归档" : "补充说明（选填）"}
            />
          </Form.Item>
        ) : null}
      </Form>
    </Modal>
  );
}

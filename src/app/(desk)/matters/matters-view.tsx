"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Tooltip,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";

import { api, ApiFailure, useMeta, type Meta } from "@/app/lib/client/api";
import { toQuery, useListState, type ListState } from "@/app/lib/client/use-list-state";
import { useMatterMetrics, type MatterMetrics } from "@/app/lib/client/api-matter-metrics";
import { DEADLINE_TONE } from "@/app/theme/antd";
import { INK } from "@/app/theme/brand";
import { BATCH_SKIP_REASON_LABELS, MAX_BATCH_IDS, type BatchSummary } from "@/shared/schema/batch";
import { needsChangeReason } from "@/shared/schema/status-transition";
import { FilterField, QueryFilter } from "@/app/components/query-filter";
import { ExportListButton } from "@/app/components/export-file-button";
import { ReportCards } from "@/app/components/report-cards";
import { DataTable, sortOrderOf } from "@/app/components/ui/data-table/DataTable";
import { InlineSelect } from "@/app/components/ui/inline-select";
import { StatusDialog, type StatusTarget } from "@/app/components/status-dialog";
import { StatusMark } from "@/app/components/ui/status-mark";
import { DeadlineMark } from "@/app/components/ui/deadline-mark";
import { StateBlock } from "@/app/components/ui/state-block";
import { MatterCreateDialog } from "./matter-create-dialog";
import { ImportDialog } from "@/app/components/import-dialog";

type MatterRow = {
  id: string;
  internalCode: string;
  caseNo: string;
  name: string;
  cause: string;
  caseType: string;
  procedure: string;
  level: string;
  status: string;
  isArchived: boolean;
  amount: string;
  ownerName: string;
  /** 行内「变更处理人」要知道"当前是谁"，才判得出选的是不是一个新的人 */
  ownerId: string;
  updatedAt: string;
  nextDeadline: string | null;
  /** 立案日期（`YYYY-MM-DD`），可空 */
  filingDate: string | null;
};
type ListResult = { items: MatterRow[]; page: number; pageSize: number; total: number };

/**
 * 查询区的草稿态：六个筛选各一个。
 *
 * 用**字符串**（而不是 `string | undefined`）表示"不限"——antd `Select` 的受控值
 * 要一个具体值才能回到占位符，`""` 在这里就是"没选"。提交时由 `push` 把空串删键。
 */
type DraftFilters = {
  keyword: string;
  status: string;
  caseType: string;
  procedure: string;
  owner: string;
  deadlineBucket: string;
};

const EMPTY_DRAFT: DraftFilters = {
  keyword: "",
  status: "",
  caseType: "",
  procedure: "",
  owner: "",
  deadlineBucket: "",
};

/** 已提交的筛选 → 草稿（后退、点侧栏、清空筛选之后控件要跟着回显） */
function toDraft(s: ListState): DraftFilters {
  return {
    keyword: s.keyword,
    status: s.status,
    caseType: s.caseType ?? "",
    procedure: s.procedure ?? "",
    owner: s.owner ?? "",
    deadlineBucket: s.deadlineBucket ?? "",
  };
}

/**
 * 期限范围四档。**键名与服务端 `list-query.ts` 的 `deadlineBucket` 值域逐字一致**
 * ——中间不经过任何映射，所以"界面给了这个值、服务端不认"这种漂移在类型层就红。
 */
const DEADLINE_BUCKET_OPTIONS: { value: string; label: string }[] = [
  { value: "overdue", label: "已逾期" },
  { value: "soon", label: "7 日内" },
  { value: "later", label: "更远" },
  { value: "none", label: "未定期限" },
];

/**
 * 案件列表（在办）。构图照 canon 原型 `.impeccable/mocks/pages/matters.html`：
 *
 *   **指标带（6 格）→ 查询区（6 项）→ 表格卡**
 *
 * 三段的顺序是有理由的，不是抄版式：
 *   · 指标带回答"现在有几个该动手的"，它在最上面才有意义（往下滚就看不见了）；
 *   · 查询区紧跟在它下面：指标是**这几个筛选**的读数，改筛选数字跟着变（F8-1）；
 *   · 表格卡是主体，指标与筛选都只占首屏一条。
 *
 * 2026-10-19 的三处改判（用户裁定）：
 *   1. 渲染件回到 AntD（`DataTable` 内是 antd `Table`，查询区是 `Form/Row/Col`）——
 *      "相关组件使用 AntD 开发，不要自开发"；
 *   2. 指标带与 4 个新筛选项**全量对齐原型**，缺的服务端聚合与筛选参数一并补
 *      （`/api/matters/metrics`、`/api/matters/owners`、`listQuerySchema` 的新四键）；
 *   3. 列集照原型换：案号 / 案名 / 类型 / 程序 / 状态 / 经办人 / 立案日期 / 最近期限 / 操作。
 *      移走的「标的额 / 等级 / 更新」在详情页仍在，不是丢数据。
 *
 * 2026-10-21：再从列集里去掉「类型」一列（同批案件几乎全是「民商事」，一列九行同一个词）。
 * 类型在详情页的「基本信息」与上方筛选区都还在，筛选用得上、列表不必占列宽。
 *
 * 归档不在这里：这是**在办列表**，已归档由 `/archive` 承接（`archivedOnly` 二态开关）。
 */
export function MattersView() {
  const router = useRouter();
  const qc = useQueryClient();
  const { message } = AntdApp.useApp();
  const { state, push } = useListState();
  const { data: meta } = useMeta("matter");
  const metrics = useMatterMetrics(state);
  const [creating, setCreating] = useState(false);
  /** 批量导入弹层（MATT-102）：类型锁定为 `matter`，见页头那个按钮的注释 */
  const [importing, setImporting] = useState(false);
  /**
   * 批量动作的选中集合（MATT-45）——**受控，且只装当前页的 id**。
   *
   * 选择面走 `DataTable` 的 `rowSelection`（行首勾选 + 表头全选），与 canon 原型
   * `matters.html` 的 `.cb` 列同形。
   *
   * 翻页或换筛选后旧 id 一律丢掉（下面那个 effect）：留着会让"我选了几条"与实际提交的行
   * 对不上——用户翻了两页之后不记得选过什么，而请求照样会作用在那些行上。
   * `DataTable` 的 `rows` 就是当前页（它自己的注释明写"传全量进来就是误用"），所以
   * "选中集合 ⊆ 当前页"这条约束与它同源。
   *
   * 一次批量最多 `MAX_BATCH_IDS`（50）条，而 `pageSize` 可以到 100：超限的截断与禁用
   * 写在 `rowSelection` 那一处（见那里的注释）。
   */
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState<BatchMode | null>(null);
  /** 上一次批量动作的结果摘要。**留在页面上**而不是只弹一个 toast：跳过原因要能对着列表读 */
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);

  /**
   * 查询区的**草稿态**：输入不立刻进 URL，「查询」/回车才提交。
   * 外部改了 URL（后退、点侧栏、清空筛选）要跟着回显，所以下面用 effect 同步。
   *
   * 六个筛选各一个草稿。用对象而不是六个 `useState`：同步逻辑只有一处，
   * 加第七个筛选时不会漏掉某一个的 `setX(state.x)`（漏了的表现是"后退了但控件没回退"）。
   */
  const [draft, setDraft] = useState<DraftFilters>(toDraft(state));
  useEffect(() => {
    setDraft(toDraft(state));
  }, [
    state.keyword,
    state.status,
    state.caseType,
    state.procedure,
    state.owner,
    state.deadlineBucket,
  ]);

  /**
   * queryKey 里带全部查询参数：换页/换筛选时旧结果不会被当成新数据的缓存命中。
   * 不保留上一页的占位数据——那会让"点了没变"和"正在加载"分不开。
   */
  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ["matters", state],
    queryFn: () => api.get<ListResult>(`/api/matters?${toQuery(state)}`),
  });

  /**
   * 经办人下拉的候选集：**当前筛选下真实出现过的负责人**（不是花名册，见端点注释）。
   *
   * 它吃的是**已提交的筛选**（`state`），不是草稿——候选集跟着"已经生效的筛选"变，
   * 跟着草稿变会让用户每选一个下拉就重新拉一次名单。
   */
  const owners = useQuery({
    queryKey: ["matter-owners", state.status, state.caseType, state.procedure],
    queryFn: () =>
      api.get<{ owners: { id: string; displayName: string }[] }>(
        `/api/matters/owners?${toQuery({ ...state, owner: "" })}`,
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

  /**
   * 案件类型 / 程序：闭集枚举，中文名来自 `/api/meta` 的 `enums`（与详情页、新建弹窗同一份字典）。
   * 只列**可写入**的类型——`non_litigation` 是历史值（`CASE_TYPES_WRITABLE` 的注释），
   * 拿它当下拉项会让人以为还能新建这种案卷。
   */
  const caseTypeOptions = useMemo(
    () =>
      Object.entries(meta?.enums.caseTypes ?? {})
        .filter(([code]) => code !== "non_litigation")
        .map(([value, label]) => ({ value, label })),
    [meta],
  );
  const procedureOptions = useMemo(
    () => Object.entries(meta?.enums.procedures ?? {}).map(([value, label]) => ({ value, label })),
    [meta],
  );

  /**
   * 行内编辑（2026-10-22 用户要求：点「经办人 / 状态 / 程序」三格的当前值就地改）。
   *
   * ## 为什么改状态不直接 POST 到底
   *
   * 状态流转有两件"改字段"没有的事：可能要走**非推荐路径**（必须写原因），
   * 目标若是归档还要求特权与材料就绪。这三件事 `StatusDialog` 已经写全了，
   * 行内版本只做**分流**：推荐路径直发，其它一律交给那个弹窗（带着已选的值过去，
   * 用户不用再选一次）。在行内再写一份原因框就是第二份实现，迟早跟它漂移。
   *
   * ## 为什么失败一律走 toast
   *
   * 行内没有第二处可以放错误：格子被点开的那一瞬已经收起，值回到原样。
   * 403（不是经办人 / 已归档）与 422（人不在可见集 / 该状态不可达）都要说出来，
   * 否则用户看到的是"点了，没变"。
   */
  const patchField = useMutation({
    mutationFn: (v: { id: string; body: { ownerId?: string; procedure?: string } }) =>
      api.patch<{ ok: true }>(`/api/matters/${v.id}`, v.body),
    onSuccess: () => {
      void refetch();
      // 经办人换了，上方「经办人」筛选的候选集跟着变
      void qc.invalidateQueries({ queryKey: ["matter-owners"] });
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "修改失败"),
  });

  const changeStatusInline = useMutation({
    mutationFn: (v: { id: string; to: string; reason?: string }) =>
      api.post<{ ok: true }>(`/api/matters/${v.id}/status`, v),
    onSuccess: () => void refetch(),
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "状态变更失败"),
  });

  /** 行内挑了一个"要写原因/要归档"的状态：转交 `StatusDialog`，并把选中的值带过去 */
  const [statusHandoff, setStatusHandoff] = useState<{ target: StatusTarget; to: string } | null>(
    null,
  );

  function submit() {
    push({
      keyword: draft.keyword.trim(),
      status: draft.status,
      caseType: draft.caseType,
      procedure: draft.procedure,
      owner: draft.owner,
      deadlineBucket: draft.deadlineBucket,
    });
  }

  function reset() {
    setDraft(EMPTY_DRAFT);
    push({
      keyword: "",
      status: "",
      caseType: "",
      procedure: "",
      owner: "",
      // 四档里的 empty 不是"不限"，这里是清筛选，所以直接删键
      deadlineBucket: "",
    });
  }

  /**
   * 列集**照 canon 原型 `matters.html`**（2026-10-19 用户裁定"照原型换"），
   * 2026-10-21 再去掉「类型」一列：案号 / 案名 / 程序 / 状态 / 经办人 / 立案日期 / 最近期限 / 操作。
   *
   * 移走的四列（类型 / 标的额 / 等级 / 更新时间）不是丢数据：类型在详情页的「基本信息」里，
   * 其余三列也都在。移的理由是列宽预算——原型那张表的合计 ≈1100，再塞列会让案名那列在
   * 1366 下被压到读不出谁是谁。**「类型」是其中最该走的一个**：同一批案件几乎全是
   * 「民商事」，一列里九行写着同一个词，占着 104px 的预算却几乎不携带信息。
   *
   * 宽度合计：150+（伸缩）+88+96+76+100+120+104 ≈ 734 + 伸缩，省下的 ≈104 归给案名。
   */
  const columns = useMemo<TableColumnsType<MatterRow>>(() => {
    return [
      {
        key: "code",
        title: "案号",
        width: 150,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("code", state.sortBy, state.sortDir),
        render: (_, r) => <span className="num">{r.internalCode}</span>,
      },
      {
        key: "name",
        title: "案名",
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("name", state.sortBy, state.sortDir),
        /**
         * 整行点击进详情（`onRowOpen`），但案名本身也是一个明确的入口：
         * 只靠整行点击的话，键盘用户与"点名字"这个最常见的动作都没有落点。
         *
         * **全名走 Tooltip，不走 `title`**：原生 `title` 要等一秒才出、样式是浏览器灰框、
         * 鼠标移开就没了。antd 的 `Tooltip` 能跟着光标、样式跟全站一致。
         * 只在**真的被截断**时才需要它——案名列有宽度预算，长案名会被省略号截断，
         * 用户看不到后半截就分不出是哪件案子。
         */
        render: (_, r) => (
          <Tooltip title={r.name} mouseEnterDelay={0.2}>
            <a href={`/matters/${r.id}`} onClick={(e) => e.stopPropagation()}>
              {r.name}
            </a>
          </Tooltip>
        ),
      },
      {
        key: "procedure",
        title: "程序",
        width: 88,
        ellipsis: true,
        render: (_, r) => (
          <InlineSelect
            value={r.procedure}
            display={meta?.enums.procedures[r.procedure] ?? r.procedure}
            options={procedureOptions}
            disabled={r.isArchived}
            title={r.isArchived ? "已归档的案卷只读" : "点击切换程序（审级）"}
            onPick={(v) => patchField.mutate({ id: r.id, body: { procedure: v } })}
          />
        ),
      },
      {
        key: "status",
        title: "状态",
        width: 96,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("status", state.sortBy, state.sortDir),
        render: (_, r) => {
          const from = meta?.statuses.find((s) => s.code === r.status);
          const options = statusOptions
            .filter((o) => o.value !== r.status)
            .map((o) => ({
              ...o,
              // 「推荐」两个字就是 `next_status_codes` 的可视化（与 `StatusDialog` 同一口径）
              label:
                (from?.nextStatusCodes.length ?? 0) > 0 && from?.nextStatusCodes.includes(o.value)
                  ? `${o.label}（推荐）`
                  : o.label,
            }));
          return (
            <InlineSelect
              value={r.status}
              display={<StatusMark host="matter" code={r.status} />}
              options={options}
              disabled={r.isArchived}
              title={r.isArchived ? "已归档的案卷只读" : "点击变更状态"}
              onPick={(v) => {
                const to = meta?.statuses.find((s) => s.code === v);
                const reasonRequired = needsChangeReason({
                  from: r.status,
                  fromNextCodes: from?.nextStatusCodes ?? [],
                  to: v,
                  toSemantics: to?.semantics ?? "",
                });
                if (reasonRequired) {
                  // 要写原因：交给 `StatusDialog`（它管原因、归档就绪与错误），值带过去
                  setStatusHandoff({
                    target: {
                      host: "matter",
                      id: r.id,
                      code: r.internalCode,
                      name: r.name,
                      status: r.status,
                    },
                    to: v,
                  });
                  return;
                }
                changeStatusInline.mutate({ id: r.id, to: v });
              }}
            />
          );
        },
      },
      {
        key: "owner_name",
        title: "经办人",
        /**
         * 原型是 72（它没有排序箭头）。这里这一列可排序，箭头要占约 18px，
         * 72 会把**表头**本身裁成「经…」——所以补到 90，仍比原来的 76 只多 14。
         */
        width: 90,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("owner_name", state.sortBy, state.sortDir),
        render: (_, r) => (
          <OwnerCell
            row={r}
            onPick={(userId) => patchField.mutate({ id: r.id, body: { ownerId: userId } })}
          />
        ),
      },
      {
        /**
         * 立案日期。⚠ 这句话现在只是**列声明**：`filingDate` 还不在列表 DTO 里
         * （`matterListSelection` 未选它），所以下面 `render` 取到的是 `undefined`。
         * 见本文件末尾的 `filingDate` 说明——补齐它要动服务层的投影与导出，属下一步。
         */
        key: "filing_date",
        title: "立案日期",
        width: 100,
        ellipsis: true,
        render: (_, r) => <span className="num">{r.filingDate ?? "—"}</span>,
      },
      {
        key: "next_deadline",
        title: "最近期限",
        width: 116,
        ellipsis: true,
        render: (_, r) => <DeadlineMark iso={r.nextDeadline} />,
      },
      {
        /**
         * 行内快捷动作（canon `matters.html` 的「操作」列）。
         *
         * 原型里三个都是指向详情页的静态锚；这里让它们**真的落到不同的地方**，
         * 否则三条链接就是同一个动作摆三遍：
         *   · 进展 → 「进展」页签（`?tab=log`，键名沿用；评论 2026-10-21 搬去了详情页右栏）；
         *   · 状态 → 详情页的状态弹窗（`?action=status`，进页即开，不用再找按钮）；
         *   · 程序 → 「基本信息」页签（程序是那张字段表里的一行，不是独立页签）。
         *
         * 三条都是 `<a>`：新标签打开、右键复制链接、键盘 Tab 到都自然成立——
         * 而"点了没反应"的那个版本（都指向同一页）在设计上就说不通。
         */
        key: "actions",
        title: "操作",
        width: 168,
        render: (_, r) => (
          <Space size={4} onClick={(e) => e.stopPropagation()}>
            <Button type="link" size="small" href={`/matters/${r.id}?tab=log`}>
              进展
            </Button>
            <Button type="link" size="small" href={`/matters/${r.id}?action=status`}>
              状态
            </Button>
            <Button type="link" size="small" href={`/matters/${r.id}?tab=basic`}>
              程序
            </Button>
          </Space>
        ),
      },
    ];
  }, [
    meta,
    state.sortBy,
    state.sortDir,
    procedureOptions,
    statusOptions,
    patchField,
    changeStatusInline,
  ]);

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
    <div className="stack list">
      {/*
        指标带（canon `.metrics`，6 格）。六个数全部来自 `/api/matters/metrics`
        ——**不在前端按当页算**（禁令⑧：手里的只有当前页，算出来的是"这一页的读数"）。
        加载时不画 0：0 是一个结论（"一条逾期的都没有"），与"还没读到"是两件事。

          与原型 `matters.html` 对齐：一张带、六格、格间竖线分隔，而不是六张独立小卡。 */}
      <MetricsBand q={metrics} layout="strip" />

      {/* 报表两卡（MATT-46）。工作台的「案件报表」用 `#reports` 锚到这里 */}
      <div id="reports">
        <ReportCards host="matter" filters={state} />
      </div>

      <QueryFilter onSearch={submit} onReset={reset} busy={isFetching}>
        <FilterField label="关键词" htmlFor="matter-keyword" width={200}>
          <Input
            id="matter-keyword"
            allowClear
            value={draft.keyword}
            placeholder="案号 / 案名 / 案由"
            onChange={(e) => setDraft((d) => ({ ...d, keyword: e.target.value }))}
            onPressEnter={submit}
          />
        </FilterField>
        <FilterField label="案件状态" htmlFor="matter-status" width={120}>
          <Select
            id="matter-status"
            allowClear
            placeholder="全部"
            value={draft.status || undefined}
            options={statusOptions}
            onChange={(v) => setDraft((d) => ({ ...d, status: v ?? "" }))}
          />
        </FilterField>
        <FilterField label="案件类型" htmlFor="matter-case-type" width={120}>
          <Select
            id="matter-case-type"
            allowClear
            placeholder="全部"
            value={draft.caseType || undefined}
            options={caseTypeOptions}
            onChange={(v) => setDraft((d) => ({ ...d, caseType: v ?? "" }))}
          />
        </FilterField>
        <FilterField label="案件程序" htmlFor="matter-procedure" width={120}>
          <Select
            id="matter-procedure"
            allowClear
            placeholder="全部"
            value={draft.procedure || undefined}
            options={procedureOptions}
            onChange={(v) => setDraft((d) => ({ ...d, procedure: v ?? "" }))}
          />
        </FilterField>
        <FilterField label="经办人" htmlFor="matter-owner" width={120}>
          <Select
            id="matter-owner"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="全部"
            value={draft.owner || undefined}
            options={(owners.data?.owners ?? []).map((o) => ({
              value: o.id,
              label: o.displayName,
            }))}
            onChange={(v) => setDraft((d) => ({ ...d, owner: v ?? "" }))}
          />
        </FilterField>
        <FilterField label="期限范围" htmlFor="matter-deadline" width={120}>
          <Select
            id="matter-deadline"
            allowClear
            placeholder="全部"
            value={draft.deadlineBucket || undefined}
            options={DEADLINE_BUCKET_OPTIONS}
            onChange={(v) => setDraft((d) => ({ ...d, deadlineBucket: v ?? "" }))}
          />
        </FilterField>
      </QueryFilter>

      {/*
        批量结果。**留在页面上**而不是只弹一个 toast：跳过原因要能对着列表读，
        而 toast 三秒后就没了。用 `Alert` 而不是自绘卡片——它自带关闭按钮与语义色彩。
      */}
      {batchResult ? (
        <Alert
          type={batchResult.summary.skipped.length ? "warning" : "success"}
          showIcon
          closable
          onClose={() => setBatchResult(null)}
          title={
            <>
              批量动作完成：成功 <span className="num">{batchResult.summary.applied}</span> 条
              {batchResult.summary.skipped.length ? (
                <>
                  {" "}
                  · 跳过 <span className="num">{batchResult.summary.skipped.length}</span> 条
                </>
              ) : null}
            </>
          }
          description={
            batchResult.summary.skipped.length ? (
              <Space orientation="vertical" size={2}>
                {batchResult.summary.skipped.map((s) => (
                  <span key={s.id} style={{ fontSize: 12 }}>
                    <span className="num">{batchResult.labels[s.id] ?? s.id}</span> —{" "}
                    {BATCH_SKIP_REASON_LABELS[s.reason]}
                  </span>
                ))}
              </Space>
            ) : undefined
          }
        />
      ) : null}

      <DataTable<MatterRow>
        title="案件列表"
        rowSelection={{
          type: "checkbox",
          /** canon 原型 `matters.html` 的勾选列是 44px；antd 默认 32 会把表头挤得比行内窄 */
          columnWidth: 44,
          selectedRowKeys: selected,
          /**
           * 一次批量最多 `MAX_BATCH_IDS`（50）条，而 `pageSize` 可以到 `MAX_PAGE_SIZE`（100）：
           * 表头全选会选出一个**注定 400** 的集合。所以在入口处截断并说明，而不是让用户
           * 提交后才知道——"全选"静默只选前 50 条同样糟，用户会以为全选就是全选。
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
            刷新是**视图控件**（改的是"这一屏怎么显示"），不是对记录的动作，所以它归到卡头
            右端的视图控件组里，与「列设置」并排（2026-10-21 用户定的右端次序）。
            列表与指标带是同一屏的两份读数，只刷列表会让"列表 21 行、卡片 20"同时成立
            （工作台的刷新也是这个口径：一次刷掉本页所有读数）。
          */
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => {
              void refetch();
              void qc.invalidateQueries({ queryKey: ["matters-metrics"] });
            }}
          />
        }
        tools={
          <>
            {/*
              右端的次序由用户 2026-10-21 定死：**新建 → 导入 → 导出**，其后才是表格设置类
              （「列设置」与上面的 `refresh` 由 `DataTable` 收进同一组）。
              读法是从"要做什么"到"要什么数据"到"怎么把这屏调成我想看的样子"。
            */}
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setCreating(true)}
            >
              新建案件
            </Button>
            {/*
              批量导入（MATT-102）：入口从系统组的独立页搬到这里、弹层形式。
              类型由**本页**锁定为 `matter`（弹层里不给类型选择器）——用户是在"案件"里点的，
              再让他选一次"导什么"是把入口给的信息又收回去。
              `canImport` 由服务端每个端点判（403），前端不镜像谓词（见 ImportDialog 文件头）。
            */}
            <Button size="small" onClick={() => setImporting(true)}>
              批量导入
            </Button>
            {/* 导出吃的是**当前筛选**（`state` 自己进控件，见 ExportListButton 的注释） */}
            <ExportListButton path="/api/matters/export" fileBase="案件列表" state={state} />
          </>
        }
        toolbar={
          /*
            canon `.tool`（原型 `matters.html` 的表格上方那条）：有选中项时才出现。
            与 `tools` 的分工——`tools` 是这一页**一直都在**的动作（刷新 / 导出 / 新建），
            `toolbar` 是**选中之后才有意义**的动作（改状态 / 归档 / 加标签）。
            两个都放卡片头会让卡片头挤成两行，且看不出哪个按钮依赖选中。
          */
          selected.length ? (
            <>
              <span className="selbar-count">
                已选 <span className="num">{selected.length}</span> 项
              </span>
              {/* 这一条里唯一的强调动作（样式在 `globals.css` 的 `.selbar .ant-btn.primary`）：
                  四个动作等重时，用户得读完标签才知道先点哪个 */}
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
        onRowOpen={(r) => router.push(`/matters/${r.id}`)}
        onPageChange={(p) => push({ page: p })}
        onPageSizeChange={(size) => push({ pageSize: size })}
        onSortChange={(k, d) => push({ sortBy: k, sortDir: d })}
        hideable={[
          { key: "procedure", title: "程序" },
          { key: "filing_date", title: "立案日期" },
        ]}
        empty={
          <StateBlock
            title={hasFilter(state) ? "当前筛选下没有可见案件" : "还没有在办案件"}
            hint={
              hasFilter(state)
                ? "清掉筛选再看一次；如果同事能看见而你不能，那是数据范围（L1/L2/L3）的差异。"
                : "点右上「新建案件」，内部编号会由数据库单语句取号。"
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

      <MatterCreateDialog open={creating} onOpenChange={setCreating} />
      <ImportDialog hostType="matter" open={importing} onOpenChange={setImporting} />

      {/* 行内挑到"要写原因"的状态时落到这里（值与目标行都已经带过来） */}
      <StatusDialog
        target={statusHandoff?.target ?? null}
        initialTo={statusHandoff?.to}
        statuses={meta?.statuses ?? []}
        open={statusHandoff !== null}
        onOpenChange={(v) => {
          if (!v) setStatusHandoff(null);
        }}
        onDone={() => {
          setStatusHandoff(null);
          void refetch();
        }}
      />
    </div>
  );
}

/** 三个批量动作，与 `shared/schema/batch.ts` 的 `BATCH_ACTIONS` 是同一个集合（少一个就编译不过） */
type BatchMode = "status" | "archive" | "tag";

/** 有没有任何筛选生效——决定空态说"筛没了"还是"还没有"（两者要用户做的事不同） */
function hasFilter(s: ListState): boolean {
  return Boolean(s.keyword || s.status || s.caseType || s.procedure || s.owner || s.deadlineBucket);
}

/**
 * 「经办人」这一格：读态是名字，点开是候选人下拉。
 *
 * ## 候选人为什么按行取、且只在点开时取
 *
 * 候选集来自 `/api/matters/{id}/selectable-users`（在册可用 ∩ 我这卷的可见用户），
 * 它是**按案卷算**的，没有"一次拿全部"的版本——列表页也拿不到宿主 id。
 * 一屏 20 行各发一次请求是纯浪费（大多数行根本不会被点），所以 `enabled` 挂在这里：
 * 点开哪一行就取哪一行。
 *
 * ## 当前经办人放在选项第一位
 *
 * `Select` 的 `value` 要在 `options` 里才显示得成人名。候选人还没回来时列表是空的，
 * 那时控件会直接把 id 画出来。把当前值自己补进选项，加载中也不会闪出一串数字；
 * 选回自己不会触发写请求（`InlineSelect` 已经拦了"值没变"）。
 */
function OwnerCell({ row, onPick }: { row: MatterRow; onPick: (userId: string) => void }) {
  const [asked, setAsked] = useState(false);
  const q = useQuery({
    queryKey: ["selectable-users", "matter", row.id],
    queryFn: () =>
      api.get<{ users: { id: string; displayName: string; username: string }[] }>(
        `/api/matters/${row.id}/selectable-users`,
      ),
    enabled: asked,
    // 同一行反复点开不必每次重取；换人成功后 `patchField` 会刷列表，这里 60s 内足够
    staleTime: 60_000,
  });
  const options = useMemo(() => {
    const others = (q.data?.users ?? [])
      .filter((u) => u.id !== row.ownerId)
      .map((u) => ({ value: u.id, label: u.displayName }));
    return [{ value: row.ownerId, label: row.ownerName }, ...others];
  }, [q.data, row.ownerId, row.ownerName]);

  return (
    <InlineSelect
      value={row.ownerId}
      display={row.ownerName}
      options={options}
      loading={q.isFetching}
      disabled={row.isArchived}
      title={row.isArchived ? "已归档的案卷只读" : "点击变更处理人"}
      onOpen={() => setAsked(true)}
      onPick={onPick}
    />
  );
}

/**
 * 六格指标带（canon `.metrics`），用 antd `Card` 的网格铺开。
 *
 * ## 为什么不用 `Statistic`
 *
 * `Statistic` 自带"标题在上、数字在下"的排版与它自己的字号刻度，而 canon 的指标带是
 * **数字在上、标签在下**（读者先看数、再看这是什么数）。用它得把内置的两块都覆盖掉，
 * 那还不如直接用 `Card` + 两个文本节点——**结构简单的地方不该为了"用了 antd"而多一层**。
 * 这里用的是 `Card`（容器）+ `Row/Col`（网格），都是 antd 的布局件。
 *
 * ## 加载与空读数的区分
 *
 * `undefined`（还在读）= 画 `…`；`0` = 真的没有。**不把未读数画成 0**：
 * "一条逾期的都没有"是一个结论，与"还没读到"是两件事，而 0 会让人以为前者成立。
 *
 * ## 红色只在真的非零时出现
 *
 * 逾期那格非零才上色；恒为 0 的格子（未指派负责人）永远中性——
 * 上色会让人以为"这一项有问题"。
 */
function MetricsBand({
  q,
  layout = "cards",
}: {
  q: { data?: MatterMetrics; isPending: boolean };
  /** `strip` = 原型那张「一条带、格间竖线分隔」；`cards` = 六张独立小卡 */
  layout?: "cards" | "strip";
}) {
  const d = q.data;
  const cells: { key: string; label: string; value?: number; tone?: "over" | "due" }[] = [
    { key: "total", label: "在办案件", value: d?.total },
    { key: "overdue", label: "已逾期", value: d?.overdue, tone: "over" },
    { key: "soon", label: "7 日内到期", value: d?.soon, tone: "due" },
    { key: "unassigned", label: "未指派负责人", value: d?.unassigned },
    { key: "timeUnconfirmed", label: "限期未确认", value: d?.timeUnconfirmed },
    { key: "createdThisMonth", label: "本月新增", value: d?.createdThisMonth },
  ];
  if (layout === "strip") {
    return (
      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Row gutter={0} wrap={false}>
          {cells.map((c, i) => {
            const show = c.value !== undefined && c.value > 0;
            const color =
              c.tone === "over"
                ? DEADLINE_TONE.overdue.color
                : c.tone === "due"
                  ? DEADLINE_TONE.soon.color
                  : undefined;
            return (
              <Col
                key={c.key}
                flex="1 1 0"
                style={{
                  minWidth: 0,
                  padding: "14px 16px",
                  borderRight: i === cells.length - 1 ? undefined : "1px solid var(--line2)",
                }}
              >
                <div
                  className="num"
                  style={{
                    fontSize: 26,
                    fontWeight: 600,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.1,
                    color: show ? color : undefined,
                  }}
                >
                  {q.isPending && d === undefined ? "…" : (c.value ?? 0)}
                </div>
                <div style={{ fontSize: 12, color: INK.muted, marginTop: 2 }}>{c.label}</div>
              </Col>
            );
          })}
        </Row>
      </Card>
    );
  }
  return (
    <Row gutter={[12, 12]}>
      {cells.map((c) => {
        const show = c.value !== undefined && c.value > 0;
        const color =
          c.tone === "over"
            ? DEADLINE_TONE.overdue.color
            : c.tone === "due"
              ? DEADLINE_TONE.soon.color
              : undefined;
        return (
          <Col key={c.key} flex="1 1 0" style={{ minWidth: 120 }}>
            <Card size="small" styles={{ body: { padding: "10px 12px" } }}>
              <div
                className="num"
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  lineHeight: 1.15,
                  color: show ? color : undefined,
                }}
              >
                {q.isPending && d === undefined ? "…" : (c.value ?? 0)}
              </div>
              <div style={{ fontSize: 12, color: INK.muted, marginTop: 2 }}>{c.label}</div>
            </Card>
          </Col>
        );
      })}
    </Row>
  );
}

/**
 * 摘要 + **提交那一刻的行号字典**。
 *
 * 行号跟着摘要一起定格，而不是渲染时回当前页去找：用户看完摘要可能已经翻了页，
 * 那时"哪条被跳过了"就只剩一个雪花 id——一个 19 位数字对用户没有任何意义。
 */
type BatchResult = { summary: BatchSummary; labels: Record<string, string> };

/**
 * 批量动作对话框（三个动作共用一张壳）。
 *
 * 共用而不是各写一张：三者的差别只有"要填什么"（目标状态 / 原因 / 标签），
 * 而"提交哪个端点、失败怎么显示、提交前拦什么"是同一套——分开写就是三份会漂的实现。
 *
 * 提交前的拦截只是**体验**（少撞一次 4xx）：真正的判定在服务层逐行跑，
 * 包括"要不要原因"（`needsChangeReason`）与"能不能动这一行"（护栏 1 / 归档特权）。
 * 这里跑的是**同一个谓词**（与单条状态弹窗同源），不是抄一份规则。
 */
function BatchDialog({
  mode,
  rows,
  dict,
  onClose,
  onDone,
}: {
  mode: BatchMode | null;
  rows: MatterRow[];
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
   * 要不要原因：**逐行**跑单条路径那个谓词。批量里"有的行要、有的行不要"是常态
   * （几条从不同状态一起推到同一个目标态），所以按"任意一行要"就亮出必填；
   * 服务层仍然逐行判——不需要原因的那几行写了原因也不亏，会一起进活动记录。
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
          ? await api.post<BatchSummary>("/api/matters/batch", { action: "tag", ids, tagIds })
          : await api.post<BatchSummary>("/api/matters/batch", {
              action: mode,
              ids,
              reason: reason.trim(),
              ...(mode === "status" ? { to } : {}),
            });
      onDone(res, Object.fromEntries(rows.map((r) => [r.id, r.internalCode])));
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
        {rows.length > 0 && rows.length <= 3
          ? `：${rows.map((r) => r.internalCode).join("、")}`
          : ""}
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

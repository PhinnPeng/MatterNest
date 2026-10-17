"use client";

import { INK } from "@/app/theme/brand";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App as AntdApp,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Typography,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";

import { api, ApiFailure, useMeta, type Meta } from "@/app/lib/client/api";
import { toQuery, useListState } from "@/app/lib/client/use-list-state";
import { calDate, fromNow, money } from "@/app/lib/client/format";
import { BATCH_SKIP_REASON_LABELS, MAX_BATCH_IDS, type BatchSummary } from "@/shared/schema/batch";
import { needsChangeReason } from "@/shared/schema/status-transition";
import { FilterField, QueryFilter } from "@/app/components/query-filter";
import { ExportListButton } from "@/app/components/export-file-button";
import { ReportCards } from "@/app/components/report-cards";
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
  const qc = useQueryClient();
  const { state, push } = useListState();
  const { data: meta } = useMeta("risk_matter");
  const [converting, setConverting] = useState<RiskRow | null>(null);
  const [creating, setCreating] = useState(false);
  /**
   * 批量动作的选中集合（MATT-45）——**受控，且只装当前页的 id**。
   *
   * 与案件列表逐条同构（那边写全了理由）：`DataTable` 不支持逐行勾选，所以选择面收敛成
   * "当前页全选 / 全不选"，并把它摆在三个动作按钮旁边；翻页/换筛选后旧 id 一律丢掉。
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
  // 未指派筛选。undefined = 不限（后端 list-query.ts 的 ownerEmptyField 有注释）
  const [ownerEmpty, setOwnerEmpty] = useState(Boolean(state.ownerEmpty));
  useEffect(() => {
    setKw(state.keyword);
    setSt(state.status);
  }, [state.keyword, state.status]);

  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ["risk-matters", state],
    queryFn: () => api.get<ListResult>(`/api/risk-matters?${toQuery(state)}`),
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
    push({ keyword: kw.trim(), status: st, ownerEmpty: ownerEmpty ? "1" : undefined });
  }

  /** 未指派筛选是即时生效的：它就是一个开关，不需要再点一次"查询" */
  function applyOwnerEmpty(v: boolean) {
    setOwnerEmpty(v);
    push(v ? { ownerEmpty: "1" } : { ownerEmpty: undefined });
  }

  function reset() {
    setKw("");
    setSt("");
    setOwnerEmpty(false);
    push({ keyword: "", status: "", ownerEmpty: undefined });
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
          <Link
            href={`/risk-matters/${r.id}`}
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
          </Link>
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
        // 空值必须**说出来**：事项侧经办人可空（IQ-5），留白会被读成"数据缺失"，
        // 而它是一个有业务含义的状态——待人接手。
        render: (_, r) =>
          r.ownerName ? (
            r.ownerName
          ) : (
            <span style={{ color: INK.faint, fontSize: 12 }}>未指派</span>
          ),
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
        <FilterField label="经办人" width={150}>
          <Select
            allowClear
            placeholder="全部"
            value={ownerEmpty ? "1" : undefined}
            options={[{ value: "1", label: "未指派" }]}
            onChange={(v) => applyOwnerEmpty(Boolean(v))}
          />
        </FilterField>
      </QueryFilter>

      {/*
        统计卡（MATT-46 / F8-1 + F8-2）。位置：查询区**下面**、表格上面——
        它是查询区那几个筛选的读数（改筛选 → 数字跟着变），所以紧挨着筛选；
        而查询区本身留在全站列表页的第一屏位置（五个列表页的查询区都在同一处，
        把卡片插到它上面会让本页与其余四页的结构对不上）。
      */}
      <ReportCards host="risk_matter" filters={state} />

      {batchResult ? (
        <Alert
          type={batchResult.summary.skipped.length ? "warning" : "success"}
          showIcon
          closable
          onClose={() => setBatchResult(null)}
          style={{ marginBottom: 12 }}
          message={
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
                  <Typography.Text key={s.id} style={{ fontSize: 12 }}>
                    <span className="num">{batchResult.labels[s.id] ?? s.id}</span> —{" "}
                    {BATCH_SKIP_REASON_LABELS[s.reason]}
                  </Typography.Text>
                ))}
              </Space>
            ) : undefined
          }
        />
      ) : null}

      <DataTable<RiskRow>
        title="事项列表"
        tools={
          <Space size={8}>
            {/*
              选中集合的入口就在三个动作按钮旁边：`DataTable` 不支持逐行勾选（见上面 `selected`
              的注释），所以这里必须把"选了多少条"说出来——否则用户是按了按钮才知道作用范围的。

              `pageSize` 可以到 100（`MAX_PAGE_SIZE`），而一次批量最多 `MAX_BATCH_IDS`（50）条：
              两者不等时"全选当前页"会**做出一个注定 400 的选择**。所以那一档直接禁掉并把原因
              写出来——静默只选前 50 条更糟，用户会以为"全选"就是全选。
            */}
            <Checkbox
              checked={pageIds.length > 0 && selected.length === pageIds.length}
              disabled={!pageIds.length || pageIds.length > MAX_BATCH_IDS}
              onChange={(e) => setSelected(e.target.checked ? pageIds : [])}
            >
              全选当前页
            </Checkbox>
            {pageIds.length > MAX_BATCH_IDS ? (
              <Typography.Text style={{ fontSize: 12, color: INK.muted }}>
                当前页 <span className="num">{pageIds.length}</span> 条，超过一次批量的上限{" "}
                <span className="num">{MAX_BATCH_IDS}</span> 条
              </Typography.Text>
            ) : null}
            {selected.length ? (
              <Typography.Text style={{ fontSize: 12, color: INK.secondary }}>
                已选 <span className="num">{selected.length}</span> 条
              </Typography.Text>
            ) : null}
            <Button size="small" disabled={!selected.length} onClick={() => setBatch("status")}>
              改状态
            </Button>
            <Button size="small" disabled={!selected.length} onClick={() => setBatch("archive")}>
              归档
            </Button>
            <Button size="small" disabled={!selected.length} onClick={() => setBatch("tag")}>
              加标签
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                void refetch();
                // 统计卡是同一页的另一份读数：只刷列表会让"列表 21 行、卡片 20"同时成立
                // （工作台的刷新也是这个口径：一次刷掉本页所有读数）
                void qc.invalidateQueries({ queryKey: ["reports"] });
              }}
            />
            {/* 导出吃的是**当前筛选**（含「未指派」那一档）：`state` 自己进控件 */}
            <ExportListButton path="/api/risk-matters/export" fileBase="事项列表" state={state} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              新建事项
            </Button>
          </Space>
        }
        columns={columns}
        rows={pageRows}
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
              : "还没有在办事项。点右上「新建事项」报备一条。"}
          </Typography.Text>
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
    </div>
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
      <p style={{ fontSize: 12, color: INK.muted, margin: "4px 0 14px" }}>
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

"use client";

import { INK } from "@/app/theme/brand";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
import { fromNow, money } from "@/app/lib/client/format";
import { BATCH_SKIP_REASON_LABELS, MAX_BATCH_IDS, type BatchSummary } from "@/shared/schema/batch";
import { needsChangeReason } from "@/shared/schema/status-transition";
import { FilterField, QueryFilter } from "@/app/components/query-filter";
import { ExportListButton } from "@/app/components/export-file-button";
import { ReportCards } from "@/app/components/report-cards";
import { DataTable, sortOrderOf } from "@/app/components/ui/data-table/DataTable";
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
  const qc = useQueryClient();
  const { state, push } = useListState();
  const { data: meta } = useMeta("matter");
  const [creating, setCreating] = useState(false);
  /** 批量导入弹层（MATT-102）：类型锁定为 `matter`，见页头那个按钮的注释 */
  const [importing, setImporting] = useState(false);
  /**
   * 批量动作的选中集合（MATT-45）——**受控，且只装当前页的 id**。
   *
   * 为什么不给行首加一列勾选框：`DataTable` 是**全站唯一的数据表入口**（禁令⑧），
   * 而它没有 `rowSelection` 这个口子。为一个页面的需要给它加一层选中态，
   * 影响面是五个列表页 + 详情内嵌表；收益只是"能勾单行"。
   * 所以选择面收敛成"当前页全选 / 全不选"，并且**把它摆在工具条上、紧挨着三个动作按钮**
   * ——用户看得见自己选了多少条，而不是面对一列不知道会不会生效的勾选框。
   *
   * 翻页或换筛选后旧 id 一律丢掉（下面那个 effect）：留着会让"我选了几条"与实际提交的行
   * 对不上——用户翻了两页之后不记得选过什么，而请求照样会作用在那些行上。
   * `DataTable` 的 `rows` 就是当前页（它自己的注释明写"传全量进来就是误用"），所以
   * "选中集合 ⊆ 当前页"这条约束与它同源。
   */
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState<BatchMode | null>(null);
  /** 上一次批量动作的结果摘要。**留在页面上**而不是只弹一个 toast：跳过原因要能对着列表读 */
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);

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

      {/*
        统计卡（MATT-46 / F8-1 + F8-2）。位置：查询区**下面**、表格上面——
        它是查询区那几个筛选的读数（改筛选 → 数字跟着变），所以紧挨着筛选；
        而查询区本身留在全站列表页的第一屏位置（五个列表页的查询区都在同一处，
        把卡片插到它上面会让本页与其余四页的结构对不上）。
      */}
      <ReportCards host="matter" filters={state} />

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

      <DataTable<MatterRow>
        title="案件列表"
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
            {/* 导出吃的是**当前筛选**（`state` 自己进控件，见 ExportListButton 的注释） */}
            <ExportListButton path="/api/matters/export" fileBase="案件列表" state={state} />
            {/*
              批量导入（MATT-102）：入口从系统组的独立页搬到这里、弹层形式。
              类型由**本页**锁定为 `matter`（弹层里不给类型选择器）——用户是在"案件"里点的，
              再让他选一次"导什么"是把入口给的信息又收回去。
              `canImport` 由服务端每个端点判（403），前端不镜像谓词（见 ImportDialog 文件头）。
            */}
            <Button onClick={() => setImporting(true)}>批量导入</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              新建案件
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
    </div>
  );
}

/** 三个批量动作，与 `shared/schema/batch.ts` 的 `BATCH_ACTIONS` 是同一个集合（少一个就编译不过） */
type BatchMode = "status" | "archive" | "tag";

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
      <p style={{ fontSize: 12, color: INK.muted, margin: "4px 0 14px" }}>
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

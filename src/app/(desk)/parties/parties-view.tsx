"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, App as AntdApp, Dropdown, Form, Input, Modal, Select, Tooltip } from "antd";
import type { TableColumnsType } from "antd";

// `downloadCsv` 随 MATT-47 搬到 `api.ts`（当事人导出与整卷导出共用同一个下载实现）
import { api, ApiFailure, downloadCsv, toOptions, useActor, useMeta } from "@/app/lib/client/api";
import {
  useParties,
  usePartyNameCheck,
  type PartyExportPayload,
  type PartyRow,
} from "@/app/lib/client/api-parties";
import { useListState } from "@/app/lib/client/use-list-state";
import { fromNow } from "@/app/lib/client/format";
import { businessDateKey } from "@/shared/time/zh-cn";
import { FilterField, QueryFilter } from "@/app/components/query-filter";
import { DataTable, sortOrderOf } from "@/app/components/ui/data-table/DataTable";
import { StateBlock } from "@/app/components/ui/state-block";
import { applyServerIssues, validateAndFocusFirst } from "@/app/components/form/zod-rules";

/**
 * 对手方档案列表（F3-1，MATT-40）。
 *
 * 与案件/事项两张列表**同一套壳**（查询区卡 + 表格卡 + URL 里的列表状态），差三件事：
 *   · 排序只有两列（名称 / 更新时间）—— 当事人表没有编号、状态、等级、金额、负责人这些维度，
 *     服务端为此把 `sortBy` 收窄成两个字面量（`PARTY_SORTABLE_KEYS`），
 *     这里只给这两列 `sorter: true`。给别的列挂排序会得到 400，不是"点了没反应"；
 *   · 证件号与手机号是**明文**（IQ-12 展示层全明文，没有"显示明文"按钮）。
 *     要留痕的是**导出**：工具栏那个菜单两档，明文档要 `can_read_plain` 且整批记 `EXPORT`；
 *   · 行的旗舰动作是**打开档案**（合并、编辑都在详情页）—— 列表这一层不做合并：
 *     合并要看清两边卷入了什么，那需要详情页那两张表。
 */
export function PartiesView() {
  const router = useRouter();
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const { state, push } = useListState();
  const { data: meta } = useMeta("matter");
  const { data: actor } = useActor();
  const [creating, setCreating] = useState(false);
  const [kw, setKw] = useState(state.keyword);
  useEffect(() => setKw(state.keyword), [state.keyword]);

  const { data, isFetching, isError, error, refetch } = useParties(state);

  /**
   * 导出两档（IQ-12）。`plain` 档的**权限判定在服务端**（`requirePrivilege`），
   * 这里禁用菜单项只是省一次必然 403 的往返 —— 界面判权永远不是防线。
   */
  const exportMut = useMutation({
    mutationFn: (plain: boolean) =>
      api.get<PartyExportPayload>(
        `/api/parties?export=1${plain ? "&plain=1" : ""}${
          state.keyword ? `&keyword=${encodeURIComponent(state.keyword)}` : ""
        }`,
      ),
    onSuccess: (r) => {
      // 文件名里的日期戳：**业务日**（上海），不是 UTC 日 —— 与导出按钮同一条纪律
      const stamp = businessDateKey(new Date());
      downloadCsv(`当事人档案-${r.plain ? "明文" : "脱敏"}-${stamp}.csv`, r.csv);
      message.success(
        `已导出 ${r.count} 条${r.plain ? "（含明文证件号，已记 EXPORT 审计）" : "（证件号/手机号只留尾四位）"}${
          r.truncated ? "；命中超过上限，只导出了前 1000 条" : ""
        }`,
      );
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "导出失败"),
  });

  const columns = useMemo<TableColumnsType<PartyRow>>(
    () => [
      {
        key: "name",
        title: "名称",
        width: 208,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("name", state.sortBy, state.sortDir),
        render: (_, r) => (
          <Link
            href={`/parties/${r.id}`}
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
        width: 84,
        ellipsis: true,
        render: (_, r) => meta?.enums.partyTypes[r.type] ?? r.type,
      },
      {
        key: "id_number",
        title: "证件号",
        width: 190,
        ellipsis: true,
        // 明文列被裁时 `ellipsis` 不会自动补 title（render 包了 span），所以显式给
        // 证件号用 `.mono`（canon-spec.md:90 指定的就是它）：它是机器可读的标识，
        // 不是要参与列对齐的数字 —— `l/1`、`O/0` 那份字形差异在这里才看得出
        render: (_, r) =>
          r.idNumber ? (
            <span className="mono" title={r.idNumber} style={{ fontSize: 12 }}>
              {r.idNumber}
            </span>
          ) : (
            <span className="ph" style={{ fontSize: 12 }}>
              未登记
            </span>
          ),
      },
      {
        key: "contact",
        title: "联系方式",
        width: 132,
        ellipsis: true,
        render: (_, r) =>
          r.contact ? (
            <span className="num" title={r.contact} style={{ fontSize: 12 }}>
              {r.contact}
            </span>
          ) : (
            <span className="ph" style={{ fontSize: 12 }}>
              —
            </span>
          ),
      },
      {
        key: "matters",
        title: (
          <Tooltip title="只计你有权看到的案件；详情页会把看不见的那部分条数说出来">
            涉及案件
          </Tooltip>
        ),
        width: 84,
        align: "right",
        ellipsis: true,
        render: (_, r) => <span className="num">{r.matterCount}</span>,
      },
      {
        key: "risks",
        title: (
          <Tooltip title="只计你有权看到的事项；详情页会把看不见的那部分条数说出来">
            涉及事项
          </Tooltip>
        ),
        width: 84,
        align: "right",
        ellipsis: true,
        render: (_, r) => <span className="num">{r.riskCount}</span>,
      },
      {
        key: "updated_at",
        title: "更新",
        width: 72,
        ellipsis: true,
        sorter: true,
        sortOrder: sortOrderOf("updated_at", state.sortBy, state.sortDir),
        render: (_, r) => (
          <span className="mut3" style={{ fontSize: 12 }}>
            {fromNow(r.updatedAt)}
          </span>
        ),
      },
    ],
    [meta, state.sortBy, state.sortDir],
  );

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="当事人列表读不到"
        hint={error instanceof Error ? error.message : "未知错误"}
        action={
          <button type="button" className="btn sm" onClick={() => void refetch()}>
            重试
          </button>
        }
      />
    );
  }

  return (
    <div className="stack list">
      <QueryFilter
        onSearch={() => push({ keyword: kw.trim() })}
        onReset={() => {
          setKw("");
          push({ keyword: "" });
        }}
        busy={isFetching}
      >
        <FilterField label="关键词" htmlFor="party-keyword" width={300}>
          <Input
            id="party-keyword"
            allowClear
            value={kw}
            placeholder="名称，或完整证件号"
            onChange={(e) => setKw(e.target.value)}
            onPressEnter={() => push({ keyword: kw.trim() })}
          />
        </FilterField>
      </QueryFilter>

      <DataTable<PartyRow>
        title="当事人档案"
        tools={
          <>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "masked", label: "导出（脱敏）" },
                  {
                    key: "plain",
                    label: "导出明文",
                    // 权限判定在服务端（requirePrivilege），这里禁用只是省一次必然 403 的往返
                    disabled: !actor?.privileges.canReadPlain,
                  },
                ],
                onClick: ({ key }) => exportMut.mutate(key === "plain"),
              }}
            >
              <button type="button" className="btn sm" disabled={exportMut.isPending}>
                导出
              </button>
            </Dropdown>
            {/* 权限是一句事实，不是解释（canon-spec §07：明文导出仅全局管理可用） */}
            <span className="mut3 nowrap" style={{ fontSize: 12 }}>
              明文导出仅全局管理可用
            </span>
            <button type="button" className="btn sm" onClick={() => void refetch()}>
              刷新
            </button>
            <button type="button" className="btn pri sm" onClick={() => setCreating(true)}>
              新增当事人
            </button>
          </>
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
        onRowOpen={(r) => router.push(`/parties/${r.id}`)}
        hideable={[
          { key: "type", title: "类型" },
          { key: "contact", title: "联系方式" },
          { key: "risks", title: "涉及事项" },
        ]}
        empty={
          <StateBlock
            title={state.keyword ? "当前筛选下没有可见档案" : "还没有对手方档案"}
            hint={
              state.keyword
                ? "清掉关键词再看一次；数据范围不同，看到的条数就不同。"
                : "建案或建事项时在当事人一栏输入名称即可建档，也可以点右上「新增当事人」。"
            }
          />
        }
      />

      <PartyCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => {
          void qc.invalidateQueries({ queryKey: ["parties"] });
          router.push(`/parties/${id}`);
        }}
      />
    </div>
  );
}

/**
 * 新建对手方（F3-2：仅名称必填）。
 *
 * ## 为什么这个表单没有 `rulesFor(schema, …)`
 *
 * 那要求把 Zod schema import 进客户端，而当事人 DTO 的 schema 住在服务层
 * （本票写范围不含 `src/shared/schema`，见 `services/parties.ts` 那一节的说明）。
 * 规则因此仍然只有一份 —— **服务端那份**：提交失败时 `ApiFailure.issues` 里的
 * `path` 直接标回字段（`applyServerIssues`），用户看到的文案就是 schema 的文案。
 * 代价是"点提交才提示"，换的是"前端与后端不会各说一套"（禁令⑧ 的实质）。
 *
 * ## 两条提示都落在动作发生处
 *
 *   · 输入**本企业名** → 当场说清我方不入表（写路径上服务层也会拒，这是提示面）；
 *   · 库里已有**同名** → 说明会另建一行，并给"确认是同一家就去合并"的下一步
 *     （自动合并会稀释对手画像，US-M3-2：合并必须由人发起）。
 */
function PartyCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { data: meta } = useMeta("matter");
  const [form] = Form.useForm<Record<string, unknown>>();
  const [name, setName] = useState("");
  const check = usePartyNameCheck(name);
  const ownCompany = check.data?.ownCompany ?? false;
  /** 同名命中（检索本身就是按名称模糊匹配的，这里只要完全相等的那几条） */
  const sameName = (check.data?.items ?? []).filter((p) => p.name === name.trim());

  const mut = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api.post<{ id: string }>("/api/parties", values),
    onSuccess: (r) => {
      onOpenChange(false);
      onCreated(r.id);
    },
    onError: (e) => {
      if (e instanceof ApiFailure) applyServerIssues(form, e.issues);
    },
  });

  useEffect(() => {
    if (open) {
      form.resetFields();
      setName("");
      mut.reset();
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      title="新建对手方档案"
      okText="建档"
      confirmLoading={mut.isPending}
      onOk={async () => {
        const values = await validateAndFocusFirst(form);
        if (!values) return;
        mut.mutate(values);
      }}
    >
      <Form form={form} layout="vertical" requiredMark={false} style={{ marginTop: 8 }}>
        {mut.error ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            title={mut.error instanceof ApiFailure ? mut.error.message : "提交失败"}
            // 409（同证件号已在库）时给下一步：列表支持按**完整证件号**精确搜，
            // 搜到就能打开那一份 —— 所以这里不需要额外接口回传它的 id
            description={
              mut.error instanceof ApiFailure && mut.error.status === 409
                ? "在列表的关键词框里粘一次完整证件号就能搜到它。"
                : null
            }
          />
        ) : null}

        <Form.Item label="名称" name="name">
          <Input
            placeholder="例：南京鼎泰房地产开发有限公司"
            onChange={(e) => setName(e.target.value)}
          />
        </Form.Item>
        {ownCompany ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            title="这是本企业名称，我方不入当事人表"
            description="本企业在案件中的地位由该案的「我方诉讼地位」表达。这一栏请填对方当事人或第三人。"
          />
        ) : null}
        {!ownCompany && sameName.length > 0 ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            title={`库里已有同名档案：${sameName.map((s) => s.name).join("、")}`}
            description="同名可能是两家，所以这里会新建一行而不是自动合并；确认是同一家，建档后到详情页把它们合并。"
          />
        ) : null}

        <Form.Item label="类型" name="type" initialValue="legal_person">
          <Select options={meta ? toOptions(meta.enums.partyTypes) : []} />
        </Form.Item>
        <Form.Item label="证件类型" name="idType">
          <Select
            allowClear
            placeholder="选填"
            options={meta ? toOptions(meta.enums.idTypes) : []}
          />
        </Form.Item>
        <Form.Item label="证件号" name="idNumber" extra="加密存储；列表与详情页按明文显示">
          <Input placeholder="统一社会信用代码 / 身份证号" />
        </Form.Item>
        <Form.Item label="联系方式" name="contact" extra="加密存储">
          <Input placeholder="手机号等" />
        </Form.Item>
        <Form.Item label="备注" name="remark">
          <Input.TextArea rows={2} maxLength={2000} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

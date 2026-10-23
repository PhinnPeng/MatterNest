"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App as AntdApp,
  Button,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Table,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";

import { api, ApiFailure, toOptions, useMeta } from "@/app/lib/client/api";
import {
  useParty,
  usePartyNameCheck,
  type PartyDetailDto,
  type PartyInvolvedMatterDto,
  type PartyInvolvedRiskDto,
  type PartyMergeResult,
} from "@/app/lib/client/api-parties";
import { dateTime, fromNow } from "@/app/lib/client/format";
import { PageHeader } from "@/app/components/page-header";
import { FlagMark, StatusMark } from "@/app/components/ui/status-mark";
import { StateBlock } from "@/app/components/ui/state-block";
import { applyServerIssues } from "@/app/components/form/zod-rules";

/**
 * 对手方档案详情（F3-1 / F3-4，MATT-40）。
 *
 * 三件事按第一屏的顺序摆：
 *   1. **本体**：名称 + 类型 + 证件号/手机号（**明文**，IQ-12 展示层全明文，
 *      没有"显示明文"按钮也没有逐次审计）；
 *   2. **卷入的全部事项与案件及其中的地位**：两列并排给"我方地位 / 对方地位"，
 *      这才是"相对我方视角"——只给对方的地位，读者还得回头翻案件才知道我方是谁；
 *   3. **合并**（F3-9）：被并方显示"已并入谁"，主记录显示"并入了哪几份"。
 *      合并入口在页头，**不可撤销**那句话写在弹窗里紧挨着提交按钮。
 *
 * ## 为什么内嵌的两张表用 antd `Table` 而不是 `DataTable`
 *
 * 禁令⑧ 的表格门（`ui/data-table/DataTable.tsx`）是**列表页的卡片壳**：它自己渲染
 * `<h1>` 当页面主标题、自己管服务端分页与列设置。详情页里再放两个它，一屏就有三个 h1，
 * 读屏拿到的标题层级与视觉层级立刻分叉（`component-guidelines.md` 明写这一条）。
 * 所以详情页的内嵌表与 `matter-detail.tsx` / `risk-detail.tsx` 保持一致：
 * `SectionTitle` + antd `Table`，分页交给 antd（数据是服务端已按范围裁好的，
 * 上限 `PARTY_INVOLVED_LIMIT`）。这一条已写进交付报告请父代理裁定。
 */
export function PartyDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const { message } = AntdApp.useApp();
  const { data: meta } = useMeta("matter");
  const [editOpen, setEditOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  const { data, isPending, isError, error, refetch } = useParty(id);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["party", id] });
    qc.invalidateQueries({ queryKey: ["parties"] });
    // 合并会改别的案卷的当事人关联，所以案件/事项的列表与详情都要失效
    qc.invalidateQueries({ queryKey: ["matters"] });
    qc.invalidateQueries({ queryKey: ["matter"] });
    qc.invalidateQueries({ queryKey: ["risk-matters"] });
    qc.invalidateQueries({ queryKey: ["risk"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };

  if (isPending) {
    return <div className="card" style={{ minHeight: 320 }} />;
  }
  // 404 走"不可见或不存在"这一句措辞：服务层对两者都给 404（元规则 3），界面不许替它区分
  if (isError) {
    const denied = error instanceof ApiFailure && error.status === 404;
    return (
      <StateBlock
        layout="page"
        tone={denied ? "denied" : "error"}
        title={denied ? "打不开这份档案" : "读取出错"}
        hint={
          denied
            ? "它要么不存在，要么不在你的数据范围内 —— 这两种情况系统给的是同一个响应，不区分。"
            : error instanceof Error
              ? error.message
              : "未知错误"
        }
        action={
          denied ? (
            <Link href="/parties">
              <Button size="small">回当事人列表</Button>
            </Link>
          ) : (
            <Button size="small" onClick={() => void refetch()}>
              重试
            </Button>
          )
        }
      />
    );
  }
  if (!data) return null;

  const p = data;

  /** 详情页内嵌表：canon `.tb` + 显式列宽，分页外移（详情页只列前 10 条，超出提示） */
  const matterColumns: TableColumnsType<PartyInvolvedMatterDto> = [
    {
      key: "code",
      title: "编号",
      width: 132,
      ellipsis: true,
      render: (_, r) => (
        <Link href={`/matters/${r.id}`} className="num" style={{ fontSize: 12 }}>
          {r.internalCode}
        </Link>
      ),
    },
    {
      key: "name",
      title: "案件名称",
      ellipsis: true,
      render: (_, r) => (
        <Link href={`/matters/${r.id}`} title={r.name}>
          {r.name}
        </Link>
      ),
    },
    {
      key: "our_role",
      title: "我方地位",
      width: 96,
      ellipsis: true,
      render: (_, r) => meta?.enums.litigationRoles[r.ourLitigationRole] ?? r.ourLitigationRole,
    },
    {
      key: "party_role",
      title: "对方地位",
      width: 96,
      ellipsis: true,
      render: (_, r) => meta?.enums.litigationRoles[r.partyRole] ?? r.partyRole,
    },
    {
      key: "status",
      title: "状态",
      width: 88,
      ellipsis: true,
      render: (_, r) => <StatusMark host="matter" code={r.status} />,
    },
    {
      key: "archived",
      title: "归档",
      width: 76,
      ellipsis: true,
      render: (_, r) => (r.isArchived ? <FlagMark>已归档</FlagMark> : null),
    },
    {
      key: "updated_at",
      title: "更新",
      width: 76,
      ellipsis: true,
      render: (_, r) => (
        <span className="mut3" style={{ fontSize: 12 }}>
          {fromNow(r.updatedAt)}
        </span>
      ),
    },
  ];

  const riskColumns: TableColumnsType<PartyInvolvedRiskDto> = [
    {
      key: "code",
      title: "编号",
      width: 132,
      ellipsis: true,
      render: (_, r) => (
        <Link href={`/risk-matters/${r.id}`} className="num" style={{ fontSize: 12 }}>
          {r.code}
        </Link>
      ),
    },
    {
      key: "name",
      title: "事项名称",
      ellipsis: true,
      render: (_, r) => (
        <Link href={`/risk-matters/${r.id}`} title={r.name}>
          {r.name}
        </Link>
      ),
    },
    {
      key: "party_role",
      title: "对方地位",
      width: 96,
      ellipsis: true,
      render: (_, r) => meta?.enums.litigationRoles[r.partyRole] ?? r.partyRole,
    },
    {
      key: "status",
      title: "状态",
      width: 88,
      ellipsis: true,
      render: (_, r) => <StatusMark host="risk_matter" code={r.status} />,
    },
    {
      key: "archived",
      title: "归档",
      width: 76,
      ellipsis: true,
      render: (_, r) => (r.isArchived ? <FlagMark>已归档</FlagMark> : null),
    },
    {
      key: "updated_at",
      title: "更新",
      width: 76,
      ellipsis: true,
      render: (_, r) => (
        <span className="mut3" style={{ fontSize: 12 }}>
          {fromNow(r.updatedAt)}
        </span>
      ),
    },
  ];

  return (
    <div className="stack">
      <PageHeader
        title={p.name}
        flags={
          p.mergedIn.length > 0 ? (
            <FlagMark tone="info" title={`并入了 ${p.mergedIn.length} 份重复档案`}>
              并入了 {p.mergedIn.length} 份
            </FlagMark>
          ) : null
        }
        actions={
          <>
            <button type="button" className="btn" onClick={() => setEditOpen(true)}>
              编辑
            </button>
            <button type="button" className="btn danger" onClick={() => setMergeOpen(true)}>
              合并重复档案
            </button>
          </>
        }
      />

      <div className="card">
        <div className="card-h">
          <h2>登记信息</h2>
        </div>
        <div className="card-b">
          <dl className="dl">
            <dt>类型</dt>
            <dd>{meta?.enums.partyTypes[p.type] ?? p.type}</dd>
            <dt>证件类型</dt>
            <dd>
              {p.idType ? (
                (meta?.enums.idTypes[p.idType] ?? p.idType)
              ) : (
                <span className="ph">—</span>
              )}
            </dd>
            <dt>证件号</dt>
            <dd>
              {p.idNumber ? (
                // 与列表页同一字段同一字形：`.mono`（canon-spec:90 指定的就是它）。
                // 证件号是机器可读的标识而不是参与列对齐的数字 —— 两处各用一套，
                // 同一份号在列表中与详情里字形不同。
                <span className="mono">{p.idNumber}</span>
              ) : (
                <span className="ph">—</span>
              )}
            </dd>
            <dt>联系方式</dt>
            <dd>
              {p.contact ? <span className="num">{p.contact}</span> : <span className="ph">—</span>}
            </dd>
            <dt>登记人</dt>
            <dd>{p.createdByName ?? <span className="ph">—</span>}</dd>
            <dt>登记时间</dt>
            <dd className="num">{dateTime(p.createdAt)}</dd>
            <dt>更新时间</dt>
            <dd className="num">{dateTime(p.updatedAt)}</dd>
            <dt>备注</dt>
            <dd className="span2">{p.remark ?? <span className="ph">—</span>}</dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>涉及案件</h2>
          <span className="num mut3" style={{ fontSize: 12 }}>
            {p.matters.length}
          </span>
        </div>
        <div className="card-b" style={{ padding: 0 }}>
          {/* 权限提示：库里有、但范围看不到的那部分必须说出来（§7.2） */}
          {p.hidden.matters > 0 || p.truncated.matters ? (
            <div className="tool" style={{ background: "var(--accent-weak)" }}>
              部分结果因权限未显示
              {p.hidden.matters > 0 ? `：另有 ${p.hidden.matters} 个案件不在你的数据范围内` : ""}
            </div>
          ) : null}
          <Table<PartyInvolvedMatterDto>
            size="small"
            rowKey={(r) => r.id}
            columns={matterColumns}
            dataSource={p.matters}
            pagination={{ pageSize: 10, size: "small", hideOnSinglePage: true }}
            locale={{
              emptyText: (
                <span className="mut" style={{ fontSize: 12 }}>
                  这份档案还没有关联任何案件。建案时在「当事人」一栏选它即可挂上。
                </span>
              ),
            }}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>涉及事项</h2>
          <span className="num mut3" style={{ fontSize: 12 }}>
            {p.risks.length}
          </span>
        </div>
        <div className="card-b" style={{ padding: 0 }}>
          {p.hidden.risks > 0 || p.truncated.risks ? (
            <div className="tool" style={{ background: "var(--accent-weak)" }}>
              部分结果因权限未显示
              {p.hidden.risks > 0 ? `：另有 ${p.hidden.risks} 条事项不在你的数据范围内` : ""}
            </div>
          ) : null}
          <Table<PartyInvolvedRiskDto>
            size="small"
            rowKey={(r) => r.id}
            columns={riskColumns}
            dataSource={p.risks}
            pagination={{ pageSize: 10, size: "small", hideOnSinglePage: true }}
            locale={{
              emptyText: (
                <span className="mut" style={{ fontSize: 12 }}>
                  这份档案还没有关联任何事项。建事项或转案件时选它即可挂上。
                </span>
              ),
            }}
          />
        </div>
      </div>

      {p.mergedIn.length > 0 ? (
        <div className="card">
          <div className="card-h">
            <h2>已并入本档案</h2>
            <span className="num mut3" style={{ fontSize: 12 }}>
              {p.mergedIn.length}
            </span>
          </div>
          <div className="card-b">
            {/* 名字**不做链接**：被并方是软删行，接口对它给 404（B8「仅软删、无回收站 UI」），
                链过去只会得到一个"看不到这份档案"。去向在这一行文字里已经说完了。 */}
            <ul className="tl">
              {p.mergedIn.map((m) => (
                <li key={m.id}>
                  <div>{m.name}</div>
                  <div className="mut3 num" style={{ fontSize: 12 }}>
                    {dateTime(m.mergedAt)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <PartyEditDialog
        party={p}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={() => {
          message.success("已保存");
          invalidate();
        }}
      />
      <PartyMergeDialog
        party={p}
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        onMerged={(r) => {
          message.success(
            `已合并 ${r.mergedIds.length} 份档案：改挂 ${r.moved} 条关联${
              r.dropped > 0 ? `，丢掉 ${r.dropped} 条重复关联` : ""
            }`,
          );
          invalidate();
          router.push(`/parties/${r.survivingId}`);
        }}
      />
    </div>
  );
}

/** 编辑：与新建同一套值域（服务端 `partyUpdateSchema`），字段错误由服务端 issues 标回 */
function PartyEditDialog({
  party,
  open,
  onOpenChange,
  onSaved,
}: {
  party: PartyDetailDto;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const { data: meta } = useMeta("matter");
  const [form] = Form.useForm<Record<string, unknown>>();
  const mut = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.patch(`/api/parties/${party.id}`, values),
    onSuccess: () => {
      onOpenChange(false);
      onSaved();
    },
    onError: (e) => {
      if (e instanceof ApiFailure) applyServerIssues(form, e.issues);
    },
  });

  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      title="编辑档案"
      okText="保存"
      confirmLoading={mut.isPending}
      onOk={() => {
        void form
          .validateFields()
          .then((v) => mut.mutate(v))
          .catch(() => undefined);
      }}
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        style={{ marginTop: 8 }}
        initialValues={{
          name: party.name,
          type: party.type,
          idType: party.idType ?? undefined,
          idNumber: party.idNumber ?? "",
          contact: party.contact ?? "",
          remark: party.remark ?? "",
        }}
      >
        {mut.error ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            title={mut.error instanceof ApiFailure ? mut.error.message : "保存失败"}
          />
        ) : null}
        <Form.Item label="名称" name="name">
          <Input />
        </Form.Item>
        <Form.Item label="类型" name="type">
          <Select options={meta ? toOptions(meta.enums.partyTypes) : []} />
        </Form.Item>
        <Form.Item label="证件类型" name="idType">
          <Select
            allowClear
            placeholder="选填"
            options={meta ? toOptions(meta.enums.idTypes) : []}
          />
        </Form.Item>
        <Form.Item label="证件号" name="idNumber">
          <Input />
        </Form.Item>
        <Form.Item label="联系方式" name="contact">
          <Input />
        </Form.Item>
        <Form.Item label="备注" name="remark">
          <Input.TextArea rows={2} maxLength={2000} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/**
 * 合并（F3-9）。两个方向共用一个弹窗：
 *   · **并入本档案**（默认）：选若干份被并方 —— 把重复的并到当前这份；
 *   · **本档案并入别的档案**：选一份主记录 —— 当前这份是被并方。
 *
 * 目标档案靠**名称/完整证件号检索**（与列表、建案下拉同一个接口与同一套可见性）：
 * 一份下拉不可能列出全部档案（§4.1 拒绝批量列举），而"我要并的是哪一份"
 * 恰恰需要按证件号精确找。
 */
function PartyMergeDialog({
  party,
  open,
  onOpenChange,
  onMerged,
}: {
  party: PartyDetailDto;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onMerged: (r: PartyMergeResult) => void;
}) {
  const [kw, setKw] = useState("");
  const check = usePartyNameCheck(kw);
  const [dir, setDir] = useState<"into" | "out">("into");
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState("");

  const options = (check.data?.items ?? [])
    .filter((x) => x.id !== party.id)
    .map((x) => ({
      value: x.id,
      label: `${x.name}${x.idNumberTail ? ` · 尾号 ${x.idNumberTail}` : ""}`,
    }));

  const mut = useMutation({
    mutationFn: () => {
      const survivorId = dir === "into" ? party.id : (picked[0] ?? "");
      const mergedIds = dir === "into" ? picked : [party.id];
      return api.post<PartyMergeResult>(`/api/parties/${survivorId}/merge`, {
        mergedIds,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
    },
    onSuccess: (r) => {
      onOpenChange(false);
      setPicked([]);
      setReason("");
      setKw("");
      onMerged(r);
    },
  });

  const canSubmit = dir === "into" ? picked.length > 0 : picked.length === 1;

  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      title="合并重复档案"
      okText="合并"
      okButtonProps={{ danger: true, disabled: !canSubmit }}
      confirmLoading={mut.isPending}
      onOk={() => mut.mutate()}
    >
      {mut.error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          title={mut.error instanceof ApiFailure ? mut.error.message : "合并失败"}
        />
      ) : null}

      <Radio.Group
        value={dir}
        onChange={(e) => {
          setDir(e.target.value as "into" | "out");
          setPicked([]);
        }}
        style={{ marginBottom: 12 }}
      >
        <Radio.Button value="into">别的档案并进本档案</Radio.Button>
        <Radio.Button value="out">本档案并进别的档案</Radio.Button>
      </Radio.Group>

      <div style={{ marginBottom: 8 }}>
        <Input
          allowClear
          placeholder="按名称或完整证件号检索目标档案"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
      </div>
      <Select
        mode={dir === "into" ? "multiple" : undefined}
        style={{ width: "100%" }}
        placeholder={dir === "into" ? "选择要并入的档案（可多选）" : "选择要并入到哪一份档案"}
        value={dir === "into" ? picked : (picked[0] ?? undefined)}
        options={options}
        notFoundContent={
          <Typography.Text style={{ fontSize: 12 }}>
            {kw.trim() ? "没有匹配的可见档案" : "先输入名称或完整证件号"}
          </Typography.Text>
        }
        onChange={(v) => setPicked(Array.isArray(v) ? v : v ? [String(v)] : [])}
      />
      <div style={{ marginTop: 8 }}>
        <Input.TextArea
          rows={2}
          maxLength={500}
          placeholder="说明（可选，记进审计）"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      {/* 这句紧挨着提交按钮：合并是**不可撤销**的（一期没有反合并），
          不能只写在文档里或者藏在弹窗顶部的小字里 */}
      <Alert
        type="warning"
        showIcon
        style={{ marginTop: 12 }}
        title="合并不可撤销"
        description={`被并方会被软删，它名下的案件与事项全部改挂到主记录；同一案卷上重复的那条关联会被丢掉。${
          dir === "into" ? `主记录：${party.name}` : "主记录：上面选中的那一份"
        }`}
      />
    </Modal>
  );
}

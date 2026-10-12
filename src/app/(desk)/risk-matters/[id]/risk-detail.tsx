"use client";

import { INK } from "@/app/theme/brand";
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App as AntdApp,
  Avatar,
  Button,
  Card,
  Collapse,
  Col,
  DatePicker,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Tag,
  Timeline,
  Typography,
} from "antd";
import { ArrowLeftOutlined, PlusOutlined } from "@ant-design/icons";
import type { Dayjs } from "dayjs";

import { api, ApiFailure, type RiskDetail as Risk } from "@/app/lib/client/api";
import { calDate, dateTime, fromNow, money } from "@/app/lib/client/format";
import { PageHeader, MetaItem, SectionTitle } from "@/app/components/page-header";
import { StatusMark, FlagMark, MetaLine } from "@/app/components/ui/status-mark";
import { StateBlock } from "@/app/components/ui/state-block";
import { StatusDialog, type StatusTarget } from "@/app/components/status-dialog";
import { NODE_STATUS_LABELS, LITIGATION_ROLE_LABELS } from "@/shared/enums/business";

/**
 * 风险事项详情（T1）。
 *
 * 布局按 **IQ-17**：左侧一等高「事项节点」栏，右侧单栏流式——标题卡 →
 * 折叠区（风险描述 / 处置措施 / 当事人 / 参与人 / 登记信息）→ 处置记录（最新在最上）。
 * **无 Tab**（F7-6 的「六 Tab」被 IQ-7 作废）。
 *
 * 三条与案件侧**刻意不同**的地方（IQ-5「事项是台账，案件是战场」），不是抄漏：
 *   · 节点栏允许为空，并给一个「手动加节点」的入口 —— 事项侧无预设节点
 *   · 节点只有时间点，**不出现时间段控件**；未确认时间用"待定"而不是留空
 *   · 经办人可空，空时显示「未指派处理人」并给「变更处理人」按钮
 *
 * 写成功一律失效 `["risk", id]` / `["risk-matters"]` / `["overview"]`：
 * 详情页要立刻看到，回列表与工作台也要看见。
 */
export function RiskDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { message } = AntdApp.useApp();
  const [statusOpen, setStatusOpen] = useState(false);
  const [nodeOpen, setNodeOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["risk", id],
    queryFn: () => api.get<Risk>(`/api/risk-matters/${id}`),
  });
  // 节点类型是配置驱动，从 meta 读；事项侧**只取 time_type='point'** 那些
  const { data: meta } = useQuery({
    queryKey: ["node-types", "risk_matter"],
    queryFn: () =>
      api.get<{ nodeTypes: { id: string; code: string; name: string }[] }>(
        "/api/meta?host=risk_matter",
      ),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["risk", id] });
    qc.invalidateQueries({ queryKey: ["risk-matters"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };

  const softDelete = useMutation({
    mutationFn: () => api.del(`/api/risk-matters/${id}`),
    onSuccess: () => {
      message.success("已软删。库里仍可恢复，但界面上没有回收站。");
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "删除失败"),
  });

  if (isPending) {
    return <Card size="small" loading style={{ maxWidth: 1180, margin: "0 auto" }} />;
  }
  // 404 走"不可见或不存在"这一句措辞，不写"事项不存在"——服务层对两者都给 404
  if (isError) {
    return (
      <Card size="small" style={{ maxWidth: 640, margin: "40px auto" }}>
        <StateBlock
          title="看不到这条事项"
          hint={
            error instanceof ApiFailure && error.status === 404
              ? "它不存在，或你没有查看它的权限。"
              : "加载失败，请重试。"
          }
        />
      </Card>
    );
  }
  if (!data) return null;

  const risk = data;
  const statusTarget: StatusTarget | null = {
    id: risk.id,
    code: risk.code,
    name: risk.name,
    status: risk.status,
  };
  const pointTypes = meta?.nodeTypes ?? [];

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      <PageHeader
        eyebrow={
          <Link href="/risk-matters">
            <ArrowLeftOutlined /> 返回事项列表
          </Link>
        }
        title={risk.name}
        meta={
          <>
            <MetaItem label="编号">
              <span className="num">{risk.code}</span>
            </MetaItem>
            <MetaItem label="状态">
              <StatusMark host="risk_matter" code={risk.status} />
            </MetaItem>
            <MetaItem label="风险类型">
              <FlagMark>{risk.type}</FlagMark>
            </MetaItem>
            <MetaItem label="等级">
              <FlagMark tone={risk.level === "high" ? "danger" : "neutral"}>{risk.level}</FlagMark>
            </MetaItem>
            {/* 「已转案件」是与结案正交的**第二个事实**，所以是徽标而不是第五个状态 */}
            {risk.conversionStatus === 1 && (
              <MetaItem label="已转案件">
                <Tag color="blue">已转 {risk.convertedCaseCount} 个案件</Tag>
              </MetaItem>
            )}
            <MetaItem label="更新">{fromNow(risk.updatedAt)}</MetaItem>
          </>
        }
      />

      {/* IQ-17：左栏一等高；右栏单栏流式，无 Tab */}
      <Row gutter={16} align="stretch">
        <Col xs={24} lg={9} style={{ display: "flex" }}>
          <Card
            size="small"
            title={<SectionTitle count={risk.nodes.length}>事项节点</SectionTitle>}
            extra={
              risk.isArchived ? null : (
                <Button size="small" icon={<PlusOutlined />} onClick={() => setNodeOpen(true)}>
                  手动添加
                </Button>
              )
            }
            style={{ width: "100%", display: "flex", flexDirection: "column" }}
          >
            {risk.nodes.length === 0 ? (
              <StateBlock
                title="还没有节点"
                // 说清为什么是空的：事项侧不预设节点（IQ-5），节点只在确有时限时手动加
                hint="事项不预置节点。只有确有时限时才手动加一个时间点。"
                action={
                  risk.isArchived ? undefined : (
                    <Button size="small" onClick={() => setNodeOpen(true)}>
                      加第一个节点
                    </Button>
                  )
                }
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {risk.nodes.map((n) => (
                  <NodeRow key={n.id} node={n} readOnly={risk.isArchived} onDone={invalidate} />
                ))}
              </div>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={15}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {/* 归档是只读终态：整页只保留一个"看"，不给任何写入口 */}
            {risk.isArchived && (
              <Card size="small" style={{ background: INK.line }}>
                <Typography.Text type="secondary">
                  这条事项已归档（{calDate(risk.archivedAt)}
                  ），是只读终态。要改内容需先由持「撤销归档」权限的人撤销归档。
                </Typography.Text>
              </Card>
            )}

            <Card size="small" title="标题与归属">
              <Space direction="vertical" size={10} style={{ width: "100%" }}>
                <MetaLine label="经办人">
                  {risk.ownerId ? (
                    <Space size={6}>
                      <Avatar size="small">{risk.ownerName?.[0] ?? "?"}</Avatar>
                      <span>{risk.ownerName}</span>
                    </Space>
                  ) : (
                    <FlagMark tone="warn">未指派处理人</FlagMark>
                  )}
                  {/* 变更处理人是普通字段编辑，不进独立流程（GLOSSARY） */}
                  {!risk.isArchived && (
                    <Button size="small" type="link" onClick={() => setOwnerOpen(true)}>
                      变更处理人
                    </Button>
                  )}
                </MetaLine>
                <MetaLine label="发现日期">{calDate(risk.discoverDate)}</MetaLine>
                <MetaLine label="敞口金额">{money(risk.amount)}</MetaLine>
              </Space>
            </Card>

            {/* IQ-17：折叠区默认收起 */}
            <Collapse
              ghost
              items={[
                {
                  key: "detail",
                  label: <SectionTitle>展开风险描述、处置措施、当事人与登记信息</SectionTitle>,
                  children: (
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      <DetailBlock title="风险描述">{risk.description || <Dash />}</DetailBlock>
                      <DetailBlock title="处置措施">{risk.measure || <Dash />}</DetailBlock>
                      <DetailBlock title="当事人">
                        {risk.parties.length === 0 ? (
                          <Dash hint="没有当事人时无法转案件——转案件要求每案至少 1 个当事人。" />
                        ) : (
                          <Space direction="vertical" size={6} style={{ width: "100%" }}>
                            {risk.parties.map((p) => (
                              <Space key={p.id} size={8}>
                                <span>{p.name}</span>
                                <Tag>
                                  {LITIGATION_ROLE_LABELS[
                                    p.partyRole as keyof typeof LITIGATION_ROLE_LABELS
                                  ] ?? p.partyRole}
                                </Tag>
                              </Space>
                            ))}
                          </Space>
                        )}
                      </DetailBlock>
                      <DetailBlock title="参与人">
                        <Space size={8} wrap>
                          {risk.staff.length === 0 && <Dash />}
                          {risk.staff.map((s) => (
                            <Tag key={s.id}>
                              {s.name}·
                              {s.staffRole === "owner"
                                ? "经办"
                                : s.staffRole === "co_owner"
                                  ? "协办"
                                  : "关注"}
                            </Tag>
                          ))}
                        </Space>
                      </DetailBlock>
                      <DetailBlock title="登记信息">
                        <Space direction="vertical" size={4}>
                          <MetaLine label="创建">{dateTime(risk.createdAt)}</MetaLine>
                          <MetaLine label="更新">{dateTime(risk.updatedAt)}</MetaLine>
                          {risk.convertedAt && (
                            <MetaLine label="首次转案件">{dateTime(risk.convertedAt)}</MetaLine>
                          )}
                        </Space>
                      </DetailBlock>
                    </Space>
                  ),
                },
              ]}
            />

            {/* 事项独有的块：已转案件反查 */}
            {risk.convertedCases.length > 0 && (
              <Card
                size="small"
                title={<SectionTitle count={risk.convertedCases.length}>已转案件</SectionTitle>}
              >
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  {risk.convertedCases.map((c) => (
                    <Space key={c.id} size={8} align="baseline">
                      <Link href={`/matters/${c.id}`} className="num">
                        {c.internalCode}
                      </Link>
                      <span>{c.name}</span>
                      <StatusMark host="matter" code={c.status} />
                    </Space>
                  ))}
                </Space>
              </Card>
            )}

            {/* IQ-17：处置记录在底部，最新在最上（评论已是倒序取，直接渲染） */}
            <Card
              size="small"
              title={<SectionTitle count={risk.comments.length}>处置记录</SectionTitle>}
            >
              <CommentList risk={risk} readOnly={risk.isArchived} onDone={invalidate} />
            </Card>

            <Card
              size="small"
              title={<SectionTitle count={risk.activity.length}>活动流</SectionTitle>}
            >
              {risk.activity.length === 0 ? (
                <Dash />
              ) : (
                <Timeline
                  items={risk.activity.slice(0, 20).map((a) => ({
                    children: (
                      <Space direction="vertical" size={0}>
                        <span>{a.action}</span>
                        <span style={{ color: INK.faint, fontSize: 12 }}>
                          {dateTime(a.createdAt)}
                        </span>
                      </Space>
                    ),
                  }))}
                />
              )}
            </Card>

            {!risk.isArchived && (
              <Space size={8} wrap>
                <Button type="primary" onClick={() => setStatusOpen(true)}>
                  变更状态
                </Button>
                <Popconfirm
                  title="软删这条事项？"
                  description="库内仍可恢复，但界面上没有回收站。普通用户看不到已删行。"
                  okText="软删"
                  cancelText="取消"
                  onConfirm={() => softDelete.mutate()}
                >
                  <Button danger loading={softDelete.isPending}>
                    软删
                  </Button>
                </Popconfirm>
              </Space>
            )}
          </Space>
        </Col>
      </Row>

      <StatusDialog
        target={statusTarget}
        statuses={risk.statuses}
        open={statusOpen}
        onOpenChange={setStatusOpen}
        onDone={invalidate}
      />
      <NodeDialog
        open={nodeOpen}
        onClose={() => setNodeOpen(false)}
        types={pointTypes}
        onDone={invalidate}
        riskId={risk.id}
      />
      <OwnerDialog
        open={ownerOpen}
        onClose={() => setOwnerOpen(false)}
        current={risk.ownerId}
        onDone={invalidate}
        riskId={risk.id}
      />
    </div>
  );
}

/** 一个节点：时间点 + 状态。时间未确认时显式写"待定"，不靠留白表达。 */
function NodeRow({
  node,
  readOnly,
  onDone,
}: {
  node: Risk["nodes"][number];
  readOnly: boolean;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const mut = useMutation({
    mutationFn: (status: string) =>
      api.patch(`/api/risk-matters/${node.id}/nodes?nodeId=${node.id}`, { status }),
    onSuccess: onDone,
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "操作失败"),
  });
  const label = NODE_STATUS_LABELS[node.status as keyof typeof NODE_STATUS_LABELS] ?? node.status;
  return (
    <Card size="small" styles={{ body: { padding: 10 } }}>
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        <Space size={8} align="baseline">
          <Typography.Text strong>{node.name}</Typography.Text>
          <Tag
            color={
              node.status === "completed"
                ? "green"
                : node.status === "cancelled"
                  ? "default"
                  : "blue"
            }
          >
            {label}
          </Tag>
        </Space>
        <span style={{ color: INK.muted, fontSize: 12 }}>
          {/* 事项节点只有时间点：没有「起止」，也就没有「这段时间内」这种表达 */}
          {node.startTime ? calDate(node.startTime) : "时间待定"}
          {!node.isTimeConfirmed && node.startTime && " · 未确认"}
        </span>
        {node.cancelReason && (
          <span style={{ color: INK.faint, fontSize: 12 }}>取消原因：{node.cancelReason}</span>
        )}
        {!readOnly && (
          <Space size={4} wrap>
            {node.status === "not_started" && (
              <Button
                size="small"
                type="link"
                loading={mut.isPending}
                onClick={() => mut.mutate("in_progress")}
              >
                开始
              </Button>
            )}
            {node.status !== "completed" && node.status !== "cancelled" && (
              <Button
                size="small"
                type="link"
                loading={mut.isPending}
                onClick={() => mut.mutate("completed")}
              >
                完成
              </Button>
            )}
          </Space>
        )}
      </Space>
    </Card>
  );
}

/** 处置记录：最新在最上；作者本人可编辑，改完显示「（已编辑）」 */
function CommentList({
  risk,
  readOnly,
  onDone,
}: {
  risk: Risk;
  readOnly: boolean;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const post = useMutation({
    mutationFn: () => api.post(`/api/risk-matters/${risk.id}/comments`, { body }),
    onSuccess: () => {
      setBody("");
      message.success("已记入处置记录");
      onDone();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "发送失败"),
  });
  const edit = useMutation({
    mutationFn: (vars: { id: string; text: string }) =>
      api.patch(`/api/risk-matters/${risk.id}/comments?commentId=${vars.id}`, { body: vars.text }),
    onSuccess: () => {
      setEditing(null);
      onDone();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "编辑失败"),
  });

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {!readOnly && (
        <Space.Compact style={{ width: "100%" }}>
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder="记一条处置：核查结论、已做的动作、需要别人接的事"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <Button
            type="primary"
            loading={post.isPending}
            disabled={!body.trim()}
            onClick={() => post.mutate()}
          >
            记录
          </Button>
        </Space.Compact>
      )}
      {risk.comments.length === 0 ? (
        <Dash hint="事项的核查走处置记录，不靠进展——所以这里可能是空的。" />
      ) : (
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          {risk.comments.map((c) => (
            <Card key={c.id} size="small" styles={{ body: { padding: 10 } }}>
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <Space size={8} align="baseline">
                  <Typography.Text strong>{c.authorName}</Typography.Text>
                  <span style={{ color: INK.faint, fontSize: 12 }}>{fromNow(c.createdAt)}</span>
                  {c.isEdited && <span style={{ color: INK.faint, fontSize: 12 }}>（已编辑）</span>}
                </Space>
                {editing === c.id ? (
                  <Space direction="vertical" size={6} style={{ width: "100%" }}>
                    <Input.TextArea
                      autoSize={{ minRows: 2, maxRows: 6 }}
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                    />
                    <Space size={6}>
                      <Button
                        size="small"
                        type="primary"
                        loading={edit.isPending}
                        disabled={!editText.trim()}
                        onClick={() => edit.mutate({ id: c.id, text: editText })}
                      >
                        保存
                      </Button>
                      <Button size="small" onClick={() => setEditing(null)}>
                        取消
                      </Button>
                    </Space>
                  </Space>
                ) : (
                  <>
                    <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                      {c.body}
                    </Typography.Paragraph>
                    {!readOnly && (
                      <Button
                        size="small"
                        type="link"
                        onClick={() => {
                          setEditing(c.id);
                          setEditText(c.body);
                        }}
                      >
                        编辑
                      </Button>
                    )}
                  </>
                )}
              </Space>
            </Card>
          ))}
        </Space>
      )}
    </Space>
  );
}

/** 手动加节点：只有时间点，**没有时间段控件**（IQ-5 / T1 验收标准原文） */
function NodeDialog({
  open,
  onClose,
  types,
  onDone,
  riskId,
}: {
  open: boolean;
  onClose: () => void;
  types: { id: string; code: string; name: string }[];
  onDone: () => void;
  riskId: string;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ nodeTypeId: string; name?: string; startTime?: Dayjs }>();
  const mut = useMutation({
    mutationFn: (v: { nodeTypeId: string; name?: string; startTime?: string }) =>
      api.post<{ id: string }>(`/api/risk-matters/${riskId}/nodes`, v),
    onSuccess: () => {
      form.resetFields();
      onClose();
      message.success("已添加节点");
      onDone();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "添加失败"),
  });
  return (
    <Modal
      open={open}
      title="添加事项节点"
      onCancel={onClose}
      okText="添加"
      confirmLoading={mut.isPending}
      // 服务层还会按节点类型的 time_type 再拒一次，前端不给控件不等于拦得住手写请求
      onOk={() =>
        form
          .validateFields()
          .then((v) =>
            mut.mutate({
              nodeTypeId: v.nodeTypeId,
              name: v.name,
              startTime: v.startTime ? v.startTime.format("YYYY-MM-DD") : undefined,
            }),
          )
          .catch(() => undefined)
      }
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Form.Item
          name="nodeTypeId"
          label="节点类型"
          rules={[{ required: true, message: "请选择节点类型" }]}
        >
          <Select
            placeholder="选择节点类型"
            options={types.map((t) => ({ value: t.id, label: t.name }))}
            // 事项节点只有时间点，类型下拉里也只给 point 那些（meta 已过滤）
          />
        </Form.Item>
        <Form.Item name="name" label="节点名称" extra="留空则用节点类型的默认名">
          <Input maxLength={128} placeholder="例如：等对方书面回复" />
        </Form.Item>
        <Form.Item
          name="startTime"
          label="时间点"
          extra="可以留空，之后再定。事项节点不支持时间段。"
        >
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 变更处理人：普通字段编辑，不是独立流程（GLOSSARY 明写） */
function OwnerDialog({
  open,
  onClose,
  current,
  onDone,
  riskId,
}: {
  open: boolean;
  onClose: () => void;
  current: string | null;
  onDone: () => void;
  riskId: string;
}) {
  const { message } = AntdApp.useApp();
  const { data: meta } = useQuery({
    queryKey: ["users"],
    queryFn: () =>
      api.get<{ users: { id: string; displayName: string }[] }>("/api/meta?host=matter"),
  });
  const [value, setValue] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (v: string | null) => api.patch(`/api/risk-matters/${riskId}`, { ownerId: v }),
    onSuccess: (_d, v) => {
      onClose();
      message.success(v === null ? "已退回未指派处理人" : "已变更处理人");
      onDone();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "变更失败"),
  });

  return (
    <Modal
      open={open}
      title="变更处理人"
      onCancel={onClose}
      okText="保存"
      confirmLoading={mut.isPending}
      onOk={() => mut.mutate(value === undefined ? current : value)}
    >
      <Space direction="vertical" size={10} style={{ width: "100%", marginTop: 12 }}>
        <Typography.Text type="secondary">
          这是一次普通字段编辑：不新增状态、不进独立流程。选「退回未指派」会把这条事项放回待处理池。
        </Typography.Text>
        <Select
          style={{ width: "100%" }}
          allowClear
          placeholder="选择经办人"
          value={value === undefined ? current : value}
          onChange={(v) => setValue(v ?? null)}
          options={(meta?.users ?? []).map((u) => ({ value: u.id, label: u.displayName }))}
        />
      </Space>
    </Modal>
  );
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ color: INK.muted, fontSize: 12, marginBottom: 4 }}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

function Dash({ hint }: { hint?: string }) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={hint ?? "—"}
      styles={{ image: { height: 28 } }}
      style={{ margin: "8px 0" }}
    />
  );
}

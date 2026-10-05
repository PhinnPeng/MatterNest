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
  Descriptions,
  Empty,
  Flex,
  Input,
  List,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";

import { api, ApiFailure, useMeta, type MatterDetail as Matter } from "@/app/lib/client/api";
import { calDate, dateTime, fromNow, money } from "@/app/lib/client/format";
import { PageHeader, MetaItem } from "@/app/components/page-header";
import { StatusMark, FlagMark } from "@/app/components/ui/status-mark";
import { DeadlineMark } from "@/app/components/ui/deadline-mark";
import { StateBlock } from "@/app/components/ui/state-block";
import { StatusDialog, type StatusTarget } from "@/app/components/status-dialog";

/**
 * 案件详情。
 *
 * 三条实现约束没随换库变：
 *   · 404 走"不可见或不存在"这一句措辞，不写"案件不存在"——服务层对两者都给 404
 *     （权限草案 §1 元规则 3），文案不能把这个区别说漏；
 *   · 状态/节点/评论写成功后一起失效 `["matter", id]` 与 `["matters"]` 与 `["overview"]`：
 *     详情页要立刻看到新状态，回列表和工作台也要看见；
 *   · 取消节点必须填原因，这条在**服务层与 DB CHECK 各有一道**
 *     （`ck_mn_matter_node_cancel_reason`），前端只是提前拦一次。
 */
type Node = Matter["nodes"][number];

export function MatterDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { message } = AntdApp.useApp();
  const { data: meta } = useMeta("matter");
  const [statusOpen, setStatusOpen] = useState(false);

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["matter", id],
    queryFn: () => api.get<Matter>(`/api/matters/${id}`),
  });

  if (isPending) {
    return <Card size="small" loading style={{ maxWidth: 1180, margin: "0 auto" }} />;
  }

  if (isError) {
    const denied = error instanceof ApiFailure && error.status === 404;
    return (
      <StateBlock
        tone={denied ? "denied" : "error"}
        title={denied ? "这条案件打不开" : "读取出错"}
        hint={
          denied
            ? "它要么不存在，要么不在你的数据范围内 —— 这两种情况系统给的是同一个响应，不区分。"
            : error instanceof Error
              ? error.message
              : "未知错误"
        }
        action={
          <Link href="/matters">
            <Button size="small" icon={<ArrowLeftOutlined />}>
              回案件列表
            </Button>
          </Link>
        }
      />
    );
  }

  const m = data;
  const level = meta?.levels.find((l) => l.code === m.level)?.name ?? m.level;
  const target: StatusTarget = { id: m.id, code: m.internalCode, name: m.name, status: m.status };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["matter", m.id] });
    qc.invalidateQueries({ queryKey: ["matters"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };

  const nodeColumns: TableColumnsType<Node> = [
    {
      title: "节点",
      dataIndex: "name",
      width: 280,
      render: (_, n) => (
        <>
          <div style={{ fontSize: 13 }}>{n.name}</div>
          {n.remark ? <div style={{ fontSize: 11, color: INK.muted }}>{n.remark}</div> : null}
        </>
      ),
    },
    {
      title: "类型",
      dataIndex: "nodeType",
      width: 96,
      render: (v: string) => <span style={{ fontSize: 12, color: INK.secondary }}>{v}</span>,
    },
    {
      title: "时间",
      width: 224,
      render: (_, n) =>
        n.isTimeConfirmed ? (
          <span className="num" style={{ fontSize: 12 }}>
            {dateTime(n.startTime)}
            {n.timeType === "range" ? ` → ${dateTime(n.endTime)}` : ""}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: INK.muted }}>时间未确认</span>
        ),
    },
    {
      title: "到期",
      width: 118,
      render: (_, n) =>
        n.status === "not_started" || n.status === "in_progress" ? (
          <DeadlineMark iso={n.deadlineTime} />
        ) : (
          <span style={{ color: INK.faint }}>—</span>
        ),
    },
    {
      title: "负责人",
      width: 104,
      render: (_, n) => <span style={{ fontSize: 12 }}>{n.ownerName ?? "—"}</span>,
    },
    {
      title: "状态",
      width: 104,
      render: (_, n) => (
        <Space size={4}>
          <span
            style={{
              fontSize: 12,
              color: n.status === "cancelled" ? INK.faint : undefined,
              textDecoration: n.status === "cancelled" ? "line-through" : undefined,
            }}
          >
            {meta?.enums.nodeStatuses[n.status] ?? n.status}
          </span>
          {n.sourceKind !== "manual" ? (
            <Tag
              variant="filled"
              title={`来源：${n.sourceKind}`}
              style={{ fontSize: 11, marginInlineEnd: 0 }}
            >
              {meta?.enums.nodeSourceKinds?.[n.sourceKind] ?? n.sourceKind}
            </Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: "操作",
      width: 148,
      render: (_, n) => <NodeActions node={n} matterId={m.id} onDone={invalidate} />,
    },
  ];

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      <PageHeader
        eyebrow={
          <>
            <Link href="/matters" style={{ fontSize: 12 }}>
              <ArrowLeftOutlined /> 案件
            </Link>
            <Typography.Text className="num">{m.internalCode}</Typography.Text>
            <StatusMark host="matter" code={m.status} />
            {m.isArchived ? <FlagMark>已归档</FlagMark> : null}
            {m.closingDate ? <FlagMark tone="info">已结案</FlagMark> : null}
          </>
        }
        title={m.name}
        meta={
          <>
            <MetaItem label="案号">
              <span className="num">{m.caseNo}</span>
            </MetaItem>
            <MetaItem label="案由">{m.cause}</MetaItem>
            <MetaItem label="程序">{meta?.enums.procedures[m.procedure] ?? m.procedure}</MetaItem>
            <MetaItem label="等级">{level}</MetaItem>
            <MetaItem label="标的额">
              <span className="num">{money(m.amount)}</span> 元
            </MetaItem>
            <MetaItem label="立案">{calDate(m.filingDate)}</MetaItem>
            <MetaItem label="更新">{fromNow(m.updatedAt)}</MetaItem>
          </>
        }
        actions={<Button onClick={() => setStatusOpen(true)}>变更状态</Button>}
      />

      <Card size="small" styles={{ body: { padding: "0 12px 12px" } }}>
        <Tabs
          defaultActiveKey="nodes"
          items={[
            {
              key: "basic",
              label: "基本信息",
              children: (
                <>
                  <Descriptions
                    size="small"
                    column={{ xs: 1, sm: 2, lg: 3 }}
                    items={[
                      {
                        key: "code",
                        label: "内部编号",
                        children: <span className="num">{m.internalCode}</span>,
                      },
                      {
                        key: "caseNo",
                        label: "正式案号",
                        children: <span className="num">{m.caseNo}</span>,
                      },
                      {
                        key: "type",
                        label: "案件类型",
                        children: meta?.enums.caseTypes[m.caseType] ?? m.caseType,
                      },
                      {
                        key: "role",
                        label: "我方诉讼地位",
                        children: meta?.enums.litigationRoles[m.litigationRole] ?? m.litigationRole,
                      },
                      { key: "court", label: "受理法院", children: m.court ?? "—" },
                      { key: "currency", label: "币种", children: m.currency },
                      { key: "closing", label: "结案日期", children: calDate(m.closingDate) },
                      { key: "archived", label: "归档时间", children: dateTime(m.archivedAt) },
                      { key: "progress", label: "最近进展", children: dateTime(m.lastProgressAt) },
                    ]}
                  />
                  <Typography.Paragraph
                    style={{ fontSize: 13, whiteSpace: "pre-wrap", marginBottom: 0 }}
                  >
                    {m.description?.trim() ? m.description : "没有填写基本情况。"}
                  </Typography.Paragraph>
                </>
              ),
            },
            {
              key: "nodes",
              label: `工作节点 (${m.nodes.length})`,
              children: m.nodes.length ? (
                <Table<Node>
                  size="small"
                  rowKey={(n) => n.id}
                  columns={nodeColumns}
                  dataSource={m.nodes}
                  pagination={false}
                />
              ) : (
                <StateBlock
                  title="还没有工作节点"
                  hint="节点是提醒的唯一入口：确认时间并设了期限，才会进工作台的到期清单。"
                />
              ),
            },
            {
              key: "people",
              label: `参与人 (${m.staff.length + m.parties.length})`,
              children: (
                <Flex gap={16} wrap align="flex-start">
                  <Card
                    size="small"
                    title={`承办与协办 (${m.staff.length})`}
                    style={{ flex: "1 1 320px" }}
                  >
                    <List
                      size="small"
                      dataSource={m.staff}
                      locale={{
                        emptyText: (
                          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有参与人" />
                        ),
                      }}
                      renderItem={(s) => (
                        <List.Item
                          actions={[
                            <span key="r" style={{ fontSize: 12, color: INK.muted }}>
                              {meta?.enums.staffRoles[s.staffRole] ?? s.staffRole}
                            </span>,
                          ]}
                        >
                          <Space size={6}>
                            <Avatar size={20} style={{ fontSize: 11 }}>
                              {s.displayName.slice(0, 1)}
                            </Avatar>
                            <span style={{ fontSize: 13 }}>{s.displayName}</span>
                          </Space>
                        </List.Item>
                      )}
                    />
                  </Card>
                  <Card
                    size="small"
                    title={`当事人 (${m.parties.length})`}
                    style={{ flex: "1 1 320px" }}
                  >
                    <List
                      size="small"
                      dataSource={m.parties}
                      locale={{
                        emptyText: (
                          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有当事人" />
                        ),
                      }}
                      renderItem={(p) => (
                        <List.Item
                          actions={[
                            <Space key="a" size={4}>
                              <span style={{ fontSize: 12, color: INK.muted }}>
                                {meta?.enums.litigationRoles[p.partyRole] ?? p.partyRole}
                              </span>
                              {p.represented ? <FlagMark tone="info">我方代理</FlagMark> : null}
                            </Space>,
                          ]}
                        >
                          <>
                            <div style={{ fontSize: 13 }}>{p.name}</div>
                            <div style={{ fontSize: 11, color: INK.muted }}>
                              {meta?.enums.partyTypes[p.type] ?? p.type}
                              {p.idNumber ? ` · ${p.idNumber}` : ""}
                            </div>
                          </>
                        </List.Item>
                      )}
                    />
                  </Card>
                </Flex>
              ),
            },
            {
              key: "log",
              label: `过程记录 (${m.progress.length + m.comments.length})`,
              children: (
                <LogTab
                  matterId={m.id}
                  progress={m.progress}
                  comments={m.comments}
                  onDone={invalidate}
                />
              ),
            },
            {
              key: "activity",
              label: `活动 (${m.activity.length})`,
              children: (
                <List
                  size="small"
                  dataSource={m.activity}
                  locale={{
                    emptyText: (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有活动记录" />
                    ),
                  }}
                  renderItem={(a) => (
                    <List.Item>
                      <Flex gap={12} align="baseline" wrap>
                        <span
                          className="num"
                          style={{ fontSize: 12, color: INK.muted, minWidth: 148 }}
                        >
                          {dateTime(a.createdAt)}
                        </span>
                        <Tag variant="filled" style={{ fontSize: 11 }}>
                          {meta?.enums.auditActions[a.action] ?? a.action}
                        </Tag>
                        <span style={{ fontSize: 13 }}>
                          {a.operator}
                          {a.reason ? <span style={{ color: INK.muted }}> · {a.reason}</span> : ""}
                        </span>
                      </Flex>
                    </List.Item>
                  )}
                />
              ),
            },
          ]}
        />
      </Card>

      <StatusDialog
        target={target}
        statuses={meta?.statuses ?? m.statuses}
        open={statusOpen}
        onOpenChange={setStatusOpen}
        onDone={() => {
          invalidate();
          message.success("状态已变更");
        }}
      />
    </div>
  );
}

/** 节点行内的状态动作：就地做，不跳页——节点是详情页最高频的操作 */
function NodeActions({
  node,
  matterId,
  onDone,
}: {
  node: Node;
  matterId: string;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const mut = useMutation({
    mutationFn: (body: { status: string; cancelReason?: string }) =>
      api.post(`/api/matters/${matterId}/nodes/${node.id}`, body),
    onSuccess: () => {
      onDone();
      message.success("节点已更新");
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "操作失败"),
  });

  const open = node.status === "not_started" || node.status === "in_progress";

  if (cancelling) {
    return (
      <Space size={4}>
        <Input
          autoFocus
          size="small"
          style={{ width: 96 }}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="取消原因（必填）"
          aria-label="取消原因"
        />
        <Button
          size="small"
          type="primary"
          disabled={!reason.trim() || mut.isPending}
          onClick={() => {
            mut.mutate({ status: "cancelled", cancelReason: reason.trim() });
            setCancelling(false);
          }}
        >
          确认
        </Button>
        <Button size="small" type="text" onClick={() => setCancelling(false)}>
          否
        </Button>
      </Space>
    );
  }

  return (
    <Space size={4}>
      {node.status === "not_started" ? (
        <Button
          size="small"
          disabled={mut.isPending}
          onClick={() => mut.mutate({ status: "in_progress" })}
        >
          开始
        </Button>
      ) : null}
      {open ? (
        <Button
          size="small"
          type="primary"
          disabled={mut.isPending}
          onClick={() => mut.mutate({ status: "completed" })}
        >
          完成
        </Button>
      ) : null}
      {node.status !== "cancelled" ? (
        <Button size="small" type="text" onClick={() => setCancelling(true)}>
          取消
        </Button>
      ) : null}
      {/*
        「改待定」是 §6.1 那个合并视图的反方向：开庭时间没定下来时，节点要退出提醒扫描
        （扫描器的 partial index 只吃 `is_time_confirmed`，修订稿 §6.1）。
        它不改 E21 的四值状态，只把 `is_time_confirmed` 落回 false —— 服务层那边同一次翻译。
      */}
      {open && node.isTimeConfirmed ? (
        <Button
          size="small"
          type="text"
          disabled={mut.isPending}
          onClick={() => mut.mutate({ status: "pending" })}
        >
          改待定
        </Button>
      ) : null}
      {/*
        反方向只在**时间已经填了**的时候给：`confirm_time` 要的是"这个时间算数了"，
        空时间点确认会被服务层拒（`why: "time_missing"`），因为 `deadline_time` 还是 null，
        扫描器捞到它也算不出还剩几天。
      */}
      {open && !node.isTimeConfirmed && node.startTime ? (
        <Button
          size="small"
          type="text"
          disabled={mut.isPending}
          onClick={() => mut.mutate({ status: "confirm_time" })}
        >
          标已确认
        </Button>
      ) : null}
    </Space>
  );
}

function LogTab({
  matterId,
  progress,
  comments,
  onDone,
}: {
  matterId: string;
  progress: Matter["progress"];
  comments: Matter["comments"];
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { data: meta } = useMeta("matter");
  const [body, setBody] = useState("");

  const mut = useMutation({
    mutationFn: () => api.post(`/api/matters/${matterId}/comments`, { body: body.trim() }),
    onSuccess: () => {
      setBody("");
      onDone();
      message.success("评论已发布");
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "提交失败"),
  });

  return (
    <Flex gap={16} wrap align="flex-start">
      <div style={{ flex: "1 1 320px" }}>
        <Space orientation="vertical" size={8} style={{ display: "flex", marginBottom: 12 }}>
          <Input.TextArea
            rows={2}
            maxLength={2000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="记录一个结论、一次沟通，或一个待确认的点"
          />
          <Button
            type="primary"
            size="small"
            disabled={!body.trim() || mut.isPending}
            onClick={() => mut.mutate()}
          >
            发布评论
          </Button>
        </Space>
        <List
          size="small"
          header={<span style={{ fontSize: 13 }}>评论 ({comments.length})</span>}
          dataSource={comments}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有评论" />,
          }}
          renderItem={(c) => (
            <List.Item>
              <>
                <div style={{ fontSize: 11, color: INK.muted }}>
                  {c.author} · {fromNow(c.createdAt)}
                </div>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{c.body}</div>
              </>
            </List.Item>
          )}
        />
      </div>

      <div style={{ flex: "1 1 320px" }}>
        <List
          size="small"
          header={<span style={{ fontSize: 13 }}>案件进展 ({progress.length})</span>}
          dataSource={progress}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="这条链路上还没有进展记录（写进展的端点还没做）"
              />
            ),
          }}
          renderItem={(p) => (
            <List.Item>
              <>
                <Flex justify="space-between" gap={8}>
                  <span style={{ fontSize: 12, color: INK.secondary }}>
                    {meta?.enums.progressTypes[p.progressType] ?? p.progressType}
                  </span>
                  <span className="num" style={{ fontSize: 12, color: INK.muted }}>
                    {calDate(p.progressDate)}
                  </span>
                </Flex>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{p.content}</div>
                {p.nextPlan ? (
                  <div style={{ fontSize: 12, color: INK.muted }}>下一步：{p.nextPlan}</div>
                ) : null}
                <div style={{ fontSize: 11, color: INK.faint }}>{p.author}</div>
              </>
            </List.Item>
          )}
        />
      </div>
    </Flex>
  );
}

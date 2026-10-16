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
  Listy,
  Popconfirm,
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
import { PageHeader } from "@/app/components/page-header";
import { ExpensePanel } from "@/app/components/expense-panel";
import { ExportFileButton } from "@/app/components/export-file-button";
import { StatusMark, FlagMark } from "@/app/components/ui/status-mark";
import { DeadlineMark } from "@/app/components/ui/deadline-mark";
import { StateBlock } from "@/app/components/ui/state-block";
import { CommentBody } from "@/app/components/comment-body";
import { StatusDialog, type StatusTarget } from "@/app/components/status-dialog";
import {
  NOT_READY_TEXT,
  READINESS_LABELS,
  READINESS_TAB,
  READY_TEXT,
  STATE_COLOR,
  STATE_LABEL,
  UNAVAILABLE_HINT,
} from "@/app/lib/client/archive-readiness";
import { StaffPicker } from "./staff-picker";

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
  // 受控页签：归档就绪卡点一项要跳到对应页签（F2-26）
  const [tab, setTab] = useState("nodes");

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["matter", id],
    queryFn: () => api.get<Matter>(`/api/matters/${id}`),
  });

  const refetchDetail = () => {
    void qc.invalidateQueries({ queryKey: ["matter", id] });
    void qc.invalidateQueries({ queryKey: ["matters"] });
  };

  /** 移出参与人（MATT-49）。经办人那条服务端会拒（owner_protected），界面上也不摆按钮。 */
  const removeStaff = useMutation({
    mutationFn: (userId: string) =>
      api.del<{ removed: number }>(`/api/matters/${id}/staff/${userId}`),
    onSuccess: () => {
      message.success("已移出名单");
      refetchDetail();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "移出失败"),
  });

  /**
   * 软删案件（MATT-62 / F2-5）。与事项详情页那颗按钮**同形**：
   * 确认弹窗 + 同一句文案 + 归档态也给（服务层允许删已归档案件，
   * 裁定写在 `deleteMatter` 的注释里：材料缺项已由 `ARCHIVED` 审计结清，
   * 删除要的是归属，不该与 `can_unarchive` 绑在一起）。
   *
   * ⚠ 删除的是**案件主档**，它的节点/参与人/当事人/进展都还指向这一行
   *   （FK 一律 RESTRICT，见修订稿 §12.4）⇒ 界面上这一行从列表消失、
   *   详情页随之 404，而库里的关联行原样留着，与事项侧逐字同形。
   */
  const softDelete = useMutation({
    mutationFn: () => api.del<{ ok: true }>(`/api/matters/${id}`),
    onSuccess: () => {
      message.success("已删除。库里仍保留，但界面上没有回收站。");
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "删除失败"),
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
        title={m.name}
        status={<StatusMark host="matter" code={m.status} />}
        flags={
          <>
            {m.isArchived ? <FlagMark>已归档</FlagMark> : null}
            {m.closingDate ? <FlagMark tone="info">已结案</FlagMark> : null}
          </>
        }
        actions={
          <Space size={8}>
            <ExportFileButton host="matter" hostId={m.id} code={m.internalCode} />
            <Button onClick={() => setStatusOpen(true)}>变更状态</Button>
            {/* 删除（MATT-62 / F2-5）：文案与事项详情页逐字相同。
                归档态**也摆** —— 与「转案件 / 变更经办人」那几个按钮不同，
                删除不要求先撤归档（裁定见 deleteMatter 的注释）。 */}
            <Popconfirm
              title="删除这条案件？"
              description="删除后不再出现在列表里；库里仍保留，但没有回收站。"
              okText="删除"
              cancelText="取消"
              onConfirm={() => softDelete.mutate()}
            >
              <Button danger loading={softDelete.isPending}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        }
      />

      <Card size="small" styles={{ body: { padding: "0 12px 12px" } }}>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: "basic",
              label: "基本信息",
              children: (
                <>
                  {/* 「归档就绪」三项（F2-26）。**服务端算好给**（详情 DTO 的
                      archiveReadiness），前端不重算——判定只实现一次，
                      列表的「已结案缺材料」筛选是它的另一个出口。
                      点一项跳到该补录的页签（READINESS_TAB）。 */}
                  {m.archiveReadiness ? (
                    <Card
                      size="small"
                      title="归档就绪"
                      style={{ marginBottom: 12 }}
                      extra={
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {/* 口径与归档弹窗共用同一对常量：两个显示面各写一句就会出现
                              "卡片说缺项、弹窗说齐备"（检查子代理抓到过）。 */}
                          {m.archiveReadiness.missing.length === 0 ? READY_TEXT : NOT_READY_TEXT}
                        </Typography.Text>
                      }
                    >
                      <Space size={8} wrap>
                        {m.archiveReadiness.checks.map((c) => {
                          const tab = READINESS_TAB[c.key];
                          return (
                            <Tag
                              key={c.key}
                              color={STATE_COLOR[c.state]}
                              variant="filled"
                              style={{
                                marginInlineEnd: 0,
                                // 没有可补录的页签时不装成可点（`judgment` 就是这种：
                                // 附件页签不存在，点进去也无处补录）
                                cursor: tab ? "pointer" : "default",
                              }}
                              onClick={tab ? () => setTab(tab) : undefined}
                            >
                              {READINESS_LABELS[c.key]}
                              {" · "}
                              {STATE_LABEL[c.state]}
                              {c.state === "missing" && c.count ? `（${c.count} 个未决节点）` : ""}
                            </Tag>
                          );
                        })}
                      </Space>
                      {m.archiveReadiness.unavailable.length ? (
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12, display: "block", marginTop: 6 }}
                        >
                          {UNAVAILABLE_HINT.attachment_not_built}——所以上面那句话只覆盖已判的两项。
                        </Typography.Text>
                      ) : null}
                    </Card>
                  ) : null}
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
                      // 2026-10-12 从页头 `meta` 搬来：页头不再有第二行说明的位置。
                      // 这几项同屏已各有来源（内部编号/正式案号见上），再在页头写一遍就是
                      // 两处同一个值，将来必然不同步。搬进来后 15 项，lg 下 5 行。
                      { key: "cause", label: "案由", children: m.cause },
                      {
                        key: "procedure",
                        label: "程序",
                        children: meta?.enums.procedures[m.procedure] ?? m.procedure,
                      },
                      { key: "level", label: "等级", children: level },
                      {
                        key: "amount",
                        label: "标的额",
                        children: (
                          <>
                            <span className="num">{money(m.amount)}</span> 元
                          </>
                        ),
                      },
                      { key: "filing", label: "立案", children: calDate(m.filingDate) },
                      {
                        key: "updatedAt",
                        label: "更新",
                        children: dateTime(m.updatedAt),
                      },
                    ]}
                  />
                  <Typography.Paragraph
                    style={{ fontSize: 13, whiteSpace: "pre-wrap", marginBottom: 0 }}
                  >
                    {m.description?.trim() ? m.description : "没有填写基本情况。"}
                  </Typography.Paragraph>

                  {/*
                    来源风险卡片（MATT-65 / F2-22）—— 与事项详情页那张「已转案件」卡
                    **互为镜像**（那边是事项反查案件，这边是案件反查事项）。

                    三种状态分开画，不能合并：
                      ① 有可见来源 ⇒ 列表，每行带跳转；
                      ② 有来源但一条都看不见（`sourceRisksHidden > 0` 且列表空）⇒ **占位**，
                         文案说清"那里还有东西只是你看不到"（用户故事 24 的原话）；
                      ③ 真的没有来源 ⇒ 空态，且文案与②不同 ——
                         把"你看不见"画成"没有来源"会让人以为这条案件建错了地方。

                    ⚠ 占位行**不带任何跳转**：那条事项的 id 不在响应体里
                    （服务层按范围谓词过滤掉了），给了链接点进去也是 404 ——
                    那不是"礼貌的占位"，是把越权入口摆在界面上。
                  */}
                  {m.sourceRisks.length > 0 || m.sourceRisksHidden > 0 ? (
                    <Card
                      size="small"
                      title={`来源风险 (${m.sourceRisks.length})`}
                      style={{ marginTop: 12 }}
                    >
                      {m.sourceRisks.length > 0 ? (
                        <Listy
                          items={m.sourceRisks}
                          rowKey={(s) => s.id}
                          itemRender={(s) => (
                            <Flex justify="space-between" align="center" gap={8}>
                              <Space size={6}>
                                <Tag style={{ marginInlineEnd: 0 }}>{s.code}</Tag>
                                <span style={{ fontSize: 13 }}>{s.name}</span>
                                <span style={{ fontSize: 12, color: INK.muted }}>
                                  {meta?.enums.riskTypes?.[s.type] ?? s.type}
                                </span>
                                {s.isArchived ? (
                                  <span style={{ fontSize: 12, color: INK.faint }}>（已归档）</span>
                                ) : null}
                              </Space>
                              <Link href={`/risk-matters/${s.id}`}>
                                <Button type="link" size="small" style={{ padding: 0 }}>
                                  查看
                                </Button>
                              </Link>
                            </Flex>
                          )}
                        />
                      ) : null}
                      {m.sourceRisks.length === 0 && m.sourceRisksHidden > 0 ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          这条案件有 {m.sourceRisksHidden} 条来源风险，但它们不在你的数据范围内，
                          因此不显示名称与编号。
                        </Typography.Text>
                      ) : null}
                    </Card>
                  ) : null}
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
                    extra={
                      <Space size={4}>
                        <StaffPicker
                          matterId={id}
                          staffRole="co_owner"
                          label="加协办"
                          existingUserIds={m.staff.map((s) => s.userId)}
                          onDone={refetchDetail}
                        />
                        <StaffPicker
                          matterId={id}
                          staffRole="follower"
                          label="加关注"
                          existingUserIds={m.staff.map((s) => s.userId)}
                          onDone={refetchDetail}
                        />
                      </Space>
                    }
                  >
                    {m.staff.length ? (
                      <Listy
                        items={m.staff}
                        // ⚠ 不能只用 `userId`：同一个人可以**两种身份**都在名单里（案 7001 就是
                        // owner + co_owner 各一行）。老 `List` 没传 `rowKey`，key 取的是下标，
                        // 所以这个重复一直藏着；迁移后按 `userId` 取 key 立刻变成 React 的
                        // "two children with the same key" 报错。唯一键照库里的
                        // `uk_mn_matter_staff_triple (matter_id, user_id, staff_role)`：二元组足矣。
                        rowKey={(s) => `${s.userId}-${s.staffRole}`}
                        itemRender={(s) => (
                          <Flex justify="space-between" align="center" gap={8}>
                            <Space size={6}>
                              <Avatar size={20} style={{ fontSize: 11 }}>
                                {s.displayName.slice(0, 1)}
                              </Avatar>
                              <span style={{ fontSize: 13 }}>{s.displayName}</span>
                            </Space>
                            <Space size={4}>
                              <span style={{ fontSize: 12, color: INK.muted }}>
                                {meta?.enums.staffRoles[s.staffRole] ?? s.staffRole}
                              </span>
                              {/* 经办人摘不掉（服务端 403 owner_protected）——所以这里不摆按钮。
                                  换负责人是「负责人」字段的事，不是名单的事。 */}
                              {s.staffRole === "owner" ? null : (
                                <Popconfirm
                                  title="把这位同事移出名单？"
                                  okText="移出"
                                  cancelText="取消"
                                  onConfirm={() => removeStaff.mutate(s.userId)}
                                >
                                  <Button type="link" size="small" danger>
                                    移出
                                  </Button>
                                </Popconfirm>
                              )}
                            </Space>
                          </Flex>
                        )}
                      />
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有参与人" />
                    )}
                  </Card>
                  <Card
                    size="small"
                    title={`当事人 (${m.parties.length})`}
                    style={{ flex: "1 1 320px" }}
                  >
                    {m.parties.length ? (
                      <Listy
                        items={m.parties}
                        rowKey={(p) => p.id}
                        itemRender={(p) => (
                          // ⚠ 老 `List.Item` 是 `display:flex` + `space-between`：迁移前的三块（名称 /
                          // 类型·证件号 / 角色）就是**横排**的。这里保持同形，改不改是另一个决定。
                          <Flex justify="space-between" align="center" gap={8}>
                            <div style={{ fontSize: 13 }}>{p.name}</div>
                            <div style={{ fontSize: 11, color: INK.muted }}>
                              {meta?.enums.partyTypes[p.type] ?? p.type}
                              {p.idNumber ? ` · ${p.idNumber}` : ""}
                            </div>
                            <span style={{ fontSize: 12, color: INK.muted }}>
                              {meta?.enums.litigationRoles[p.partyRole] ?? p.partyRole}
                            </span>
                          </Flex>
                        )}
                      />
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有当事人" />
                    )}
                  </Card>
                </Flex>
              ),
            },
            {
              key: "expenses",
              label: "费用",
              children: <ExpensePanel host="matter" hostId={m.id} archived={m.isArchived} />,
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
              label: `活动日志 (${m.activity.length})`,
              children: m.activity.length ? (
                <Listy
                  items={m.activity}
                  rowKey={(a) => a.id}
                  itemRender={(a) => (
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
                  )}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有活动记录" />
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
            placeholder="记录一个结论、一次沟通，或一个待确认的点；用 @姓名 提及同事"
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
        <div style={{ fontSize: 13, paddingBlock: 12 }}>评论 ({comments.length})</div>
        {comments.length ? (
          <Listy
            items={comments}
            rowKey={(c) => c.id}
            itemRender={(c) => (
              // ⚠ 老 `List.Item` 是 `display:flex` + `space-between`，所以这两块一直是**横排**的：
              // 迁移**保持同形**（`Listy` 的 item 是块级，不套 Flex 就会静默变成纵排）。
              <Flex justify="space-between" align="center" gap={8}>
                <div style={{ fontSize: 11, color: INK.muted }}>
                  {c.author} · {fromNow(c.createdAt)}
                </div>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                  <CommentBody body={c.body} parts={c.parts} />
                </div>
              </Flex>
            )}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有评论" />
        )}
      </div>

      <div style={{ flex: "1 1 320px" }}>
        <div style={{ fontSize: 13, paddingBlock: 12 }}>案件进展 ({progress.length})</div>
        {progress.length ? (
          <Listy
            items={progress}
            rowKey={(p) => p.id}
            itemRender={(p) => (
              // 同「评论」：老 `List.Item` 是 flex 行，几个 div 一直是**横排**的，这里保持同形
              <Flex justify="space-between" align="center" gap={8}>
                <Flex justify="space-between" gap={8} style={{ flex: 1 }}>
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
              </Flex>
            )}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="这条链路上还没有进展记录（写进展的端点还没做）"
          />
        )}
      </div>
    </Flex>
  );
}

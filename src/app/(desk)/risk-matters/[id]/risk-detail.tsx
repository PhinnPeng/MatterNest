"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Col,
  Dropdown,
  Empty,
  Flex,
  Input,
  Listy,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from "antd";
import { ArrowLeftOutlined, PlusOutlined } from "@ant-design/icons";

import { api, ApiFailure, useActor, useMeta, type RiskDetail as Risk } from "@/app/lib/client/api";
import { calDate, dateTime } from "@/app/lib/client/format";
import { PageHeader } from "@/app/components/page-header";
import { CommentRail } from "@/app/components/comment-rail";
import { AttachmentPanel } from "@/app/components/attachment-panel";
import { ExpensePanel } from "@/app/components/expense-panel";
import { ExportFileButton } from "@/app/components/export-file-button";
import { FollowGroup } from "@/app/components/follow-group";
import { NodeDialog, type NodeSeed } from "@/app/components/node-dialog";
import { ProgressLogDialog, ProgressPanel } from "@/app/components/progress-panel";
import { StatusMark, FlagMark } from "@/app/components/ui/status-mark";
import { StateBlock } from "@/app/components/ui/state-block";
import { ErrorArt } from "@/app/components/ui/error-art";
import { StatusDialog, type StatusTarget } from "@/app/components/status-dialog";
import { RichTextView, RichTextEditorLazy } from "@/app/components/ui/rich-text";
import { ConvertDialog } from "../convert-dialog";
import { NODE_STATUS_LABELS, LITIGATION_ROLE_LABELS } from "@/shared/enums/business";

/**
 * 风险事项详情（T1）。
 *
 * 布局按 **IQ-17**：左侧一等高「事项节点」栏，右侧单栏流式——标题卡 →
 * 折叠区（风险描述 / 当事人 / 参与人 / 登记信息）→ 处置记录（最新在最上）。
 * **无 Tab**（F7-6 的「六 Tab」被 IQ-7 作废）。
 *
 * 三条与案件侧**刻意不同**的地方（IQ-5「事项是台账，案件是战场」），不是抄漏：
 *   · 节点栏允许为空，并给一个「手动加节点」的入口 —— 事项侧无预设节点
 *   · 节点只有时间点，**不出现时间段控件**；未确认时间用"待定"而不是留空
 *   · 经办人可空，空时显示「未指派」并给「变更经办人」按钮
 *
 * 写成功一律失效 `["risk", id]` / `["risk-matters"]` / `["overview"]`：
 * 详情页要立刻看到，回列表与工作台也要看见。
 */
const DETAIL_TABS = ["basic", "nodes", "people", "expenses", "progress", "activity"] as const;

export function RiskDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const { message } = AntdApp.useApp();
  const [statusOpen, setStatusOpen] = useState(false);
  const [nodeOpen, setNodeOpen] = useState(false);
  /** 为空 = 新增；非空 = 编辑（2026-10-23 起两侧共用同一个节点对话框） */
  const [editNode, setEditNode] = useState<NodeSeed | null>(null);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const searchParams = useSearchParams();
  /** 与案件详情同一条读法：非法值与不带参数都回落 basic */
  const [tab, setTab] = useState(() => {
    const t = searchParams.get("tab");
    return t && (DETAIL_TABS as readonly string[]).includes(t) ? t : "basic";
  });

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["risk", id],
    queryFn: () => api.get<Risk>(`/api/risk-matters/${id}`),
  });
  // 中文名走共享 hook：类型/等级/活动动作的中文都来自 `/api/meta`，与列表页同源。
  //
  // ⚠ 必须挂在下面那两个 early return **之前**：hook 一旦挂在条件返回之后就违反
  // Rules of Hooks——首屏 `isPending` 走了 A 分支、meta 回来后走 B 分支，hook 数量变了，
  // React 直接抛 "change in the order of Hooks"。这个错 tsc 不报、API 冒烟也不报，
  // 只有页面真跑起来才炸（浏览器 dev overlay 当场抓到了）。
  const { data: meta } = useMeta("risk_matter");
  // 节点类型是**例外**：它随详情一起返回（`risks.ts` 已按 IQ-5 过滤掉 time_type='range'），
  // 所以下面直接取 `risk.nodeTypes`。
  //
  // 这里原来另发一次 `/api/meta?host=risk_matter`，但那个接口**不返回 nodeTypes**
  // （`host` 只决定状态/等级/标签三样）。于是 `pointTypes` 恒为 `[]`，"加节点"弹窗
  // 没有可选类型 ⇒ **界面上加不了节点**，而 tsc 与服务层冒烟都发现不了：
  // 前者不校验运行时响应形状，后者是直接 POST `/nodes` 绕过界面的。
  // 一次多余的网络往返，换来一个看不见的功能缺失——删掉。

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["risk", id] });
    qc.invalidateQueries({ queryKey: ["risk-matters"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };

  const softDelete = useMutation({
    mutationFn: () => api.del(`/api/risk-matters/${id}`),
    onSuccess: () => {
      message.success("已删除。库里仍保留，但界面上没有回收站。");
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "删除失败"),
  });

  // 描述编辑权：镜像服务层 `updateRiskMatter` 的归属判定（owner / L1 / 未指派可接手），
  // 归档态除外。不镜像就会给一个点了必 403 的按钮（护栏 2 的"关注只读"落到界面上）。
  const { data: actor } = useActor();
  const canEditBody =
    !!actor &&
    !data?.isArchived &&
    (actor.dataScope === "all" || !data?.ownerId || data.ownerId === actor.userId);
  const saveDesc = useMutation({
    mutationFn: (markdown: string) =>
      api.patch(`/api/risk-matters/${id}`, { description: markdown }),
    onSuccess: () => {
      setDescOpen(false);
      message.success("已更新描述");
      invalidate();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "保存失败"),
  });

  if (isPending) {
    return <div className="card" style={{ minHeight: 320 }} />;
  }
  // 404 走"不可见或不存在"这一句措辞，不写"事项不存在"——服务层对两者都给 404
  if (isError) {
    const denied = error instanceof ApiFailure && error.status === 404;
    return (
      <StateBlock
        layout="page"
        art={<ErrorArt variant={denied ? "not-found" : "error"} />}
        tone={denied ? "denied" : "error"}
        title={denied ? "打不开这条事项" : "读取出错"}
        hint={
          denied
            ? "它要么不存在，要么不在你的数据范围内 —— 这两种情况系统给的是同一个响应，不区分。"
            : error instanceof Error
              ? error.message
              : "未知错误"
        }
        action={
          denied ? (
            <Link href="/risk-matters">
              <Button size="small" icon={<ArrowLeftOutlined />}>
                回事项列表
              </Button>
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

  const risk = data;
  /**
   * 参与人 = 经办 + 协办（有读写权）；关注人只收通知，归页头关注组。
   * 与案件详情同一口径（GLOSSARY「经办人 / 协办人 / 关注人」）。
   */
  const handlers = risk.staff.filter((s) => s.staffRole !== "follower");
  const statusTarget: StatusTarget | null = {
    id: risk.id,
    code: risk.code,
    name: risk.name,
    status: risk.status,
  };

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      {/* D2（IQ-19）：左内容 + 右评论栏。两列**同顶边** ⇒ 右栏高度可以直接用 CSS 表达；
          原型里那套 JS 量 `--rail-h` 是为"整幅页头把评论栏推下去"那个偏移准备的，D2 没有那个偏移。
          76 = 顶栏 60 + 内容区上内边距 16；-92 再留 16 的底边距。 */}
      <Row gutter={16} align="stretch">
        {/* ── 左列：页头 + 内容页签 ──
            `flex="1 1 0"` 而不是 `flex="auto"`（= `1 1 auto`）：auto 的 flex base 是
            **内容 max-content**，而 antd Row 默认 `flex-wrap: wrap` —— 左列内容一旦宽过
            (行宽 − 356)，右栏就被换行挤到下一行，两列顶边不再同 y（D2 的硬要求）。
            加「转案件」按钮那次就正好把页头推过阈值：1134 的行里左列独占 1134、右栏掉到 y=748。
            basis 归零后左列宽度只由"行宽 − 右栏"决定，与内容宽度无关；
            `minWidth: 0` 保证内容仍能在列内收缩（表格自己横向滚）。 */}
        <Col
          flex="1 1 0"
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 14,
            // 与右栏同基准（MATT-55：左列 min-height = 右栏高），两列顶边同 y ⇒ 底边同高
            minHeight: "calc(100vh - 84px)",
          }}
        >
          <div className="stack">
            <div>
              <PageHeader
                stacked
                back={{ href: "/risk-matters", label: "返回事项列表" }}
                title={risk.name}
                code={risk.code}
                status={<StatusMark host="risk_matter" code={risk.status} />}
                flags={
                  <>
                    {!risk.ownerId && !risk.isArchived ? (
                      <FlagMark tone="warn">未指派</FlagMark>
                    ) : null}
                    <FlagMark tone={risk.level === "high" ? "danger" : "neutral"}>
                      {meta?.levels.find((l) => l.code === risk.level)?.name ?? risk.level}
                    </FlagMark>
                  </>
                }
                actions={
                  <>
                    {/* 「撤销归档」不单设按钮：它就是一条状态迁移，走同一个「变更状态」
                        （archive-view.tsx 的注释写的也是这条）。单设按钮会造出第二条到同一状态的路。 */}
                    <FollowGroup
                      host="risk_matter"
                      hostId={risk.id}
                      followers={risk.staff
                        .filter((s) => s.staffRole === "follower")
                        .map((s) => ({ id: s.id, userId: s.userId, name: s.name }))}
                      meId={actor?.userId ?? ""}
                      canManage={
                        !!actor &&
                        (actor.dataScope === "all" ||
                          risk.ownerId === actor.userId ||
                          risk.creatorId === actor.userId)
                      }
                      isArchived={risk.isArchived}
                      onChanged={invalidate}
                    />
                    <ExportFileButton host="risk_matter" hostId={risk.id} code={risk.code} />
                    <button type="button" className="btn" onClick={() => setStatusOpen(true)}>
                      变更状态
                    </button>
                    {/* 转案件是建案入口之一（IQ-3），详情页与列表页都要能发起（T2 验收原文）。
                        归档态不给：归档是终态，服务层会 422 archived。 */}
                    {!risk.isArchived && (
                      <button type="button" className="btn" onClick={() => setConvertOpen(true)}>
                        转案件
                      </button>
                    )}
                    {!risk.isArchived && (
                      <button type="button" className="btn" onClick={() => setOwnerOpen(true)}>
                        变更经办人
                      </button>
                    )}
                    {!risk.isArchived && (
                      <Popconfirm
                        title="删除这条事项？"
                        description="删除后不再出现在列表里；库里仍保留，但没有回收站。"
                        okText="删除"
                        cancelText="取消"
                        onConfirm={() => softDelete.mutate()}
                      >
                        <button
                          type="button"
                          className="btn danger"
                          disabled={softDelete.isPending}
                        >
                          删除
                        </button>
                      </Popconfirm>
                    )}
                  </>
                }
              />

              {/* 描述：主表业务字段，整幅放在标题下（与案件详情同址）。
                  富文本（markdown 存储，ADR-0002）：只读走 RichTextView，编辑走懒加载的 BlockNote 弹层。 */}
              <div style={{ marginTop: 2 }}>
                <Flex align="center" justify="space-between" style={{ marginBottom: 5 }}>
                  <span style={{ fontSize: 12, color: "var(--ink3)" }}>描述</span>
                  {canEditBody && (
                    <Button size="small" type="link" onClick={() => setDescOpen(true)}>
                      编辑
                    </Button>
                  )}
                </Flex>
                {risk.description ? (
                  <div style={{ maxWidth: "74ch" }}>
                    <RichTextView markdown={risk.description} />
                  </div>
                ) : (
                  <Dash />
                )}
              </div>
            </div>

            <Tabs
              activeKey={tab}
              onChange={setTab}
              items={[
                {
                  key: "basic",
                  label: "基本信息",
                  children: (
                    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                      <Card size="small" title="基本信息">
                        <Descriptions
                          column={2}
                          size="small"
                          items={[
                            {
                              key: "code",
                              label: "编号",
                              children: <span className="num">{risk.code}</span>,
                            },
                            {
                              key: "type",
                              label: "风险类型",
                              children: meta?.enums.riskTypes[risk.type] ?? risk.type,
                            },
                            {
                              key: "level",
                              label: "等级",
                              children:
                                meta?.levels.find((l) => l.code === risk.level)?.name ?? risk.level,
                            },
                            {
                              key: "status",
                              label: "状态",
                              children: <StatusMark host="risk_matter" code={risk.status} />,
                            },
                            {
                              key: "discoverDate",
                              label: "发现日期",
                              children: calDate(risk.discoverDate),
                            },
                            {
                              key: "owner",
                              label: "经办人",
                              children: risk.ownerId ? (
                                risk.ownerName
                              ) : (
                                <FlagMark tone="warn">未指派</FlagMark>
                              ),
                            },
                            {
                              key: "lastProgressAt",
                              label: "最近进展",
                              children: dateTime(risk.lastProgressAt),
                            },
                            {
                              key: "createdAt",
                              label: "创建时间",
                              children: dateTime(risk.createdAt),
                            },
                            {
                              key: "updatedAt",
                              label: "更新时间",
                              children: dateTime(risk.updatedAt),
                            },
                            ...(risk.archivedAt
                              ? [
                                  {
                                    key: "archivedAt",
                                    label: "归档",
                                    children: calDate(risk.archivedAt),
                                  },
                                ]
                              : []),
                            ...(risk.convertedAt
                              ? [
                                  {
                                    key: "convertedAt",
                                    label: "首次转案件",
                                    children: dateTime(risk.convertedAt),
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </Card>

                      <Card size="small" title="附件">
                        <AttachmentPanel
                          host="risk_matter"
                          hostId={risk.id}
                          archived={risk.isArchived}
                        />
                      </Card>

                      {risk.convertedCases.length > 0 ? (
                        <Card size="small" title={`已转案件 (${risk.convertedCases.length})`}>
                          <Listy
                            items={risk.convertedCases}
                            rowKey={(c) => c.id}
                            itemRender={(c) => (
                              <Flex justify="space-between" align="center" gap={8}>
                                <Space size={6}>
                                  <Link href={`/matters/${c.id}`} className="num">
                                    {c.internalCode}
                                  </Link>
                                  <span style={{ fontSize: 13 }}>{c.name}</span>
                                </Space>
                                <StatusMark host="matter" code={c.status} />
                              </Flex>
                            )}
                          />
                        </Card>
                      ) : null}
                    </Space>
                  ),
                },
                {
                  key: "nodes",
                  label: `事项节点 (${risk.nodes.length})`,
                  children: (
                    <Card size="small">
                      <div>
                        {/* 手动添加节点只出现在这个面板里（它属于节点列表，不属于页头） */}
                        {!risk.isArchived && (
                          <Flex justify="flex-end" style={{ marginBottom: 8 }}>
                            <Button
                              size="small"
                              icon={<PlusOutlined />}
                              onClick={() => {
                                setEditNode(null);
                                setNodeOpen(true);
                              }}
                            >
                              新增节点
                            </Button>
                          </Flex>
                        )}
                        {risk.nodes.length === 0 ? (
                          <StateBlock
                            title="还没有节点"
                            // 说清为什么是空的：事项侧不预设节点（IQ-5），节点只在确有时限时手动加
                            hint="事项不预置节点。只有确有时限时才手动加一个时间点。"
                            action={
                              risk.isArchived ? undefined : (
                                <Button
                                  size="small"
                                  onClick={() => {
                                    setEditNode(null);
                                    setNodeOpen(true);
                                  }}
                                >
                                  新增节点
                                </Button>
                              )
                            }
                          />
                        ) : (
                          <Listy
                            items={risk.nodes}
                            rowKey={(n: Risk["nodes"][number]) => String(n.id)}
                            itemRender={(n: Risk["nodes"][number]) => (
                              <NodeRow
                                node={n}
                                riskId={risk.id}
                                readOnly={risk.isArchived}
                                onDone={invalidate}
                                onEdit={() => {
                                  setEditNode({
                                    id: n.id,
                                    name: n.name,
                                    remark: n.remark,
                                    startTime: n.startTime,
                                  });
                                  setNodeOpen(true);
                                }}
                              />
                            )}
                          />
                        )}
                      </div>
                    </Card>
                  ),
                },
                {
                  key: "people",
                  label: `参与人与当事人 (${handlers.length + risk.parties.length})`,
                  children: (
                    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                      <Card size="small" title={`当事人 (${risk.parties.length})`}>
                        {risk.parties.length === 0 ? (
                          <Dash hint="没有当事人时无法转案件——转案件要求每案至少 1 个当事人。" />
                        ) : (
                          <Space orientation="vertical" size={6} style={{ width: "100%" }}>
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
                      </Card>
                      <Card size="small" title={`承办与协办 (${handlers.length})`}>
                        <Space size={8} wrap>
                          {handlers.length === 0 && <Dash />}
                          {handlers.map((s) => (
                            <Tag key={s.id}>
                              {s.name}·{s.staffRole === "owner" ? "经办" : "协办"}
                            </Tag>
                          ))}
                        </Space>
                      </Card>
                    </Space>
                  ),
                },
                {
                  key: "expenses",
                  label: "费用",
                  children: (
                    <Card size="small">
                      <ExpensePanel
                        host="risk_matter"
                        hostId={risk.id}
                        archived={risk.isArchived}
                      />
                    </Card>
                  ),
                },
                {
                  key: "progress",
                  label: `进展 (${risk.progress.length})`,
                  children: (
                    <Card size="small">
                      <ProgressPanel
                        host="risk_matter"
                        hostId={risk.id}
                        progress={risk.progress}
                        onDone={invalidate}
                        readOnly={risk.isArchived}
                      />
                    </Card>
                  ),
                },
                {
                  key: "activity",
                  label: `活动日志 (${risk.activity.length})`,
                  children: (
                    <Card size="small">
                      {risk.activity.length === 0 ? (
                        <Dash />
                      ) : (
                        <Timeline
                          items={risk.activity.slice(0, 20).map((a) => ({
                            children: (
                              <Space orientation="vertical" size={0}>
                                <span>{meta?.enums.auditActions[a.action] ?? a.action}</span>
                                <span style={{ color: "var(--ink3)", fontSize: 12 }}>
                                  {dateTime(a.createdAt)}
                                </span>
                              </Space>
                            ),
                          }))}
                        />
                      )}
                    </Card>
                  ),
                },
              ]}
            />
          </div>
        </Col>

        {/* ── 右列：评论（事项的主交互面）。sticky + 自带滚动 + 输入框钉底；
            高度按"本栏顶边 = 内容区顶边"直接算，不需要 JS 量。
            356 = 卡片要的 340 + 16（antd gutter 给列两侧各 8 的内边距）——写 340 会得到 324 的内宽。 ── */}
        <Col flex="356px">
          <div
            style={{
              position: "sticky",
              // 16 = 内容区内边距（滚动后本栏贴到内容区顶）；80 = 顶栏 64 + 下边距 16。
              // 这组数让**首屏**与**滚动后**都不出折线：首屏 top=64、高 100vh-84 → 底边在折线以上 20。
              // 20 是票面（MATT-55 / IQ-19 批注）写死的数，16 会让验收数字对不上（实测 752 → 距 16）。
              top: 16,
              // ⚠ height 而不是 maxHeight：maxHeight 只封顶不撑开，卡片会缩成内容高，
              //   "输入框钉底"就不成立（原型第一版踩过同一个坑）。
              height: "calc(100vh - 84px)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div className="card chat" style={{ flex: 1, minHeight: 0 }}>
              <CommentRail
                host="risk_matter"
                hostId={risk.id}
                comments={risk.comments.map((c) => ({
                  id: c.id,
                  parentId: c.parentId,
                  author: c.authorName,
                  body: c.body,
                  parts: c.parts,
                  createdAt: c.createdAt,
                  isEdited: c.isEdited,
                  attachments: c.attachments,
                }))}
                onDone={invalidate}
                readOnly={risk.isArchived}
                editable
              />
            </div>
          </div>
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
        onDone={invalidate}
        host="risk_matter"
        hostId={risk.id}
        node={editNode}
      />
      <OwnerDialog
        open={ownerOpen}
        onClose={() => setOwnerOpen(false)}
        current={risk.ownerId}
        onDone={invalidate}
        riskId={risk.id}
      />
      <DescriptionDialog
        open={descOpen}
        initial={risk.description}
        saving={saveDesc.isPending}
        onClose={() => setDescOpen(false)}
        onSave={(md) => saveDesc.mutate(md)}
      />
      {/* 详情页入口：源事实直接给详情 DTO（含当事人名单，列表页那行数据没有它） */}
      <ConvertDialog
        source={
          convertOpen
            ? {
                id: risk.id,
                code: risk.code,
                name: risk.name,
                level: risk.level,
                ownerName: risk.ownerName ?? undefined,
                parties: risk.parties.map((p) => ({ name: p.name, partyRole: p.partyRole })),
              }
            : null
        }
        onClose={() => setConvertOpen(false)}
        onOpenCase={(cid) => router.push(`/matters/${cid}`)}
      />
    </div>
  );
}

/**
 * 描述编辑弹层（MATT-57）。
 *
 * 草稿态归这里：编辑器的内容只在打开时以 `initial` 挂载一次（`{open && ...}` 让关闭即卸载，
 * 重开自然重挂到现值；`useEffect` 再把 draft 状态同步回来——两处都要，
 * 编辑器不重挂而 draft 重置的话，看到的和存的就是两份东西）。
 * 保存才 PATCH——编辑器每次 onChange 都回流给 Form 的话，光标会跳。
 * 校验沿用 PATCH 的口径（min 2 / max 5000）：markdown 的空白骨架（`### ` 之类）
 * 过不了 trim+min2，拒掉比存进去再渲染成一坨诚实。
 */
function DescriptionDialog({
  open,
  initial,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: string;
  saving: boolean;
  onClose: () => void;
  onSave: (markdown: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  // 每次打开都以现值重置草稿：上次"编辑后取消"不该把脏草稿留到下次（重开=重看现值）
  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);
  return (
    <Modal
      open={open}
      title="编辑描述"
      width={720}
      onCancel={onClose}
      okText="保存"
      okButtonProps={{
        loading: saving,
        disabled: draft.trim().length < 2,
      }}
      onOk={() => onSave(draft)}
      // 弹层里再嵌编辑器（BlockNote 的 `/` 菜单要算位置），关闭后焦点别抢回触发按钮。
      // antd 6：顶层 focusTriggerAfterClose 已弃用，挪进 focusable（本仓文档要求听弃用通知）
      focusable={{ focusTriggerAfterClose: false }}
    >
      {open && (
        <div style={{ maxHeight: "60vh", overflow: "auto" }}>
          <RichTextEditorLazy initialMarkdown={initial} onChange={setDraft} />
        </div>
      )}
    </Modal>
  );
}

/** 一个节点：名称 / 时间点 / 状态。按钮与案件侧同一套：编辑 / 完成 / 更多（取消、删除）。 */
function NodeRow({
  node,
  riskId,
  readOnly,
  onDone,
  onEdit,
}: {
  node: Risk["nodes"][number];
  riskId: string;
  readOnly: boolean;
  onDone: () => void;
  onEdit: () => void;
}) {
  const { message, modal } = AntdApp.useApp();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  /** 完成节点后展开的进展登记（可跳过，与案件侧同形） */
  const [progressOpen, setProgressOpen] = useState(false);
  const mut = useMutation({
    mutationFn: (body: { status: string; cancelReason?: string }) =>
      api.patch(`/api/risk-matters/${riskId}/nodes?nodeId=${node.id}`, body),
    onSuccess: () => {
      onDone();
      message.success("节点已更新");
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "操作失败"),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/risk-matters/${riskId}/nodes/${node.id}`),
    onSuccess: () => {
      onDone();
      message.success("节点已删除");
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "删除失败"),
  });
  const label = NODE_STATUS_LABELS[node.status as keyof typeof NODE_STATUS_LABELS] ?? node.status;

  return (
    <>
      <div>
        <Space orientation="vertical" size={4} style={{ width: "100%" }}>
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
          {node.remark ? (
            <span style={{ color: "var(--ink2)", fontSize: 12 }}>{node.remark}</span>
          ) : null}
          <span style={{ color: "var(--ink3)", fontSize: 12 }}>
            {/* 事项节点只有时间点：没有「起止」，也就没有「这段时间内」这种表达 */}
            {node.startTime ? calDate(node.startTime) : "时间待定"}
            {!node.isTimeConfirmed && node.startTime && " · 未确认"}
          </span>
          {node.cancelReason && (
            <span style={{ color: "var(--ink2)", fontSize: 12 }}>
              取消原因：{node.cancelReason}
            </span>
          )}
          {!readOnly &&
            (cancelling ? (
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
            ) : (
              <Space size={4} wrap>
                <Button size="small" type="link" onClick={onEdit}>
                  编辑
                </Button>
                {node.status === "in_progress" ? (
                  <Button
                    size="small"
                    type="link"
                    loading={mut.isPending}
                    onClick={() =>
                      modal.confirm({
                        title: "完成这个节点？",
                        content: "节点完成时会展开进展登记，请确认。",
                        okText: "完成",
                        cancelText: "取消",
                        onOk: async () => {
                          await mut.mutateAsync({ status: "completed" });
                          setProgressOpen(true);
                        },
                      })
                    }
                  >
                    完成
                  </Button>
                ) : null}
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "cancel", label: "取消节点", disabled: node.status === "cancelled" },
                      { key: "delete", label: "删除节点", danger: true },
                    ],
                    onClick: ({ key }) => {
                      if (key === "cancel") setCancelling(true);
                      if (key === "delete") {
                        modal.confirm({
                          title: "删除这个节点？",
                          content: "删除后不再提醒，也不出现在节点列表里。",
                          okText: "删除",
                          okButtonProps: { danger: true },
                          cancelText: "取消",
                          onOk: () => remove.mutateAsync(),
                        });
                      }
                    },
                  }}
                >
                  <Button size="small" type="link">
                    更多
                  </Button>
                </Dropdown>
              </Space>
            ))}
        </Space>
      </div>

      {/* 完成后的进展登记：可跳过，节点状态已经落了，不拿它当"完成的第二个条件" */}
      <ProgressLogDialog
        host="risk_matter"
        hostId={riskId}
        nodeId={String(node.id)}
        open={progressOpen}
        onClose={() => setProgressOpen(false)}
        onDone={onDone}
      />
    </>
  );
}

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
  // 可选处理人走 §4.1 的 `selectable-users`（**必须带事项 id**），不去问 `/api/meta`。
  // 原来这里问 `/api/meta?host=matter` 要 `users`，而那个接口的返回键只有
  // `actor / statuses / levels / tags / enums` ⇒ 恒为 undefined ⇒ 下拉永远是空的，
  // **界面上换不了处理人**。而"谁能被派活"是收窄后的核心约束（L2/L3 只能派给共现过的同事），
  // 所以这条数据源不能图省事从字典接口里凑。
  const { data: selectable, isPending: loadingUsers } = useQuery({
    queryKey: ["selectable-users", "risk_matter", riskId],
    queryFn: () =>
      api.get<{ users: { id: string; displayName: string; username: string }[] }>(
        `/api/risk-matters/${riskId}/selectable-users`,
      ),
  });
  const [value, setValue] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (v: string | null) => api.patch(`/api/risk-matters/${riskId}`, { ownerId: v }),
    onSuccess: (_d, v) => {
      onClose();
      message.success(v === null ? "已退回未指派" : "已变更经办人");
      onDone();
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "变更失败"),
  });

  return (
    <Modal
      open={open}
      title="变更经办人"
      onCancel={onClose}
      okText="保存"
      confirmLoading={mut.isPending}
      onOk={() => mut.mutate(value === undefined ? current : value)}
    >
      <Space orientation="vertical" size={10} style={{ width: "100%", marginTop: 12 }}>
        {/* 这里原来有一段弹窗顶部说明，讲「这是普通字段编辑 / 退回未指派会怎样」——
            按前端规范（副标题纪律 · 旁白，2026-10-12）属**讲规则**，不落四类落点之一，整段删除。
            「退回未指派」的后果改用 Select 的 title 承载（悬停才出，不占常驻版面）。

            空态文案也一并收窄：原文把服务端的收窄规则讲成了散文。
            空态只说**为什么为空**，那条约束不是给这个位置的提示。 */}
        <Select
          style={{ width: "100%" }}
          allowClear
          loading={loadingUsers}
          placeholder="选择处理人"
          title="清空即退回未指派，这条事项回到待处理池"
          value={value === undefined ? current : value}
          onChange={(v) => setValue(v ?? null)}
          options={(selectable?.users ?? []).map((u) => ({ value: u.id, label: u.displayName }))}
          notFoundContent={loadingUsers ? undefined : "没有可指派的同事"}
        />
      </Space>
    </Modal>
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

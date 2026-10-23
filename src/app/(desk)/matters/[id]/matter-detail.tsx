"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App as AntdApp,
  Avatar,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Dropdown,
  Empty,
  Flex,
  Form,
  Input,
  Listy,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { ArrowLeftOutlined, PlusOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";
import type { Dayjs } from "dayjs";

import { api, ApiFailure, useMeta, type MatterDetail as Matter } from "@/app/lib/client/api";
import { actorName, calDate, dateTime, fromNow, money } from "@/app/lib/client/format";
import { PageHeader } from "@/app/components/page-header";
import { ExpensePanel } from "@/app/components/expense-panel";
import { ExportFileButton } from "@/app/components/export-file-button";
import { FollowGroup } from "@/app/components/follow-group";
import { StatusMark, FlagMark } from "@/app/components/ui/status-mark";
import { DeadlineMark } from "@/app/components/ui/deadline-mark";
import { StateBlock } from "@/app/components/ui/state-block";
import { CommentBody } from "@/app/components/comment-body";
import { MentionInput } from "@/app/components/mention-input";
import { NodeDialog, type NodeSeed } from "@/app/components/node-dialog";
import {
  AttachmentChips,
  AttachmentPicker,
  CommentAttachmentList,
  useCommentAttachments,
} from "@/app/components/attachment-input";
import {
  applyServerIssues,
  rulesFor,
  validateAndFocusFirst,
} from "@/app/components/form/zod-rules";
import { progressSchema } from "@/shared/schema/hosts";
import { StatusDialog, type StatusTarget } from "@/app/components/status-dialog";
import {
  NOT_READY_TEXT,
  READINESS_LABELS,
  READINESS_TAB,
  READY_TEXT,
  STATE_LABEL,
  STATE_PILL,
  readinessNote,
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

/**
 * 详情页的页签名，**与下面 `Tabs` 的 `items[].key` 一一对应**（`?tab=` 的白名单）。
 *
 * 抽成常量而不是在 `initialTab` 里写六个字面量：列表页的行内快捷动作与详情页
 * 各写一份页签名，加一个页签时就会漏掉一边（漏的那一边表现为"点了停在节点页"）。
 */
const DETAIL_TABS = ["basic", "nodes", "people", "expenses", "log", "activity"] as const;

export function MatterDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { message } = AntdApp.useApp();
  const { data: meta } = useMeta("matter");
  const searchParams = useSearchParams();
  const [statusOpen, setStatusOpen] = useState(false);
  /**
   * 受控页签：归档就绪卡点一项要跳到对应页签（F2-26）。
   *
   * 初值读 `?tab=`（2026-10-19，为列表页的行内快捷动作而加）：列表行里的
   * 「进展 / 状态 / 程序」三条链接，唯一的差别就是落到哪个页签——不支持 `?tab=` 的话
   * 三条只能都指向同一页，用户点"进展"却停在「节点」上，那是"点了没反应"的另一种长相。
   *
   * 非法值与不带参数的首屏都回落 `basic`（2026-10-21 从 `nodes` 改过来）：URL 可以手改，
   * 这里不该因为一个拼错的 tab 白屏；而**首屏落在哪一签**是另一件事——原型
   * `matter-detail.html` 的 `.tabs` 里选中态在「基本信息」上，编号 / 状态 / 经办人 / 归档就绪
   * 这组"这是哪一件案子"的事实先于"接下来要做什么"被读到。带 `?tab=` 的快捷动作不受影响。
   */
  const initialTab = useMemo(() => {
    const t = searchParams.get("tab");
    return t && (DETAIL_TABS as readonly string[]).includes(t) ? t : "basic";
  }, [searchParams]);
  const [tab, setTab] = useState(initialTab);
  /** 新增/编辑节点共用同一个弹窗；`editNode` 为空 = 新增 */
  const [nodeDialogOpen, setNodeDialogOpen] = useState(false);
  const [editNode, setEditNode] = useState<NodeSeed | null>(null);
  const openNodeDialog = (node: NodeSeed | null) => {
    setEditNode(node);
    setNodeDialogOpen(true);
  };
  // 同一个组件实例上换了 `?tab=`（列表页点另一行的另一条快捷动作）要跟着切
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  /**
   * `?action=status`：列表行的「状态」快捷动作。
   *
   * 为什么不让它直接跳到一个"状态页签"：详情页没有这个页签——变更状态是一枚按钮开的弹窗。
   * 列表页那条链接的意图是"就在这一行动手"，所以进页就把弹窗打开，
   * 而不是把人送到详情页再让他找那枚按钮（那是两次动作）。
   *
   * 只在**首次**自动打开：用户关掉弹窗之后 URL 还挂着 `?action=status`，
   * 若跟着 URL 反复打开，关不掉的弹窗比不放这个入口更糟。
   */
  const autoStatus = useRef(searchParams.get("action") === "status");
  useEffect(() => {
    if (!autoStatus.current) return;
    autoStatus.current = false;
    setStatusOpen(true);
  }, []);

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
          {n.remark ? (
            <div className="mut3" style={{ fontSize: 11 }}>
              {n.remark}
            </div>
          ) : null}
        </>
      ),
    },
    {
      title: "类型",
      dataIndex: "nodeType",
      width: 96,
      // 手工节点没有类型（2026-10-23 起）：空着给「—」，不塞一个假的"其他"
      render: (v: string | null) => (
        <span className="mut" style={{ fontSize: 12 }}>
          {v ?? "—"}
        </span>
      ),
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
          <span className="mut3" style={{ fontSize: 12 }}>
            时间未确认
          </span>
        ),
    },
    {
      title: "到期",
      width: 118,
      render: (_, n) =>
        n.status === "in_progress" ? (
          <DeadlineMark iso={n.deadlineTime} />
        ) : (
          <span className="mut3">—</span>
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
            className={n.status === "cancelled" ? "mut3" : undefined}
            style={{
              fontSize: 12,
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
      render: (_, n) => (
        <NodeActions
          node={n}
          matterId={m.id}
          readOnly={m.isArchived}
          onDone={invalidate}
          onEdit={() =>
            openNodeDialog({
              id: n.id,
              name: n.name,
              remark: n.remark,
              startTime: n.startTime,
            })
          }
        />
      ),
    },
  ];

  return (
    // 原型 `matter-detail.html` 的两列：左列内容，右列 356px 常驻评论栏（sticky）。
    <div className="detail">
      <div className="stack">
        {/*
        返回案件列表。原型把它放在顶栏（`.topbar .back`），但顶栏由 `AppShell` 统一渲染、
        只写当前页名（MATT-98：顶栏不是链接）。所以与功能配置详情页同一处理——
        落在页头标题上方 —— 全站详情页的返回入口因此长在同一个位置。
        形态走 `.backlink`（两处详情页共用），不再各写一份行内 style。
      */}
        <Link href="/matters" className="backlink">
          <ArrowLeftOutlined />
          返回案件列表
        </Link>

        <PageHeader
          title={m.name}
          /**
           * 原型 `matter-detail.html` 的页头是「编号 + 案名」一起当标题读的
           * （`AJ-20260819-002 苏州万顺机械 承揽合同纠纷`）。编号是主键不是副标题，
           * 所以走 `PageHeader` 的 `code`（与标题同行），不开第二行。
           */
          code={m.internalCode}
          status={<StatusMark host="matter" code={m.status} />}
          flags={m.isArchived ? <FlagMark>已归档</FlagMark> : null}
          /*
          「已结案」这枚 flag 撤了（2026-10-21）：状态药片念的就是"已结案"，旁边再挂一枚
          同词的 Tag 是把紧邻已经写着的东西说第二遍。结案日期本身在下面的字段表里，
          那里才是它的落点。
        */
          actions={
            <>
              {/* 关注组（2026-10-22 用户裁定「收藏和关注的口径一致」）：左段是我关不关注、
                右段是「n 人关注」的名单，两者是同一条关系（`staff_role='follower'`）。
                原先那颗 ⭐ 走的是私人收藏，会出现"我点了关注、名单里却没有我"——已并入这里。 */}
              <FollowGroup
                host="matter"
                hostId={m.id}
                followers={m.staff
                  .filter((s) => s.staffRole === "follower")
                  .map((s) => ({ id: s.id, userId: s.userId, name: s.displayName }))}
                meId={meta?.actor.userId ?? ""}
                canManage={
                  !!meta &&
                  (meta.actor.dataScope === "all" ||
                    m.ownerId === meta.actor.userId ||
                    m.creatorId === meta.actor.userId)
                }
                isArchived={m.isArchived}
                onChanged={refetchDetail}
              />
              <ExportFileButton host="matter" hostId={m.id} code={m.internalCode} />
              <button type="button" className="btn" onClick={() => setStatusOpen(true)}>
                变更状态
              </button>
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
                <button type="button" className="btn danger" disabled={softDelete.isPending}>
                  删除
                </button>
              </Popconfirm>
            </>
          }
        />

        <Tabs
          activeKey={tab}
          onChange={setTab}
          /**
           * 页签条**在卡片之外**（原型 `matter-detail.html` 的 `.tabs` 与 `.card` 同级）：
           * 五个页签切换的是「这一页看哪一块」，不是"某张卡里的内容"——
           * 装进卡片会把卡片当成外层容器，页签一换整张卡的其余部分（卡头、边框）看着也在变。
           * 原来这里是 `<div className="card"><div className="card-b"><Tabs …>`，
           * 每个面板的内容再各自裸排；现在面板自己带卡，页签条归于页面。
           *
           * `tabBarStyle` 的底部外边距补的是原型 `.tabs { margin-bottom: 18px }`：
           * antd 的默认留白比它小，卡片会贴上来。
           */
          tabBarStyle={{ marginBottom: 16 }}
          items={[
            {
              key: "basic",
              label: "基本信息",
              children: (
                <Flex vertical gap={12}>
                  {/*
                  基本信息（2026-10-22 用户给出的行序，**放在本页签第一位**）：
                  案号 / 类型 · 受理法院 / 我方诉讼地位 · 案件进程 / 案件金额 ·
                  最近进展（独占一行）· 创建时间 / 更新时间。

                  块里只留这 9 项。其余字段并非不存在，而是各有更合适的落点：
                  内部编号在页头（与标题同行，全站详情页同一处）、案由/等级/立案在列表与录入表单、
                  结案日期与归档时间属归档流程、裁判文书属归档就绪。把它们再在详情里列一遍，
                  就是同一事实的第二处显示。
                */}
                  <Card size="small" title="基本信息">
                    <Descriptions
                      size="small"
                      /**
                       * 两对一行（列标签 + 值，再一组）：原型 `.dl` 的
                       * `grid-template-columns: 104px 1fr 104px 1fr` 就是这个节奏。
                       * 三列时一行塞三对，标签与值的对应关系在一行里被压得太紧。
                       */
                      column={2}
                      items={[
                        {
                          key: "caseNo",
                          label: "案号",
                          children: <span className="num">{m.caseNo}</span>,
                        },
                        {
                          key: "type",
                          label: "类型",
                          children: meta?.enums.caseTypes[m.caseType] ?? m.caseType,
                        },
                        { key: "court", label: "受理法院", children: m.court ?? "—" },
                        {
                          key: "role",
                          label: "我方诉讼地位",
                          children:
                            meta?.enums.litigationRoles[m.litigationRole] ?? m.litigationRole,
                        },
                        {
                          key: "procedure",
                          label: "案件进程",
                          children: meta?.enums.procedures[m.procedure] ?? m.procedure,
                        },
                        {
                          key: "amount",
                          label: "案件金额",
                          children: (
                            <>
                              <span className="num">{money(m.amount)}</span> 元
                            </>
                          ),
                        },
                        {
                          // 最近进展是"这条案子最后一次动"的唯一读数，独占一行：
                          // 与别的字段并排会被读成"又一项属性"，而它是时间线上的一个点
                          key: "progress",
                          label: "最近进展",
                          span: 2,
                          children: dateTime(m.lastProgressAt),
                        },
                        { key: "createdAt", label: "创建时间", children: dateTime(m.createdAt) },
                        { key: "updatedAt", label: "更新时间", children: dateTime(m.updatedAt) },
                      ]}
                    />
                    <Typography.Paragraph
                      style={{ fontSize: 13, whiteSpace: "pre-wrap", marginBottom: 0 }}
                    >
                      {m.description?.trim() ? m.description : "没有填写基本情况。"}
                    </Typography.Paragraph>
                  </Card>

                  {/* 「归档就绪」三项（F2-26）。**服务端算好给**（详情 DTO 的
                  archiveReadiness），前端不重算——判定只实现一次，
                  列表的「已结案缺材料」筛选是它的另一个出口。
                  点一项跳到该补录的页签（READINESS_TAB）。 */}
                  {m.archiveReadiness ? (
                    /**
                     * 归档就绪（F2-26）。**形态照原型 `matter-detail.html` 的 `.tb` 表格**
                     * （条件 / 状态 / 说明 三列，列宽 180 / 120 / 伸缩），不再是卡底一排 Tag：
                     * 三行条件本来是一组"逐条核对"的读数，摊成横向胶囊时读起来像标签，
                     * 竖着成行才对得上"一条一个状态"的扫读节奏。
                     *
                     * 卡头右侧仍是那句共用口径（与归档弹窗同一对常量）——原型那里写的是
                     * "3 项条件"，但那是个计数；本仓要说的是"齐不齐"，且两个显示面不能各说各话。
                     *
                     * `unavailable` 那一项的说明**进表格的第三列**，不再挂在卡底当散文：
                     * 同一个意思，放在"这一行"的上下文里它是事实，单独铺在卡底就是旁白。
                     */
                    <Card
                      size="small"
                      title="归档就绪"
                      styles={{ body: { padding: 0 } }}
                      extra={
                        <span className="mut" style={{ fontSize: 12 }}>
                          {m.archiveReadiness.missing.length === 0 ? READY_TEXT : NOT_READY_TEXT}
                        </span>
                      }
                    >
                      <table className="tb">
                        <colgroup>
                          <col style={{ width: 180 }} />
                          <col style={{ width: 120 }} />
                          <col />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>条件</th>
                            <th>状态</th>
                            <th>说明</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.archiveReadiness.checks.map((c) => {
                            // 只有"缺 + 有页签可去"才装成可点：已具备的行点了没有要补的东西，
                            // 灰的那行（附件页签不存在）点进去也无处补录
                            const fixTab = c.state === "missing" ? READINESS_TAB[c.key] : null;
                            return (
                              <tr
                                key={c.key}
                                style={{ cursor: fixTab ? "pointer" : "default" }}
                                onClick={fixTab ? () => setTab(fixTab) : undefined}
                              >
                                <td>{READINESS_LABELS[c.key]}</td>
                                <td>
                                  <span className={STATE_PILL[c.state]}>
                                    <i />
                                    {STATE_LABEL[c.state]}
                                  </span>
                                </td>
                                <td className="ellip">{readinessNote(c, READINESS_TAB[c.key])}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </Card>
                  ) : null}

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
                    <Card size="small" title={`来源风险 (${m.sourceRisks.length})`}>
                      {m.sourceRisks.length > 0 ? (
                        <Listy
                          items={m.sourceRisks}
                          rowKey={(s) => s.id}
                          itemRender={(s) => (
                            <Flex justify="space-between" align="center" gap={8}>
                              <Space size={6}>
                                <Tag style={{ marginInlineEnd: 0 }}>{s.code}</Tag>
                                <span style={{ fontSize: 13 }}>{s.name}</span>
                                <span className="mut3" style={{ fontSize: 12 }}>
                                  {meta?.enums.riskTypes?.[s.type] ?? s.type}
                                </span>
                                {s.isArchived ? (
                                  <span className="mut3" style={{ fontSize: 12 }}>
                                    （已归档）
                                  </span>
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
                </Flex>
              ),
            },
            {
              key: "nodes",
              label: `时间节点 (${m.nodes.length})`,
              children: (
                <div>
                  {/* 手动新增只出现在这个面板里（它属于节点列表，不属于页头）。归档后只读。 */}
                  {!m.isArchived && (
                    <Flex justify="flex-end" style={{ marginBottom: 8 }}>
                      <Button
                        size="small"
                        icon={<PlusOutlined />}
                        onClick={() => openNodeDialog(null)}
                      >
                        新增节点
                      </Button>
                    </Flex>
                  )}
                  {m.nodes.length ? (
                    <Card size="small" styles={{ body: { padding: 0 } }}>
                      <Table<Node>
                        size="small"
                        rowKey={(n) => n.id}
                        columns={nodeColumns}
                        dataSource={m.nodes}
                        pagination={false}
                      />
                    </Card>
                  ) : (
                    <Card size="small">
                      <StateBlock
                        title="还没有时间节点"
                        hint="节点是提醒的唯一入口：确认时间并设了期限，才会进工作台的到期清单。"
                        action={
                          m.isArchived ? undefined : (
                            <Button size="small" onClick={() => openNodeDialog(null)}>
                              新增节点
                            </Button>
                          )
                        }
                      />
                    </Card>
                  )}
                </div>
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
                              <span className="mut3" style={{ fontSize: 12 }}>
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
                            <div className="mut3" style={{ fontSize: 11 }}>
                              {meta?.enums.partyTypes[p.type] ?? p.type}
                              {p.idNumber ? ` · ${p.idNumber}` : ""}
                            </div>
                            <span className="mut3" style={{ fontSize: 12 }}>
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
              children: (
                <Card size="small">
                  <ExpensePanel host="matter" hostId={m.id} archived={m.isArchived} />
                </Card>
              ),
            },
            {
              // key 仍是 `log`：列表行「进展」那条快捷动作用的就是 `?tab=log`，
              // 换名不换键，那条链接不会因为这次搬评论而落到回落页签上。
              key: "log",
              label: `进展 (${m.progress.length})`,
              children: (
                <Card size="small">
                  <ProgressTab matterId={m.id} progress={m.progress} onDone={invalidate} />
                </Card>
              ),
            },
            {
              key: "activity",
              label: `活动日志 (${m.activity.length})`,
              children: (
                <Card size="small">
                  {m.activity.length ? (
                    <Listy
                      items={m.activity}
                      rowKey={(a) => a.id}
                      itemRender={(a) => (
                        <Flex gap={12} align="baseline" wrap>
                          <span className="num mut3" style={{ fontSize: 12, minWidth: 148 }}>
                            {dateTime(a.createdAt)}
                          </span>
                          <Tag variant="filled" style={{ fontSize: 11 }}>
                            {meta?.enums.auditActions[a.action] ?? a.action}
                          </Tag>
                          <span style={{ fontSize: 13 }}>
                            {/* `actorName()` 负责把 null（系统自动动作）说成人话，见 format.ts */}
                            {actorName(a.operator)}
                            {a.reason ? <span className="mut3"> · {a.reason}</span> : ""}
                          </span>
                        </Flex>
                      )}
                    />
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有活动记录" />
                  )}
                </Card>
              ),
            },
          ]}
        />

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

        <NodeDialog
          open={nodeDialogOpen}
          onClose={() => setNodeDialogOpen(false)}
          onDone={invalidate}
          host="matter"
          hostId={m.id}
          node={editNode}
        />
      </div>

      {/* 右栏：评论。写接口与快捷键口径与原「过程记录」页签里的同一份，只是换到常驻位置 */}
      <aside aria-label="评论">
        <div className="card chat">
          <CommentRail matterId={m.id} comments={m.comments} onDone={invalidate} />
        </div>
      </aside>
    </div>
  );
}

/**
 * 节点行内动作（2026-10-23 用户给的按钮表）：
 * **编辑 / 完成（二次确认，提示会展开进展登记）/ 更多（取消、删除）**。
 *
 * 三态之后没有「开始」与「改待定 / 标已确认」：
 *   · 节点一创建就在跑，没必要先点一下"开始"；
 *   · 时间变成必填字段，编辑对话框就是改时间的地方，不再有"待定/已确认"这组命令。
 *
 * 归档宿主只读（Q3）：整组动作换成「—」，服务端也会拒。
 */
function NodeActions({
  node,
  matterId,
  readOnly,
  onDone,
  onEdit,
}: {
  node: Node;
  matterId: string;
  readOnly: boolean;
  onDone: () => void;
  onEdit: () => void;
}) {
  const { message, modal } = AntdApp.useApp();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [progressOpen, setProgressOpen] = useState(false);

  const mut = useMutation({
    mutationFn: (body: { status: string; cancelReason?: string }) =>
      api.post(`/api/matters/${matterId}/nodes/${node.id}`, body),
    onSuccess: () => {
      onDone();
      message.success("节点已更新");
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "操作失败"),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/matters/${matterId}/nodes/${node.id}`),
    onSuccess: () => {
      onDone();
      message.success("节点已删除");
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "删除失败"),
  });

  if (readOnly) return <span className="mut3">—</span>;

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
    <>
      <Space size={4}>
        <Button size="small" type="text" onClick={onEdit}>
          编辑
        </Button>
        {node.status === "in_progress" ? (
          <Button
            size="small"
            type="primary"
            disabled={mut.isPending}
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
                  content: "删除后不再提醒，也不出现在时间节点列表里。",
                  okText: "删除",
                  okButtonProps: { danger: true },
                  cancelText: "取消",
                  onOk: () => remove.mutateAsync(),
                });
              }
            },
          }}
        >
          <Button size="small" type="text">
            更多
          </Button>
        </Dropdown>
      </Space>

      {/* 完成后的进展登记：可跳过，节点状态已经落了，不拿它当"完成的第二个条件" */}
      <ProgressLogDialog
        matterId={matterId}
        open={progressOpen}
        onClose={() => setProgressOpen(false)}
        onDone={onDone}
      />
    </>
  );
}

/**
 * 「过程记录」页签：只剩**案件进展**（MATT-59）。
 *
 * 评论原先在这一签里与进展左右并排，2026-10-21 搬去右栏常驻（原型 `matter-detail.html`
 * 的 `.chat`）——评论的读写频次远高于进展，藏在第六个页签里等于没有。
 */
function ProgressTab({
  matterId,
  progress,
  onDone,
}: {
  matterId: string;
  progress: Matter["progress"];
  onDone: () => void;
}) {
  const { data: meta } = useMeta("matter");
  const [progressOpen, setProgressOpen] = useState(false);

  return (
    <>
      <Flex justify="space-between" align="center" style={{ paddingBlock: 12 }}>
        <div style={{ fontSize: 13 }}>案件进展 ({progress.length})</div>
        <Button size="small" onClick={() => setProgressOpen(true)}>
          写进展
        </Button>
      </Flex>
      {progress.length ? (
        <Listy
          items={progress}
          rowKey={(p) => p.id}
          itemRender={(p) => (
            // ⚠ 老 `List.Item` 是 `display:flex` + `space-between`，所以这几块一直是**横排**的：
            // 迁移**保持同形**（`Listy` 的 item 是块级，不套 Flex 就会静默变成纵排）。
            <Flex justify="space-between" align="center" gap={8}>
              <Flex justify="space-between" gap={8} style={{ flex: 1 }}>
                <span className="mut" style={{ fontSize: 12 }}>
                  {meta?.enums.progressTypes[p.progressType] ?? p.progressType}
                </span>
                <span className="num mut3" style={{ fontSize: 12 }}>
                  {calDate(p.progressDate)}
                </span>
              </Flex>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{p.content}</div>
              {p.nextPlan ? (
                <div className="mut3" style={{ fontSize: 12 }}>
                  下一步：{p.nextPlan}
                </div>
              ) : null}
              <div className="mut3" style={{ fontSize: 11 }}>
                {p.author}
              </div>
            </Flex>
          )}
        />
      ) : (
        <StateBlock
          title="还没有进展记录"
          hint="日常推进、法院动作这类过程记录登记在这里；记一条会刷新「最近进展」。"
        />
      )}

      <ProgressLogDialog
        matterId={matterId}
        open={progressOpen}
        onClose={() => setProgressOpen(false)}
        onDone={onDone}
      />
    </>
  );
}

type Comment = Matter["comments"][number];

/**
 * 右栏「评论」（原型 `matter-detail.html` 的 `.chat`：头 + 可滚消息区 + 钉底输入区）。
 *
 * ## 为什么是常驻一栏而不是一个页签
 *
 * 评论是"这件案子正在被怎么说"的活文本，读它的次数远高于任何一块字段；原先它和进展
 * 并排塞在第六个页签里，未读列表页的人根本看不到它。原型把它立成右栏，读与写都在
 * 眼前：消息区自己滚，输入框钉底。
 *
 * ## 三层结构各自的高度口径
 *
 * `.chat` 是 flex 列：头与输入区不伸缩、`.chat-b` 吃余量并 `overflow:auto`。
 * `min-height:0` 是滚动的真正前提（少了它整栏会被消息撑高，钉底当场失效）——
 * 数值链与 sticky 的实测坑一并记在 `globals.css` 的 `.detail` 段。
 */
function CommentRail({
  matterId,
  comments,
  onDone,
}: {
  matterId: string;
  comments: Comment[];
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [body, setBody] = useState("");
  /** 附件：选完立刻传，发布时只带已经传完的 id（见 `attachment-input.tsx`） */
  const att = useCommentAttachments("matter", matterId);

  const mut = useMutation({
    mutationFn: () =>
      api.post(`/api/matters/${matterId}/comments`, {
        body: body.trim(),
        attachments: att.readyIds,
      }),
    onSuccess: () => {
      setBody("");
      att.reset();
      onDone();
      message.success("评论已发布");
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "提交失败"),
  });

  const threads = useCommentThreads(comments);

  return (
    <>
      <div className="chat-h">
        <h3>评论</h3>
        <span className="sp" />
        {/* 条数用 `.num` 等宽字形：新评论进来时数字变化不推动栏宽 */}
        <span className="num">{comments.length} 条</span>
      </div>

      <div className="chat-b">
        {threads.length ? (
          threads.map((g) => (
            <div key={g.day}>
              <div className="chat-day">{g.day}</div>
              {g.items.map((t) => (
                <div key={t.root.id}>
                  <CommentMessage c={t.root} />
                  {t.replies.map((r) => (
                    <div className="msg-reply" key={r.id}>
                      <CommentMessage c={r} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))
        ) : (
          <div className="chat-empty">还没有评论。</div>
        )}
      </div>

      <div className="chat-f">
        <AttachmentChips items={att.items} onRemove={att.remove} />
        <MentionInput
          host="matter"
          hostId={matterId}
          rows={3}
          maxLength={2000}
          value={body}
          onChange={setBody}
          // Ctrl + Enter 发布：写评论的手停在键盘上时，不该为了提交去摸鼠标
          onPressEnter={(e) => {
            if ((e.ctrlKey || e.metaKey) && body.trim() && !mut.isPending && !att.busy) {
              e.preventDefault();
              mut.mutate();
            }
          }}
          placeholder="记录一个结论、一次沟通，或一个待确认的点；用 @姓名 提及同事"
        />
        <div className="bar">
          <AttachmentPicker onFiles={att.add} disabled={mut.isPending} />
          <span className="hint">Ctrl + Enter 发布</span>
          <span className="sp" />
          <span className="hint num">
            {body.length} / <span className="num">2000</span>
          </span>
          <Button
            type="primary"
            size="small"
            disabled={!body.trim() || mut.isPending || att.busy}
            onClick={() => mut.mutate()}
          >
            发布
          </Button>
        </div>
      </div>
    </>
  );
}

/** 一条消息：首字头像 + 「作者 · 时间」+ 正文。提及的分段由 `CommentBody` 负责。 */
function CommentMessage({ c }: { c: Comment }) {
  return (
    <div className="msg">
      <span className="av" aria-hidden="true">
        {c.author.slice(0, 1)}
      </span>
      <div className="bd">
        <div className="meta">
          <b>{c.author}</b>
          <span className="t">{fromNow(c.createdAt)}</span>
        </div>
        <div className="txt">
          <CommentBody body={c.body} parts={c.parts} />
        </div>
        <CommentAttachmentList items={c.attachments} />
      </div>
    </div>
  );
}

/**
 * 评论 → **按天分组的"根 + 回复"**（原型 `.chat-day` + `.msg-reply`）。
 *
 * 三条口径：
 *   · 正序（旧→新）：消息流的读法，与"最新在上"的列表相反——这一栏是**读上下文**的地方；
 *   · 只一层：回复挂在根下，回复的回复也并到同一个根（服务端只允许一层，界面不写无限递归）；
 *   · 父评论不在载荷里（被删）的孤儿**当根画**：让评论原地消失比画错层级更糟。
 */
function useCommentThreads(comments: Comment[]) {
  return useMemo(() => {
    const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const byId = new Map(sorted.map((c) => [c.id, c]));
    const roots = new Map<string, { root: Comment; replies: Comment[] }>();
    for (const c of sorted) {
      // 往上走到真正的根（最多两层，循环只为兜住脏数据，不构成无限递归）
      let parentId = c.parentId;
      while (parentId && byId.get(parentId)?.parentId) parentId = byId.get(parentId)!.parentId;
      const anchor = parentId && byId.has(parentId) ? parentId : c.id;
      const slot = roots.get(anchor) ?? { root: byId.get(anchor) ?? c, replies: [] as Comment[] };
      if (c.id !== anchor) slot.replies.push(c);
      roots.set(anchor, slot);
    }
    const groups: { day: string; items: { root: Comment; replies: Comment[] }[] }[] = [];
    for (const t of roots.values()) {
      const day = calDate(t.root.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.items.push(t);
      else groups.push({ day, items: [t] });
    }
    return groups;
  }, [comments]);
}

/**
 * 写一条案件进展（MATT-59）。表、E19 值域、写端点早已齐备，这里补的是界面入口。
 *
 * 校验规则从 `shared/schema/hosts` 的 `progressSchema` 推导（`rulesFor`），
 * 提交时服务端用**同一个 schema** 再判一次 —— 前端不手写第二套规则（禁令⑧）。
 */
function ProgressLogDialog({
  matterId,
  open,
  onClose,
  onDone,
}: {
  matterId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const { data: meta } = useMeta("matter");
  const [form] = Form.useForm<{
    progressType: string;
    progressDate: Dayjs;
    content: string;
    nextPlan?: string;
  }>();

  const mut = useMutation({
    mutationFn: (v: {
      progressType: string;
      progressDate: string;
      content: string;
      nextPlan?: string;
    }) => api.post<{ id: string }>(`/api/matters/${matterId}/progress`, v),
    onSuccess: () => {
      onClose();
      message.success("进展已记录");
      onDone();
    },
    onError: (e) => {
      if (e instanceof ApiFailure) {
        applyServerIssues(form, e.issues);
        message.error(e.message);
        return;
      }
      message.error("提交失败");
    },
  });

  return (
    <Modal
      open={open}
      title="写进展"
      okText="记录"
      cancelText="取消"
      confirmLoading={mut.isPending}
      destroyOnHidden
      onCancel={onClose}
      onOk={async () => {
        const v = await validateAndFocusFirst(form);
        if (!v) return;
        // DatePicker 可被清空；onOk 是 async 而 antd 不 await 它，直接 `.format` 抛错
        // 的表现是「点了没反应」——先拦一次，别赌 required 规则一定在
        if (!v.progressDate) {
          form.setFields([{ name: "progressDate", errors: ["请选择发生日期"] }]);
          return;
        }
        mut.mutate({
          progressType: v.progressType,
          // 表单里存 Dayjs，提交前一处转 `YYYY-MM-DD`：`progressDate` 是 `date` 列，
          // 服务端 schema 也只收这个形状
          progressDate: v.progressDate.format("YYYY-MM-DD"),
          content: v.content,
          nextPlan: v.nextPlan ?? "",
        });
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Form.Item
          name="progressType"
          label="进展类型"
          rules={rulesFor(progressSchema, ["progressType"])}
        >
          <Select
            placeholder="选择进展类型"
            options={Object.entries(meta?.enums.progressTypes ?? {}).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="progressDate"
          label="发生日期"
          rules={rulesFor(progressSchema, ["progressDate"])}
        >
          <DatePicker style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="content" label="进展内容" rules={rulesFor(progressSchema, ["content"])}>
          <Input.TextArea rows={3} maxLength={4000} placeholder="发生了什么" />
        </Form.Item>
        <Form.Item name="nextPlan" label="下一步" rules={rulesFor(progressSchema, ["nextPlan"])}>
          <Input.TextArea rows={2} maxLength={2000} placeholder="接下来打算做什么" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

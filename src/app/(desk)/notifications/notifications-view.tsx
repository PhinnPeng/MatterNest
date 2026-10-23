"use client";

import Link from "next/link";
import { useState } from "react";
import {
  App as AntdApp,
  Badge,
  Button,
  Flex,
  Listy,
  Pagination,
  Segmented,
  Skeleton,
  Tag,
  Tooltip,
} from "antd";

import { StateBlock } from "@/app/components/ui/state-block";
import { INK } from "@/app/theme/brand";
import { DEFAULT_PAGE_SIZE } from "@/shared/schema/list-query";
import { formatBusinessTime } from "@/shared/time/zh-cn";
import {
  hostHref,
  useMarkRead,
  useNotifications,
  type NotificationItem,
} from "@/app/lib/client/api-notifications";

/**
 * 通知中心（F4-1/F4-2/F4-3/F4-7）。
 *
 * ## 2026-10-19：从六列表格换成为什么「按通知读」的列表
 *
 * 用户的要求是「使用 AntD，整体优化通知消息列表页」。动手前先量了旧形态，三个缺陷
 * 都是**表格这个形状本身**带来的，不是配色问题：
 *
 *   1. **正文被塞进一格**。通知的核心是一句话（标题 + 正文摘要），而表格的列宽预算
 *      是按"短字段"排的；1265px 内容区里六列一挤，「类型」列被压成
 *      「30 / 天 / 无 / 改 / 新」竖排单字 —— 那已经不是可读的东西了。
 *   2. **时间 / 状态 / 操作被挤出视口**。`<colgroup>` 的固定列宽合计超过容器宽度，
 *      于是最右边的三列在首屏看不见，而"标记已读"恰好是最右边那一列。
 *   3. **「关联对象」说不出是哪条**。DTO 原先只带 `hostKind`/`hostId`，前端只能写
 *      "查看案件"这个**动作**。可通知的全部用处是"这条说的是哪个案子"——
 *      说不出是哪条的通知，收件人只能点进去才知道要不要点。
 *
 * 所以这一页现在是**列表**（`Listy`，antd 6 里 `List` 的替代品）而不是数据表：
 * 一行 = 一条通知，标题 + 正文摘要 + 一行元信息（类型 / 未读 / 宿主 / 时间）+ 行尾动作。
 * 列宽挤兑的问题在这个形状下不存在，正文也终于有它该有的宽度。
 *
 * ## 与禁令⑧的关系（为什么这里可以不用 `DataTable`）
 *
 * 禁令⑧ 的原话是「**表格**一律经 `DataTable` 并强制服务端分页/排序/筛选」，
 * 它的真实理由是**权限**（客户端全量拉取再本地筛等于绕过 `ScopeResolver`），
 * 不是"列表长得像表格"。
 *
 * 这一页仍然逐条满足那个理由，只是形态不是表格：
 *   · 分页**仍在服务端**（`useNotifications` 只取当页，`Pagination` 只改页码）；
 *   · `pageSize` 仍受 `MAX_PAGE_SIZE` 约束（服务端 schema 直接拒 >100）；
 *   · 前端**没有任何排序/筛选计算**——「未读/全部」是查询参数，不是本地过滤。
 *
 * 反过来，硬把它留在 `DataTable` 里才是错的：那会为了形状一致，继续把一句话正文
 * 压进一个固定宽度的列。**形状服从内容**，这是这一页换形态的唯一理由。
 *
 * ## 三条与本票 AC 直接对应的渲染决定（未变）
 *
 * 1. **不可见降级占位**（权限草案 §7.1）：占位行**保留在列表里**、标题是
 *    「无权查看的记录」、不发任何摘要字段、也不给跳转。服务端已经把 `body`/`hostId`
 *    抹成 null 了，这里再画一遍"看不到"的样式——**不隐藏整行**是裁定原文：
 *    隐藏会被当成数据丢失而去追问，占位能自助解释。
 * 2. **时间一律走 `formatBusinessTime`**：数据库会话钉 UTC，直接格式化会差 8 小时
 *    （"开庭提醒写着昨天"）。全站只有这一个日期出口。
 * 3. **未读徽标与列表同源**：`unread` 是同一个响应里的字段，不另开一个查询——
 *    两个数来自不同判定时的不一致查不出来。
 *
 * ## 为什么分页状态在组件里而不在 URL 上
 *
 * 列表页的惯例是"状态落 URL"（刷新、后退、发链接给同事对得上同一视图）。
 * 通知中心是**个人收件箱**：把"我的通知第 2 页"发给同事没意义（他看到的永远是他自己的），
 * 所以这里用组件态。真要分享的是**某一条通知指向的记录**，那走行内那个宿主链接。
 */
export function NotificationsView() {
  const { message } = AntdApp.useApp();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useNotifications({ page, pageSize: DEFAULT_PAGE_SIZE, unreadOnly });
  const markRead = useMarkRead();

  const items = q.data?.items ?? [];
  const unread = q.data?.unread ?? 0;
  const total = q.data?.total ?? 0;

  // 页码可能因「全部已读 / 切档」落到空页：服务端已经限制在有效范围，这里只做兜底展示
  const pageSize = q.data?.pageSize ?? DEFAULT_PAGE_SIZE;
  const current = q.data?.page ?? page;

  function markAllRead() {
    markRead.mutate(
      { all: true },
      { onSuccess: (r) => message.success(`已标记 ${r.updated} 条为已读`) },
    );
  }

  return (
    <div className="stack">
      <div className="card ncard">
        {/*
          工具条并进卡片（2026-10-21 live 定稿 · 合并档）。

          原来这一行浮在卡片外：分段器与「全部已读」离它操作的列表隔着一整张卡，
          「有时发现不了」是距离带来的，不是控件本身的问题。现在三者同属一个盒子——
          卡片自己的头带：左分段器、右读数与批量动作，下方一条 1px 细线，再往下就是行。

          读数「共 N 条」从原来的 `.card-h` 搬进这条头带：卡片头只剩一行，
          两处读数会逼着用户问「哪个是真的」。`topbar` 的 `h1` 已经是「通知」，
          头带不重复写页名（副标题纪律）。
        */}
        <div className="nhead">
          <Segmented
            value={unreadOnly ? "unread" : "all"}
            onChange={(v) => {
              setUnreadOnly(v === "unread");
              setPage(1);
            }}
            options={[
              {
                label: (
                  <span className="nseg-label">
                    未读<span className="nseg-num">{unread}</span>
                  </span>
                ),
                value: "unread",
              },
              { label: "全部", value: "all" },
            ]}
          />
          <span className="sp" />
          <span className="mut3" style={{ fontSize: 12 }}>
            共 {total} 条
          </span>
          <Tooltip title={unread === 0 ? "没有未读通知" : undefined}>
            <span>
              {/* 禁用态包一层 span，否则 Tooltip 拿不到 disabled 按钮上的事件 */}
              <Button
                onClick={markAllRead}
                disabled={unread === 0 || markRead.isPending}
                loading={markRead.isPending}
              >
                全部已读
              </Button>
            </span>
          </Tooltip>
        </div>

        {q.isError ? (
          <div className="card-b">
            <StateBlock
              tone="error"
              title="通知读取出错"
              hint={q.error instanceof Error ? q.error.message : undefined}
              action={
                <Button size="small" onClick={() => q.refetch()}>
                  重试
                </Button>
              }
            />
          </div>
        ) : q.isLoading ? (
          <div className="card-b">
            <Skeleton active paragraph={{ rows: 3 }} title={false} />
          </div>
        ) : items.length === 0 ? (
          <StateBlock
            title={unreadOnly ? "没有未读通知" : "还没有通知"}
            hint={
              unreadOnly
                ? "切到「全部」可以看到全部通知。"
                : "事项的状态变更、新评论会推给关注人与创建人。"
            }
          />
        ) : (
          <Listy
            items={items}
            rowKey={(r) => r.id}
            styles={{ item: { padding: 0 } }}
            itemRender={(r) => (
              <NotificationRow
                item={r}
                marking={markRead.isPending}
                onMarkRead={() =>
                  markRead.mutate(
                    { ids: [r.id] },
                    { onSuccess: () => message.success("已标记为已读") },
                  )
                }
              />
            )}
          />
        )}

        {total > pageSize ? (
          <Flex justify="flex-end" style={{ padding: "12px 16px" }}>
            <Pagination
              current={current}
              pageSize={pageSize}
              total={total}
              showSizeChanger={false}
              showTotal={(n) => `共 ${n} 条`}
              onChange={(p) => setPage(p)}
            />
          </Flex>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 一条通知。**未读靠三个通道同时表达**（字重 / 圆点 + 词 / 行底色），
 * 不是只染个颜色——色觉障碍与灰阶打印都会让"红点=未读"失效。
 *
 * 布局：主区（标题 / 正文 / 元信息）+ 行尾动作。动作**不换行**，正文两行截断，
 * 于是每行高度稳定在 3 行以内，长正文不会把列表撑成一条一条的大块。
 */
function NotificationRow({
  item,
  marking,
  onMarkRead,
}: {
  item: NotificationItem;
  marking: boolean;
  onMarkRead: () => void;
}) {
  const href = hostHref(item);

  return (
    <Flex
      gap={16}
      align="flex-start"
      className={item.isRead ? "nrow" : "nrow nrow-unread"}
      style={{
        padding: "12px 16px",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* 标题：未读 500 / 已读 400 + 弱一档墨色，与行底色同向 */}
        <div
          style={{
            fontSize: 13,
            fontWeight: item.isRead ? 400 : 500,
            color: item.isRead ? INK.secondary : INK.body,
            overflowWrap: "anywhere",
          }}
        >
          {item.title}
        </div>

        {/* 占位行的 body 是 null，这一支自然不渲染 —— 摘要字段一个都不发 */}
        {item.body ? (
          <div
            className="mut3"
            style={{
              fontSize: 12,
              marginTop: 2,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
            title={item.body}
          >
            {item.body}
          </div>
        ) : null}

        <Flex align="center" gap={10} wrap="wrap" style={{ marginTop: 6 }}>
          <Tag style={{ marginInlineEnd: 0 }}>{item.visible ? item.eventTypeLabel : "不可见"}</Tag>

          {/*
            未读/已读：`Badge status` 是**圆点 + 词**（色不作唯一通道），
            与全站 `.pill` 的语义一致，但用的是 antd 件。
          */}
          <Badge
            status={item.isRead ? "default" : "processing"}
            text={item.isRead ? "已读" : "未读"}
          />

          {/* 宿主：可见时给"编号 + 名称"（它本身就是"是哪条"的答案，不再补一个"案件/事项"——
              编号前缀已经说明了，补一句就是副标题纪律里说的"复述紧邻已经写着的东西"） */}
          {href && item.hostCode ? (
            <Link href={href} style={{ fontSize: 12, color: "var(--accent)" }}>
              {item.hostCode} {item.hostName}
            </Link>
          ) : (
            <span className="ph" style={{ fontSize: 12 }}>
              对象超出你的数据范围
            </span>
          )}

          <span className="num mut3" style={{ fontSize: 12 }}>
            {formatBusinessTime(item.createdAt)}
          </span>
        </Flex>
      </div>

      <div style={{ flex: "0 0 auto", paddingTop: 1 }}>
        {item.isRead ? (
          <span className="mut3" style={{ fontSize: 12 }} aria-hidden="true">
            —
          </span>
        ) : (
          <Button type="link" size="small" loading={marking} onClick={onMarkRead}>
            标记已读
          </Button>
        )}
      </div>
    </Flex>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { App as AntdApp, Badge, Button, Flex, Switch, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";

import { INK } from "@/app/theme/brand";
import { DataTable } from "@/app/components/ui/data-table/DataTable";
import { StateBlock } from "@/app/components/ui/state-block";
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
 * ## 三条与本票 AC 直接对应的渲染决定
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
 * 通知中心是**个人收件箱**：把"我的通知第 2 页"发给同事没有意义（他看到的永远是他自己的），
 * 所以这里用组件态。真要分享的是**某一条通知指向的记录**，那走行点击的跳转。
 */
export function NotificationsView() {
  const router = useRouter();
  const { message } = AntdApp.useApp();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useNotifications({ page, pageSize: DEFAULT_PAGE_SIZE, unreadOnly });
  const markRead = useMarkRead();

  const items = q.data?.items ?? [];
  const columns = useMemo<TableColumnsType<NotificationItem>>(
    () => [
      {
        key: "created_at",
        title: "时间",
        width: 150,
        render: (_v, r) => (
          <span className="num" style={{ fontSize: 12, color: INK.muted }}>
            {formatBusinessTime(r.createdAt)}
          </span>
        ),
      },
      {
        key: "title",
        title: "通知",
        render: (_v, r) => (
          <Flex vertical gap={2} style={{ minWidth: 0 }}>
            <Typography.Text
              strong={!r.isRead}
              style={{ fontSize: 13, color: r.visible ? undefined : INK.muted }}
            >
              {r.title}
            </Typography.Text>
            {/* 占位行的 body 是 null，这一支自然不渲染 —— 摘要字段一个都不发 */}
            {r.body ? (
              <Typography.Text style={{ fontSize: 12, color: INK.secondary }}>
                {r.body}
              </Typography.Text>
            ) : null}
          </Flex>
        ),
      },
      {
        key: "kind",
        title: "类别",
        width: 110,
        render: (_v, r) =>
          r.visible ? (
            <Tag variant="filled" style={{ fontSize: 11, marginInlineEnd: 0 }}>
              {r.eventTypeLabel}
            </Tag>
          ) : (
            <Tag variant="filled" color="default" style={{ fontSize: 11, marginInlineEnd: 0 }}>
              不可见
            </Tag>
          ),
      },
      {
        key: "read",
        title: "状态",
        width: 72,
        render: (_v, r) =>
          r.isRead ? (
            <span style={{ fontSize: 12, color: INK.muted }}>已读</span>
          ) : (
            <Badge status="processing" text={<span style={{ fontSize: 12 }}>未读</span>} />
          ),
      },
    ],
    [],
  );

  return (
    <DataTable<NotificationItem>
      title="通知"
      columns={columns}
      rows={items}
      rowKey={(r) => r.id}
      total={q.data?.total ?? 0}
      page={q.data?.page ?? page}
      pageSize={q.data?.pageSize ?? DEFAULT_PAGE_SIZE}
      loading={q.isLoading}
      onPageChange={setPage}
      onSortChange={() => undefined}
      onRowOpen={(r) => {
        const href = hostHref(r);
        if (href) router.push(href);
      }}
      empty={
        q.isError ? (
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
        ) : (
          <StateBlock
            title={unreadOnly ? "没有未读通知" : "还没有通知"}
            hint={
              unreadOnly
                ? "关掉「只看未读」可以看到全部通知。"
                : "事项的状态变更、新评论会推给关注人与创建人。"
            }
          />
        )
      }
      tools={
        <Flex align="center" gap={10}>
          <Badge count={q.data?.unread ?? 0} size="small" overflowCount={99}>
            <span style={{ fontSize: 12, color: INK.secondary }}>未读</span>
          </Badge>
          <Flex align="center" gap={4}>
            <Switch
              size="small"
              checked={unreadOnly}
              onChange={(v) => {
                setUnreadOnly(v);
                setPage(1);
              }}
            />
            <span style={{ fontSize: 12, color: INK.secondary }}>只看未读</span>
          </Flex>
          <Button size="small" loading={q.isFetching} onClick={() => q.refetch()}>
            刷新
          </Button>
          <Button
            size="small"
            disabled={(q.data?.unread ?? 0) === 0}
            loading={markRead.isPending}
            onClick={() =>
              markRead.mutate(
                { all: true },
                { onSuccess: (r) => message.success(`已标记 ${r.updated} 条为已读`) },
              )
            }
          >
            全部已读
          </Button>
        </Flex>
      }
    />
  );
}

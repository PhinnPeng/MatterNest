"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { App as AntdApp } from "antd";
import type { TableColumnsType } from "antd";

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
 *
 * ## 2026-10-18（MATT-99）：换 canon
 *
 * 「未读 / 全部」从 Switch 换成原型 `.seg` 两档（同一件事：`unreadOnly` 过滤，
 * 只是形态从"开关 + 徽标"改成"分段 + 计数"）；页头右侧 `.btn` 全部已读；
 * 表格与分页走 `DataTable`（canon `.tb` / `.pager`）。
 * 「刷新」不再单独放：`DataTable` 没有任何刷新插槽之外的理由，而列表在窗口重新聚焦时
 * 由 react-query 自动重取——原型页头也只有「全部已读」一个动作。
 */
export function NotificationsView() {
  const router = useRouter();
  const { message } = AntdApp.useApp();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useNotifications({ page, pageSize: DEFAULT_PAGE_SIZE, unreadOnly });
  const markRead = useMarkRead();

  const items = q.data?.items ?? [];
  const unread = q.data?.unread ?? 0;
  const total = q.data?.total ?? 0;

  const columns = useMemo<TableColumnsType<NotificationItem>>(
    () => [
      {
        key: "title",
        title: "通知",
        render: (_v, r) => (
          <div style={{ minWidth: 0 }}>
            <div
              className={r.isRead ? "mut" : undefined}
              style={{ fontWeight: r.isRead ? 400 : 500 }}
            >
              {r.title}
            </div>
            {/* 占位行的 body 是 null，这一支自然不渲染 —— 摘要字段一个都不发 */}
            {r.body ? (
              <div className="mut3 ellip" style={{ fontSize: 12 }} title={r.body}>
                {r.body}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        key: "kind",
        title: "类型",
        width: 104,
        render: (_v, r) =>
          r.visible ? (
            <span className="tag">{r.eventTypeLabel}</span>
          ) : (
            <span className="tag">不可见</span>
          ),
      },
      {
        key: "host",
        title: "关联对象",
        width: 400,
        ellipsis: true,
        render: (_v, r) => {
          const href = hostHref(r);
          if (!href) {
            // 降级行：对象超出数据范围。事实句，不解释原因（canon-spec 的边界呈现）
            return <span className="ph">对象超出你的数据范围</span>;
          }
          // DTO 只带宿主 kind/id，没有编号与名称，所以这里给的是"去哪看"而不是"是哪条"
          return (
            <a
              className="btn link"
              href={href}
              onClick={(e) => {
                e.preventDefault();
                router.push(href);
              }}
            >
              {r.hostKind === "risk_matter" ? "查看事项" : "查看案件"}
            </a>
          );
        },
      },
      {
        key: "created_at",
        title: "时间",
        width: 120,
        render: (_v, r) => (
          <span className="num mut3" style={{ fontSize: 12 }}>
            {formatBusinessTime(r.createdAt)}
          </span>
        ),
      },
      {
        key: "read",
        title: "状态",
        width: 88,
        render: (_v, r) =>
          r.isRead ? (
            <span className="pill gray">
              <i />
              已读
            </span>
          ) : (
            <span className="pill due">
              <i />
              未读
            </span>
          ),
      },
      {
        key: "action",
        title: "操作",
        width: 104,
        render: (_v, r) =>
          r.isRead ? (
            <span className="mut3" style={{ fontSize: 12 }}>
              —
            </span>
          ) : (
            <button
              type="button"
              className="btn link"
              onClick={() =>
                markRead.mutate(
                  { ids: [r.id] },
                  { onSuccess: () => message.success("已标记为已读") },
                )
              }
            >
              标记已读
            </button>
          ),
      },
    ],
    [markRead, message, router],
  );

  return (
    <div className="stack">
      <div className="pagehead">
        <span className="seg">
          <button
            type="button"
            className={unreadOnly ? "on" : undefined}
            onClick={() => {
              setUnreadOnly(true);
              setPage(1);
            }}
          >
            未读 {unread}
          </button>
          <button
            type="button"
            className={unreadOnly ? undefined : "on"}
            onClick={() => {
              setUnreadOnly(false);
              setPage(1);
            }}
          >
            全部
          </button>
        </span>
        <span className="sp" />
        <button
          type="button"
          className="btn"
          disabled={unread === 0 || markRead.isPending}
          onClick={() =>
            markRead.mutate(
              { all: true },
              { onSuccess: (r) => message.success(`已标记 ${r.updated} 条为已读`) },
            )
          }
        >
          全部已读
        </button>
      </div>

      <DataTable<NotificationItem>
        title="通知"
        columns={columns}
        rows={items}
        rowKey={(r) => r.id}
        total={total}
        page={q.data?.page ?? page}
        pageSize={q.data?.pageSize ?? DEFAULT_PAGE_SIZE}
        loading={q.isLoading}
        onPageChange={setPage}
        onSortChange={() => undefined}
        empty={
          q.isError ? (
            <StateBlock
              tone="error"
              title="通知读取出错"
              hint={q.error instanceof Error ? q.error.message : undefined}
              action={
                <button type="button" className="btn sm" onClick={() => q.refetch()}>
                  重试
                </button>
              }
            />
          ) : (
            <StateBlock
              title={unreadOnly ? "没有未读通知" : "还没有通知"}
              hint={
                unreadOnly
                  ? "切到「全部」可以看到全部通知。"
                  : "事项的状态变更、新评论会推给关注人与创建人。"
              }
            />
          )
        }
      />
    </div>
  );
}

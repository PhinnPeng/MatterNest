import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/**
 * 通知中心的客户端读取层（MATT-41 / T4）。
 *
 * 单独一个文件而不是塞进 `api.ts`：那边是**全站共用**的读取层（session / meta / 列表 DTO），
 * 而这里是 M4 一条线自己的契约。放一起会让每次改通知字段都动到所有人都 import 的文件。
 *
 * `unread` 与列表**同一次请求**返回：分两次拿会出现"列表里 3 条未读、徽标写 5"，
 * 而那两个数来自不同的可见性判定时，这种不一致根本查不出来（服务层注释同此）。
 */
export type NotificationItem = {
  id: string;
  eventType: string;
  eventTypeLabel: string;
  isRead: boolean;
  readAt: string | null;
  /** ISO 瞬时。展示一律过 `formatBusinessTime`（Asia/Shanghai） */
  createdAt: string;
  /** false = 降级占位行（收件人已失权）。此时 title 是「无权查看的记录」、body/hostId 为 null */
  visible: boolean;
  title: string;
  body: string | null;
  hostKind: "matter" | "risk_matter" | null;
  hostId: string | null;
  targetType: string | null;
};

export type NotificationPage = {
  items: NotificationItem[];
  total: number;
  page: number;
  pageSize: number;
  unread: number;
};

export function useNotifications(q: { page: number; pageSize: number; unreadOnly: boolean }) {
  return useQuery({
    queryKey: ["notifications", q.page, q.pageSize, q.unreadOnly],
    queryFn: () =>
      api.get<NotificationPage>(
        `/api/notifications?page=${q.page}&pageSize=${q.pageSize}${q.unreadOnly ? "&unreadOnly=1" : ""}`,
      ),
    // 30 秒：通知中心自己会触发一次轮询（服务端 pump），刷太勤等于把库当消息队列敲
    staleTime: 30_000,
  });
}

/**
 * 标记已读。`all=true` 与 `ids` 互斥（服务端 schema 会拒两个都给）。
 *
 * 成功后 `invalidateQueries(["notifications"])`：未读徽标与列表是同一个查询键前缀，
 * 一次失效两处都刷新——只失效列表会让徽标停在旧数字上。
 */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { all?: boolean; ids?: string[] }) =>
      api.post<{ ok: boolean; updated: number }>("/api/notifications/read", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

/** 宿主详情页路径。不可见行没有 hostId，调用方要先判 */
export function hostHref(item: NotificationItem): string | null {
  if (!item.visible || !item.hostId) return null;
  return item.hostKind === "risk_matter"
    ? `/risk-matters/${item.hostId}`
    : `/matters/${item.hostId}`;
}

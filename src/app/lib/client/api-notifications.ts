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
  /** 宿主编号与名称（`AJ-20260918-005` / 案名）。**只在可见行上有值**，占位行是 null */
  hostCode: string | null;
  hostName: string | null;
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
 * 未读计数（F4-2），喂侧栏那一枚徽标。
 *
 * ## 为什么走 `unread-count` 而不复用列表查询
 *
 * 外壳只需要一个数字。用列表查询意味着"为了拿一个数拉一整页通知"，
 * 而且会把 `["notifications", page, pageSize, unreadOnly]` 这份键多插一处——
 * 两处各自持有分页态，迟早不一致。专有端点从第一天就是为这个场景开的
 * （`api/notifications/unread-count/route.ts` 的头注）。
 *
 * ## 为什么要轮询（而列表那边刻意不轮询）
 *
 * 徽标存在的**全部意义**是"在他点开通知中心之前就告诉他"（F4-2 原话）。
 * 不轮询的话，徽标只在挂载那一次准，之后整个会话钉在旧数字上——
 * 那正好把它存在的理由取消掉。60 秒是取舍：端点每次都跑一次 pump，
 * 而 pump 是幂等的（`dedupe_key` 吸收），代价只是白跑几次索引扫描。
 *
 * `refetchIntervalInBackground` 保持默认 `false`：标签不在前台时定时器不跑，
 * 于是"没人在看"的时候连那点白跑也不发生。
 *
 * ## 与 `useMarkRead` 的失效是怎么对上的
 *
 * 标记已读后 `invalidateQueries(["notifications"])` 按**前缀**匹配，这一条
 * `["notifications","unread-count"]` 也在其下，所以列表与徽标一起刷新——
 * 这正是"徽标与列表同源"落到查询键上的形态。
 */
export function useUnreadCount() {
  return useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => api.get<{ unread: number }>("/api/notifications/unread-count"),
    staleTime: 30_000,
    refetchInterval: 60_000,
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

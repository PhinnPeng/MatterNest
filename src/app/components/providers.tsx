"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiFailure } from "@/app/lib/client/api";

/**
 * 全站唯一的 QueryClient 提供者，挂在**根布局**上。
 *
 * 三条实现约束：
 *   · `useState(() => new QueryClient())` 而不是模块级单例 —— Next 的服务端跨请求复用模块，
 *     模块级实例会把上一个用户的缓存漏给下一个请求（react-query 官方点名的 Next 坑）；
 *   · **4xx 一律不重试**：400 是"这个请求本身不成立"、404 是"对你不可见"，
 *     重试等于在门已答"没有"之后再敲一次（与 `lib/client/api.ts` 里"401 不再跳第二次"同一个理由）。
 *     更要紧的是重试**之间** react-query 会去问 `onlineManager`：内嵌/后台标签里它可能报 offline，
 *     查询就停在 `fetchStatus: "paused"`、`isPending` 恒真 —— 界面表现是"骨架屏转到天荒地老"。
 *     本轮 0×0 面板实测踩过，读缓存看到 `status:"pending" / fetchStatus:"paused"` 才定位到；
 *   · 5xx 与真正的网络错误仍重试 1 次（内网映射口抖动是真实存在的）。
 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (count, err) =>
              err instanceof ApiFailure && err.status < 500 ? false : count < 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

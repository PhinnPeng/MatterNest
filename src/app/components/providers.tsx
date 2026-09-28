"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn.js";

import { ApiFailure } from "@/app/lib/client/api";
import { antdThemeConfig } from "@/app/theme/antd";

dayjs.locale("zh-cn");

/**
 * 全站唯一的三个 Provider：QueryClient → antd 样式抽取 → 主题/语言 → `App` 上下文。
 *
 * 顺序是有原因的：`AntdRegistry` 必须在 `ConfigProvider` **外面**，
 * 否则 SSR 抽出来的 style 拿不到主题 token，首屏会闪一下无样式的控件（FOUC）。
 *
 * 三条不变的东西：
 *   · `useState(() => new QueryClient())` 而不是模块级单例——Next 服务端跨请求复用模块，
 *     模块级实例会把上一个用户的缓存漏给下一个请求；
 *   · **4xx 一次都不重试**（400 是"这个请求本身不成立"、404 是"对你不可见"）。
 *     另一半理由是 react-query 只在两次重试**之间**问 `onlineManager`，
 *     内嵌/后台标签里报 offline 时查询会停在 `fetchStatus:"paused"`、`isPending` 恒真，
 *     界面就是"骨架屏转到天荒地老"；
 *   · 语言与日期库一起钉：antd 组件文案走 `zhCN`，日期走 `dayjs` 的 `zh-cn`。
 *     上一版用 date-fns，迁到 antd 后**必须换**——antd 的 DatePicker 只认 dayjs，
 *     两套日期库同时在场会让"月份显示成 September"这种事故变得很难归因。
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

  return (
    <QueryClientProvider client={client}>
      <AntdRegistry>
        <ConfigProvider locale={zhCN} theme={antdThemeConfig}>
          {/* `App` 提供 message/notification/modal 的 context 版实例——
              静态方法在 React 19 + 严格模式下读不到主题与 locale，官方就是用它替代 */}
          <App>{children}</App>
        </ConfigProvider>
      </AntdRegistry>
    </QueryClientProvider>
  );
}

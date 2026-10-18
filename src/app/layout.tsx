import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/app/components/providers";
import { ThemeBootstrap } from "@/app/components/theme-bootstrap";
import { tokensCss } from "@/app/theme/brand";
import { Xray } from "@stinsky/xray";
import "./globals.css";

/**
 * 根布局。**禁令⑥：页面壳不得预取业务数据** —— 这里只允许出现静态外壳与全局样式，
 * 任何业务读取都发生在鉴权后的 `/api/**`（禁令⑤）。
 * 因此本文件（以及所有 page.tsx）不得 import `@/app/lib/server/**` 与 `db`。
 *
 * ⚠ 这里刻意**不用** `next/font/google`。`shadcn init` 会自作主张加一行
 * `Geist({ subsets: ["latin"] })`，而 `next/font/google` 是**构建期**去 fonts.gstatic.com 取字体——
 * 本系统是企业内网私有化部署（技术选型 §6），构建机不一定有外网，加这行等于给 `pnpm build`
 * 引入一个外部依赖与一种"构建时好、部署时炸"的失败模式。字体一律走 `globals.css` 的系统字体栈。
 *
 * ## 两段与外观有关的东西（MATT-98 / ADR-0006）
 *
 * 1. **令牌**：`tokensCss()` 生成 `:root{…}` 与 `html.dark{…}` 两段，交给 React 19 的
 *    `precedence` 提升（React 会把它放进 `<head>`，服务端渲染时也在同一次响应里）。
 *    于是"明暗两值"只有一处来源（`theme/brand.ts`），`globals.css` 只写 `var(--…)`。
 * 2. **首帧脚本**：`ThemeBootstrap` 用 `useServerInsertedHTML` 把它放进 `</head>` 之前，
 *    且它是**同步**执行的 —— 在浏览器画第一帧之前就把 `html.dark` 打上（有已存偏好时）。
 *    等 hydration 再改就会先闪一整屏浅色（US 4）。为什么不是 `next/script` 的
 *    `beforeInteractive`、以及为什么不能顺手把外观也写进 React 状态，分别见
 *    `components/theme-bootstrap.tsx` 与 `theme/appearance.ts` 的头注；
 *    `suppressHydrationWarning` 是因为这次类名改动发生在 React 接管之前，
 *    React 不该把它当成"水合不一致"。
 */
export const metadata: Metadata = {
  title: "MatterNest",
  description: "企业风险事项与案件全生命周期管理（内部系统）",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className="font-sans" suppressHydrationWarning>
      <body className="antialiased">
        {/* `href` / `precedence` 是 React 19 的样式提升协议：给它一个标识与优先级，
            它才会被放进 `<head>`（而不是留在 body 里当成普通节点）。 */}
        <style
          href="mn-theme-tokens"
          precedence="default"
          dangerouslySetInnerHTML={{ __html: tokensCss() }}
        />
        <ThemeBootstrap />
        <Providers>{children}</Providers>
        {/* 开发期源码定位浮层（悬停显路径 / 点击跳编辑器）。生产不渲染：
            组件本身会被 tree-shake，这里再显式 gate 一层，确保内网生产页里连切换按钮都不出现。 */}
        {process.env.NODE_ENV !== "production" ? <Xray /> : null}
      </body>
    </html>
  );
}

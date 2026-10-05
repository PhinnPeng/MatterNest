import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/app/components/providers";
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
 */
export const metadata: Metadata = {
  title: "MatterNest",
  description: "企业风险事项与案件全生命周期管理（内部系统）",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className="font-sans">
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
        {/* 开发期源码定位浮层（悬停显路径 / 点击跳编辑器）。生产不渲染：
            组件本身会被 tree-shake，这里再显式 gate 一层，确保内网生产页里连切换按钮都不出现。 */}
        {process.env.NODE_ENV !== "production" ? <Xray /> : null}
      </body>
    </html>
  );
}

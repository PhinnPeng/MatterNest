import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

/**
 * 根布局。**禁令⑥：页面壳不得预取业务数据** —— 这里只允许出现静态外壳与全局样式，
 * 任何业务读取都发生在鉴权后的 `/api/**`（禁令⑤）。
 * 因此本文件（以及所有 page.tsx）不得 import `@/app/lib/server/**` 与 `db`。
 */
export const metadata: Metadata = {
  title: "MatterNest",
  description: "律所风险事项与案件全生命周期管理（内部系统）",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

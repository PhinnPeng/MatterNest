import type { Metadata } from "next";
import { Suspense } from "react";
import { ImportView } from "./import-view";

export const metadata: Metadata = { title: "批量导入 · MatterNest" };

/**
 * 批量导入（P14 / F7-4 / MATT-67）的**页面壳**：只挂 metadata 与 Suspense，
 * 一个业务请求都不发（禁令⑥）。真数据由 `ImportView` 经 `/api/import/**` 取
 * （鉴权在 handler 内做，禁令⑤）。
 *
 * ## 路由为什么是 `(desk)/config/import` 而不是 PRD 写的 `/settings/import`
 *
 * MATT-44 的范围外发现 1 记过这条错位，本票按**代码事实**裁定：
 *   · `AppShell`（左侧主菜单 + 顶栏）只挂在 `(desk)/layout.tsx` 上；顶层 `src/app/settings/`
 *     **不在 (desk) 组内**，拿不到导航壳、菜单也不会高亮；
 *   · 系统设置面在代码里就是 `(desk)/config`（只读「配置字典」页）与 `(desk)/users`，
 *     spec §4.2 里那列 `/settings/*` 是**建议值，从未落地**。
 * 所以导入页落在 `(desk)/config/import`，URL 是 `/config/import`。
 * ⚠ 这是"按代码事实 + AppShell 继承约束"的裁定，**需要人确认**；不是把 PRD 改掉。
 */
export default function ConfigImportPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <ImportView />
    </Suspense>
  );
}

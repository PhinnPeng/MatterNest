import type { Metadata } from "next";
import { Suspense } from "react";
import { ReportsView } from "./reports-view";

export const metadata: Metadata = { title: "报表 · MatterNest" };

/**
 * 报表页壳（禁令⑥：不预取业务数据，读数全部由 `ReportsView` 经 `/api/reports` 取）。
 *
 * `Suspense` 不是装饰：`ReportsView` 用 `useSearchParams()`（在办 / 已归档落在 URL 上，
 * 刷新与"把这份读数发给同事"才对得上同一个视图），Next 会把整棵子树降级成动态渲染，
 * 缺 boundary 时 `pnpm build` 直接报错（与 `/archive` 同一个理由）。
 */
export default function ReportsPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <ReportsView />
    </Suspense>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";

import { RecentProgressView } from "./recent-progress-view";

export const metadata: Metadata = { title: "最近进展 · MatterNest" };

/**
 * 页面壳（禁令⑥：不预取业务数据）。
 *
 * `Suspense` 是 `useSearchParams()` 的硬要求（否则 `pnpm build` 直接报
 * "useSearchParams() should be wrapped in a suspense boundary"）。
 */
export default function RecentProgressPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <RecentProgressView />
    </Suspense>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";
import { ArchiveView } from "./archive-view";

export const metadata: Metadata = { title: "已归档 · MatterNest" };

/**
 * 归档页壳（禁令⑥：不预取业务数据）。
 *
 * `Suspense` 不是装饰：`ArchiveView` 用 `useSearchParams()`（宿主、分页都落在 URL 上），
 * Next 会把整棵子树降级成动态渲染，缺 boundary 时 `pnpm build` 直接报错。
 */
export default function ArchivePage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <ArchiveView />
    </Suspense>
  );
}

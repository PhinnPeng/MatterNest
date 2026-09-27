import type { Metadata } from "next";
import { Suspense } from "react";
import { MattersView } from "./matters-view";

export const metadata: Metadata = { title: "案件 · MatterNest" };

/**
 * 页面壳（禁令⑥：不预取业务数据）。
 *
 * 外层那个 `Suspense` 不是为了好看：客户端组件用 `useSearchParams()` 时，
 * Next 会把整棵子树降级成动态渲染，否则 `pnpm build` 直接报
 * "useSearchParams() should be wrapped in a suspense boundary"。
 * 这里给的是**壳级**的 fallback，所以真正等的是网络回来的那张表。
 */
export default function MattersPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <MattersView />
    </Suspense>
  );
}

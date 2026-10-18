import type { Metadata } from "next";
import { Suspense } from "react";
import { ConfigView } from "./config-view";

/**
 * 功能配置入口页的页面壳：只挂 metadata 与 Suspense（禁令⑥，不发业务请求）。
 *
 * `ConfigView` 现在是**纯静态的导航页**（五张卡片指向 14 个细项），理论上去掉 Suspense
 * 也能跑；保留它是因为壳的形状与其余页一致，且将来若入口要显示每组的项数（库里的行数）
 * 就会重新需要 Suspense（那是一次 `useSearchParams`/查询的引入）。
 */
export const metadata: Metadata = { title: "功能配置 · MatterNest" };

export default function ConfigPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <ConfigView />
    </Suspense>
  );
}

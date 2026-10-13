import type { Metadata } from "next";
import { Suspense } from "react";
import { PartiesView } from "./parties-view";

export const metadata: Metadata = { title: "当事人 · MatterNest" };

/**
 * 当事人列表的**页面壳**：只挂 metadata 与 Suspense，一个业务请求都不发（禁令⑥）。
 * 真数据由 `PartiesView` 经 `/api/parties` 取（鉴权在 handler 内做，禁令⑤）。
 */
export default function PartiesPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <PartiesView />
    </Suspense>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";
import { MatterDetail } from "./matter-detail";

export const metadata: Metadata = { title: "案件详情 · MatterNest" };

/** 页面壳：`params` 只用来定位，不查库（禁令⑥/⑤ —— 读一律走鉴权后的 `/api/**`）。 */
export default async function MatterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <MatterDetail id={id} />
    </Suspense>
  );
}

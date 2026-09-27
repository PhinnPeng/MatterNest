import type { Metadata } from "next";
import { Suspense } from "react";
import { RisksView } from "./risks-view";

export const metadata: Metadata = { title: "风险事项 · MatterNest" };

export default function RiskMattersPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <RisksView />
    </Suspense>
  );
}

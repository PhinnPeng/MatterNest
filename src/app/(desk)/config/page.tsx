import type { Metadata } from "next";
import { Suspense } from "react";
import { ConfigView } from "./config-view";

export const metadata: Metadata = { title: "配置字典 · MatterNest" };

export default function ConfigPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <ConfigView />
    </Suspense>
  );
}

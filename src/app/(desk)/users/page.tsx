import type { Metadata } from "next";
import { Suspense } from "react";
import { UsersView } from "./users-view";

export const metadata: Metadata = { title: "用户与角色 · MatterNest" };

export default function UsersPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <UsersView />
    </Suspense>
  );
}

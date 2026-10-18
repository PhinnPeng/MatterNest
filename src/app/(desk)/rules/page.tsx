import type { Metadata } from "next";
import { Suspense } from "react";
import { RulesView } from "./rules-view";

/**
 * 自动化规则页（P12 / F5-7，2026-10-18）。
 *
 * 页面壳只做两件事：挂 metadata、给出 Suspense 边界。**不查库**
 * （禁令⑥/⑤：读一律走鉴权后的 `/api/**`）。
 *
 * 路由落在 `(desk)/rules` 而不是 PRD 写的 `/settings/automation`：
 * `AppShell`（主菜单 + 顶栏）只挂在 `(desk)/layout.tsx` 上，顶层 `src/app/settings/`
 * 拿不到导航壳。这条口径 MATT-72 的 2026-10-17 评论已经核过，同 `(desk)/config`、
 * `(desk)/users`、`(desk)/roles` 三处代码事实一致。
 */
export const metadata: Metadata = {
  title: "自动化规则 · MatterNest",
};

export default function RulesPage() {
  return (
    <Suspense fallback={<div className="card" style={{ minHeight: 320 }} />}>
      <RulesView />
    </Suspense>
  );
}

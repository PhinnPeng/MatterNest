import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CONFIG_KIND_LABELS, configKindFromParam } from "@/shared/schema/config";
import { ConfigKindView } from "./config-kind-view";

/**
 * 功能配置细项页（**一个带参数的路由，14 个细项共用**；规格勘误第 8 条已裁）。
 *
 * ## 为什么是 `/config/[kind]` 而不是 14 个静态段
 *
 * `canon-spec.md` 第 132 行的节标题自己写着「14 页，**形态统一**」——14 个近乎相同的文件
 * 是 `code-reuse-thinking-guide` 要治的重复；接口侧也已经是 `/api/config/[kind]`，
 * 页面与接口同形，`kind` 的取值域单源（`shared/schema/config.ts`）。
 *
 * ## `[kind]` 的合法值 = 14 个细项（**比可写的 5 个宽**）
 *
 * 7 个闭集枚举 + 2 个无承载细项**仍有页面**（页面上明写为什么改不了），只是不走接口。
 * 所以这里判的是 `CONFIG_KINDS` 全集；**非法 kind 一律 404**（`notFound()`，
 * 与"不可见即 404"同一措辞，也是唯一 404 出口）。
 *
 * 页面壳只做两件事：把 `kind` 解析成细项（解析不了就 404）、挂 metadata。
 * **不查库**（禁令⑥/⑤：读一律走鉴权后的 `/api/**`）。
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ kind: string }>;
}): Promise<Metadata> {
  const { kind } = await params;
  const resolved = configKindFromParam(kind);
  return {
    title: resolved ? `${CONFIG_KIND_LABELS[resolved]} · MatterNest` : "功能配置 · MatterNest",
  };
}

export default async function ConfigKindPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const resolved = configKindFromParam(kind);
  if (!resolved) notFound();
  return (
    <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-muted" />}>
      <ConfigKindView kind={resolved} />
    </Suspense>
  );
}

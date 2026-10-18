import type { Metadata } from "next";
import { ImportView } from "./import-view";

export const metadata: Metadata = { title: "批量导入 · MatterNest" };

/**
 * 批量导入（P14 / F7-4 / MATT-67）的**页面壳**：只挂 metadata，一个业务请求都不发
 * （禁令⑥）。真数据由 `ImportView` 经 `/api/import/**` 取（鉴权在 handler 内做，禁令⑤）。
 *
 * ## MATT-102：这一页已**降级为「最近导入 + 报告找回」**，并留住当事人入口
 *
 * 案件 / 事项的导入入口搬到各自页头的弹层按钮（类型由入口页锁定）。当事人在本页页头
 * 保留一个导入按钮 —— 它没有宿主页可挂（`mn_party` 跨宿主共享），删掉就等于三张模板少一张。
 * 这一页保留下来还兼着「关掉弹层后报告还有个地址能回来拿」。导航里已无它（MATT-98 移除），
 * 从弹层成功态的链接进。视图改用不到 `useSearchParams` 了，所以页壳也不再需要 `Suspense`。
 *
 * ## 路由为什么是 `(desk)/config/import` 而不是 PRD 写的 `/settings/import`
 *
 * MATT-44 的范围外发现 1 记过这条错位，本票按**代码事实**裁定：
 *   · `AppShell`（左侧主菜单 + 顶栏）只挂在 `(desk)/layout.tsx` 上；顶层 `src/app/settings/`
 *     **不在 (desk) 组内**，拿不到导航壳、菜单也不会高亮；
 *   · 系统设置面在代码里就是 `(desk)/config`（功能配置：入口 + 14 细项页）与 `(desk)/users`，
 *     spec §4.2 里那列 `/settings/*` 是**建议值，从未落地**。
 * 所以导入页落在 `(desk)/config/import`，URL 是 `/config/import`。
 */
export default function ConfigImportPage() {
  return <ImportView />;
}

import type { HostType } from "@/shared/enums/targets";

/**
 * 宿主的界面/端点映射（案件 `matter` 与事项 `risk_matter` 共用）。
 *
 * 这两个值此前各写一份：评论栏、附件面板、工作台、两个详情页的 `host === "matter" ? …`
 * 一共四套并行三元。改一处漏一处不会报错，只会让同一件事在两个页面走不同的端点。
 */

/** 参与人 = 经办 + 协办（GLOSSARY「参与人」）；关注人只收通知，不算参与人。 */
export function handlersOf<T extends { staffRole: string }>(staff: readonly T[]): T[] {
  return staff.filter((s) => s.staffRole !== "follower");
}

/** 宿主 → API/路由共用段：`matters` / `risk-matters`。 */
export function hostBase(host: HostType): "matters" | "risk-matters" {
  return host === "matter" ? "matters" : "risk-matters";
}

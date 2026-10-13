import type { Metadata } from "next";
import { NotificationsView } from "./notifications-view";

export const metadata: Metadata = { title: "通知 · MatterNest" };

/**
 * 通知中心页壳（禁令⑥：不预取业务数据，读数全部由 `NotificationsView` 经 `/api/notifications` 取）。
 *
 * 这里**不需要** `Suspense`：本页不用 `useSearchParams()`（分页与"只看未读"是组件态，
 * 理由见 `notifications-view.tsx`），所以不会把整棵子树降级成动态渲染。
 */
export default function NotificationsPage() {
  return <NotificationsView />;
}

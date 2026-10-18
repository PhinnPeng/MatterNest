import type { Metadata } from "next";
import { RolesView } from "./roles-view";

export const metadata: Metadata = { title: "角色权限 · MatterNest" };

/**
 * 角色权限页壳（MATT-100；禁令⑥：不预取业务数据，读数全部由 `RolesView`
 * 经 `/api/roles` 取）。
 *
 * 这里**不需要** `Suspense`：本页的选中角色是组件态、不落 URL，也就不用
 * `useSearchParams()`，所以不会把整棵子树降级成动态渲染（与 `notifications/page.tsx`
 * 同一条理由）。
 */
export default function RolesPage() {
  return <RolesView />;
}

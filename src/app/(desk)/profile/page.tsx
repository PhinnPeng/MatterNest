import type { Metadata } from "next";

import { ProfileView } from "./profile-view";

export const metadata: Metadata = { title: "个人设置 · MatterNest" };

/**
 * 个人设置页（2026-10-18）。
 *
 * 它在一期 PRD 里没有编号条目——身份卡菜单需要一个"个人设置"的落点，
 * 而系统里原先只有 `/watch`（我关注的）与 `/users`（别人的账号，要 `canManageUser`）。
 * 这一页补的是**看自己**：资料、数据范围、持有特权。
 *
 * 与其余页面同构：Server Component 壳只写 metadata 并渲染客户端视图，
 * **不预取任何业务数据**（禁令⑥）。读数由视图经 `/api/session` 走 React Query。
 */
export default function ProfilePage() {
  return <ProfileView />;
}

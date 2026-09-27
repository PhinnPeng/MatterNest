import type { ReactNode } from "react";
import { AppShell } from "@/app/components/app-shell";

/**
 * 桌面区段布局：左侧主菜单 + 内容区（"左侧主菜单"这条要求的落点）。
 *
 * 这里**不取任何业务数据**（禁令⑥）。AppShell 内部读 `/api/session`，
 * 那是"我是谁"而不是业务列表 —— 菜单与登出必须由它决定，否则每个页面各判一次必然漏一处。
 *
 * 顶栏标题由 AppShell 自己按 `usePathname()` 推（它本来就是客户端组件），
 * layout 不传 title：Next 16 的 layout 是 server component，拿不到 pathname，
 * 硬要传就得把整条路由组变客户端，不值。
 */
export default function DeskLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

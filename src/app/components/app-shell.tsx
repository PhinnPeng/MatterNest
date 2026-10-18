"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment } from "react";
import { App as AntdApp, Dropdown } from "antd";
import { LogoutOutlined, StarOutlined } from "@ant-design/icons";

import { api, useActor } from "@/app/lib/client/api";
import { useAppearance } from "@/app/theme/appearance-provider";

/**
 * 应用外壳：左导航 216 + 主区（顶栏 52 + 页容器）。
 *
 * 三条实现约束没随这一轮的换壳变：
 *   · 它仍是客户端组件、只读 `/api/session`——菜单可见性必须由它决定，
 *     但**服务端每个 handler 仍各自判范围**（禁令⑤），菜单隐藏从来不是权限；
 *   · 菜单项写死在代码里不从配置表读：读配置会变成"配置没配 → 菜单空白"这种查不出来的故障；
 *   · 退出走 POST，不用 GET——GET 会被预取和爬虫触发。
 *
 * ## 2026-10-18（MATT-98）：从 antd `Layout` + 深色 `Menu` 换成 canon 的外壳
 *
 * 原型 `.impeccable/mocks/pages/canon.css` 是目标态的唯一实现，它的骨架是
 * `<nav class="nav">`（浅色面 + 分组标签 + `.it.on` 高亮）/ `.topbar` / `.page`，
 * 而不是 antd 的 `Sider` + 深色 Menu。两条直接后果：
 *   · 导航只有**名字**，没有图标——canon 的导航项就是一行字（图标是上一版的装饰）；
 *   · 高亮靠 `aria-current="page"` + `.it.on` 两个通道，不再是 `selectedKeys`。
 * 类名定义在 `globals.css` 的「外壳与页容器」一节。
 *
 * ## 菜单分组与"个人的入口"（US 13/15/16、问题陈述 5）
 *
 * 三组九项：概要（工作台 / 通知）、业务（案件 / 事项 / 当事人 / 已归档）、
 * 系统（功能配置 / 用户管理 / 角色权限）。**批量导入不在导航里**（MATT-102 把入口
 * 搬到案件页/事项页的弹层，`/config/import` 只留报告找回）。
 * 「我关注的」也**不占导航格**：它是**个人的**入口，收在侧栏底部的身份区，
 * 与「退出登录」并列——与业务实体并列会让它看起来像第五种记录。
 */
const NAV: { label: string; items: { href: string; label: string }[] }[] = [
  {
    // 组名从"今日"改成"概要"（2026-10-12）：这一组说的是职责（概览），不是时间。
    label: "概要",
    items: [
      { href: "/", label: "工作台" },
      { href: "/notifications", label: "通知" },
    ],
  },
  {
    label: "业务",
    items: [
      { href: "/matters", label: "案件" },
      { href: "/risk-matters", label: "事项" },
      { href: "/parties", label: "当事人" },
      { href: "/archive", label: "已归档" },
    ],
  },
  {
    label: "系统",
    items: [
      { href: "/config", label: "功能配置" },
      // 用户管理（MATT-10 / P13）。**不做按权限隐藏**：无 canManageUser 的人点进来看到的
      // 是"这个页面需要「管理账号」权限"这句话，而不是一个凭空消失的菜单项——
      // 菜单项消失会让人以为"系统没有这个功能"，那是另一件事。
      { href: "/users", label: "用户管理" },
      // 角色权限页（MATT-100）。**路由今天还不存在**：这一项先指向 `/roles`，
      // 页面与只读接口由那张票落。不留注释说明"页面做了什么"——那是票里的事。
      { href: "/roles", label: "角色权限" },
    ],
  },
];

const NAV_ITEMS = NAV.flatMap((group) => group.items);

/**
 * 当前所在页：取**最长前缀命中**的那一项。
 *
 * 详情页（`/matters/123`）因此落在列表项「案件」上，列表页也一样；
 * `/` 只认全等，否则它会命中所有路径。数字后面还跟过一条顺序依赖的坑：
 * 早先 `/config/import` 也在导航里时，必须排在 `/config` 之前才不会被抢走高亮——
 * 现在它已移出导航，这条顺序约束随之消失。
 */
function activeHref(pathname: string): string {
  if (pathname === "/") return "/";
  let best = "";
  for (const item of NAV_ITEMS) {
    if (item.href !== "/" && pathname.startsWith(item.href) && item.href.length > best.length) {
      best = item.href;
    }
  }
  return best;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const { message } = AntdApp.useApp();
  const { data: actor } = useActor();
  const { appearance, setAppearance } = useAppearance();

  const active = activeHref(pathname);
  const title = NAV_ITEMS.find((item) => item.href === active)?.label ?? "工作台";

  async function logout() {
    await api.post("/api/auth/logout");
    message.success("已退出");
    router.replace("/login");
  }

  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">MatterNest</div>
        {NAV.map((group) => (
          <Fragment key={group.label}>
            <span className="gl">{group.label}</span>
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={item.href === active ? "it on" : "it"}
                aria-current={item.href === active ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </Fragment>
        ))}
        {/*
          身份区在侧栏底缘（`margin-top:auto` 把它推下去，滚动的只会是菜单上方），
          与 canon 原型 `navfoot` 同位置：身份本身 → 它的两个动作 → 外观切换。
          「去登录」只在没有会话时出现；两处各放一份"去登录"是同一屏重复同一事实。
        */}
        <div className="navfoot">
          {actor ? (
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  // 「我关注的」的语义是"由我 star 建立、会收到状态与评论通知"
                  // （ADR-0003 的 favorite 那一面），所以它与「退出登录」同处"我的"这一组。
                  { key: "/watch", icon: <StarOutlined />, label: "我关注的" },
                  { key: "logout", icon: <LogoutOutlined />, label: "退出登录" },
                ],
                onClick: ({ key }) => {
                  if (key === "logout") void logout();
                  else router.push(key);
                },
              }}
            >
              <button type="button" className="who" aria-haspopup="menu">
                {actor.displayName}
                <i aria-hidden="true">▾</i>
              </button>
            </Dropdown>
          ) : (
            <Link href="/login" className="who">
              去登录
            </Link>
          )}
          {/*
            外观切换：**用户可见的一等状态**（ADR-0006），不是开发者开关。
            两个 `<button>` 而不是一个开关：屏幕阅读器听到的是"浅色/深色，按下"这种
            明确的选择，而不是一个需要猜当前态的开关；键盘用 Tab + 回车即可切换（US 5）。
            当前态的高亮由 CSS 按 `html.dark` 决定（`globals.css` 的 `.modesw`），
            `aria-pressed` 是同一事实的第二通道（词 + 形状，色不作唯一通道）。
          */}
          <span className="modesw">
            <button
              type="button"
              className="m-light"
              aria-pressed={appearance === "light"}
              onClick={() => setAppearance("light")}
            >
              浅色
            </button>
            <button
              type="button"
              className="m-dark"
              aria-pressed={appearance === "dark"}
              onClick={() => setAppearance("dark")}
            >
              深色
            </button>
          </span>
        </div>
      </nav>

      <div className="main">
        {/* 顶栏只写当前页名（canon：`.topbar h1`）。**不是链接**——它就是这一页的标题，
            点自己回到自己没有信息量；详情页的返回入口是页头的 `.back`（批量二落）。 */}
        <header className="topbar">
          <h1>{title}</h1>
        </header>
        <div className="page">{children}</div>
      </div>
    </div>
  );
}

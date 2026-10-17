"use client";

import { BRAND, INK, alpha } from "@/app/theme/brand";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import { App as AntdApp, Avatar, Dropdown, Layout, Menu, Space, Typography } from "antd";
import type { MenuProps } from "antd";
import {
  BellOutlined,
  DashboardOutlined,
  ExportOutlined,
  FileTextOutlined,
  ImportOutlined,
  InboxOutlined,
  LogoutOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";

import { api, useActor } from "@/app/lib/client/api";

/**
 * 应用外壳（antd `Layout` + 深色 `Menu`）。
 *
 * 三条实现约束没随换库变：
 *   · 它仍是客户端组件、只读 `/api/session`——菜单可见性必须由它决定，
 *     但**服务端每个 handler 仍各自判范围**（禁令⑤），菜单隐藏从来不是权限；
 *   · 菜单项写死在代码里不从配置表读：一期只有 4 个入口，读配置会变成
 *     "配置没配 → 菜单空白"这种查不出来的故障；
 *   · 退出走 POST，不用 GET——GET 会被预取和爬虫触发。
 *
 * 2026-10-12：菜单**只有名字，没有副标题**。原先每个入口都带一条 `hint` 副标题
 * （"临期与在办总览"/"立案到结案全生命周期"/…），而渲染时它们被 `items` 映射直接丢掉——
 * 也就是说屏幕上看不见、类型上却要求、review 时还要读一遍。既然没人看，就不是文案。
 */
const { Header, Sider, Content } = Layout;

type Item = { key: string; label: string; icon: React.ReactNode };

const NAV: { type: "group"; label: string; children: Item[] }[] = [
  {
    type: "group",
    // 组名从"今日"改成"概要"（2026-10-12）：这一组只有一个入口，而"今日"说的是时间
    // （今天/临期），与组里"工作台"的实际职责对不上——菜单按职责分组，不按时间分组。
    label: "概要",
    children: [
      { key: "/", label: "工作台", icon: <DashboardOutlined /> },
      // 通知中心（MATT-41 / T4）。放进"概要"而不是"业务"：它是**我的收件箱**
      // （未读徽标、已读态都是"我对这条通知"的状态），不是一类业务实体——
      // 与"案件/事项/当事人"并列会让它看起来像第五种记录。
      { key: "/notifications", label: "通知", icon: <BellOutlined /> },
    ],
  },
  {
    type: "group",
    label: "业务",
    children: [
      { key: "/matters", label: "案件", icon: <FileTextOutlined /> },
      {
        key: "/risk-matters",
        label: "事项",
        icon: <SafetyCertificateOutlined />,
      },
      // 当事人档案（MATT-40 / T3）：与"案件""事项"并列，因为它是**跨案件的主体视图**
      // ——同一个人可能卷进 N 个案卷，按案卷找他就永远看不全。
      { key: "/parties", label: "当事人", icon: <TeamOutlined /> },
      {
        key: "/archive",
        label: "已归档",
        icon: <InboxOutlined />,
      },
      // 报表（MATT-46 / T8）**不进菜单**：P0-2 裁定 M8 收窄为两张统计卡，
      // 挂在 P7 案件列表与 P4 事项列表顶部（`components/report-cards.tsx`），不新增页面。
    ],
  },
  {
    type: "group",
    label: "系统",
    children: [
      // 批量导入（P14 / F7-4 / MATT-67）。路径按**代码事实**放在 (desk)/config 下
      // （PRD §4.2 写的 `/settings/*` 从未落地，而且顶层 `src/app/settings/` 不在
      // (desk) 组内、拿不到这个导航壳）。⚠ 走在这条路由上的裁定需要人确认。
      // 排在「配置字典」**之前**：下方 `selectedKeys` 取的是首个 startsWith 命中，
      // `/config/import` 必须先进列表才不会被 `/config` 抢先高亮。
      { key: "/config/import", label: "批量导入", icon: <ImportOutlined /> },
      { key: "/config", label: "配置字典", icon: <SettingOutlined /> },
      // 用户与角色（MATT-10 / P13）。**不做按权限隐藏**：无 canManageUser 的人点进来
      // 看到的是"这个页面需要「管理账号」权限"这句话，而不是一个凭空消失的菜单项
      // ——菜单项消失会让人以为"系统没有这个功能"，那是另一件事。
      { key: "/users", label: "用户与角色", icon: <TeamOutlined /> },
    ],
  },
];

function titleOf(pathname: string): string {
  let best = { key: "/", label: "工作台" };
  for (const g of NAV) {
    for (const it of g.children) {
      const hit = it.key === "/" ? pathname === "/" : pathname.startsWith(it.key);
      if (hit && it.key.length > best.key.length) best = { key: it.key, label: it.label };
    }
  }
  return best.label;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const { message } = AntdApp.useApp();
  const { data: actor } = useActor();

  const items: MenuProps["items"] = useMemo(
    () =>
      NAV.map((g) => ({
        key: g.label,
        type: "group" as const,
        label: g.label,
        children: g.children.map((it) => ({ key: it.key, icon: it.icon, label: it.label })),
      })),
    [],
  );

  async function logout() {
    await api.post("/api/auth/logout");
    message.success("已退出");
    router.replace("/login");
  }

  return (
    <Layout style={{ minHeight: "100vh" }}>
      {/* 纵向 flex 的容器是**自己包的这层 div**，不是 `Sider`。
            踩过的坑：`Sider` 会把 `className`/`style` 落在**外层** `.ant-layout-sider`，
            而它的子节点被塞进 antd 自己注入的 `.ant-layout-sider-children`（`display:block`）。
            所以把 `display:flex` 加在 `Sider` 上时，**子节点里那个 `flex:1` 静默失效**——
            垫片高度 0、身份区贴在菜单下方而不是底缘（实测 y=478 vs 底缘 886）。
            `SiderProps` 的 `styles` 也只认 `root` / `body`，拿不到那层 children。
            包一层自己的容器就不再依赖 antd 的内部结构。 */}
      <Sider
        width={216}
        theme="dark"
        breakpoint="lg"
        collapsedWidth={0}
        style={{ height: "100vh", position: "sticky", top: 0 }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
            minHeight: 0,
          }}
        >
          {/* 字标下面那行"风险事项 · 案件"已撤（2026-10-12）：它是菜单名本身的复述，
            而菜单就在正下方——同一屏里把「案件/风险事项」说两遍，第二遍不增加任何判断。 */}
          <div style={{ padding: "14px 16px 10px", lineHeight: 1.35 }}>
            <Typography.Text strong style={{ color: "#fff", fontSize: 15, letterSpacing: 0.2 }}>
              MatterNest
            </Typography.Text>
          </div>
          {/* `flex:1` + `overflow:auto`：入口变多时滚动的是菜单，身份区留在底缘不动 */}
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            <Menu
              theme="dark"
              mode="inline"
              items={items}
              selectedKeys={[
                pathname === "/"
                  ? "/"
                  : (NAV.flatMap((g) => g.children).find(
                      (i) => pathname.startsWith(i.key) && i.key !== "/",
                    )?.key ?? "/"),
              ]}
              onClick={({ key }) => router.push(key)}
              style={{ borderInlineEnd: "none" }}
            />
          </div>
          {/* 侧栏底部是身份区，不放数据范围（2026-10-12 → 2026-10-13 两次改动的结果）：
            先撤掉"数据范围 · 全公司"那块，理由是同一屏两处范围说明会稀释判断；
            随后 Header 右侧那条范围 `Tag` 也删了（用户反馈"不需要显示全公司字样"），
            于是范围在界面上**一处都不常驻**——三档定义仍以
            `shared/enums/targets.ts` 的 `DATA_SCOPE_LABELS` 为准，可见性改由
            「看不见的记录」时那条 404 文案承担。

            身份区落底靠的是**菜单区那个 `flex:1` 吃掉剩余高度**，不需要额外的弹性垫片——
            两个 `flex:1` 会各占一半，菜单区被撑高、身份区被顶到视口之外。
            菜单区包 `overflow:auto`：入口变多时滚动的是菜单，身份区永远留在底缘。 */}
          {actor ? (
            <Dropdown
              menu={{
                items: [
                  { key: "logout", icon: <LogoutOutlined />, label: "退出登录", onClick: logout },
                ],
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 16px",
                  cursor: "pointer",
                  borderTop: `1px solid ${alpha(BRAND.sider.item, 0.16)}`,
                  alignSelf: "center",
                  width: "100%",
                  justifyContent: "center",
                }}
              >
                <Avatar size={26} style={{ background: BRAND.primary, fontSize: 12, flex: "none" }}>
                  {actor.displayName.slice(0, 1)}
                </Avatar>
                <Typography.Text
                  ellipsis
                  style={{ color: BRAND.sider.item, fontSize: 13, minWidth: 0 }}
                  title={actor.displayName}
                >
                  {actor.displayName}
                </Typography.Text>
              </div>
            </Dropdown>
          ) : (
            <Typography.Link href="/login" style={{ padding: "10px 16px", display: "block" }}>
              <Space size={6}>
                <ExportOutlined />
                去登录
              </Space>
            </Typography.Link>
          )}
        </div>
      </Sider>

      <Layout>
        {/* Header 只剩页面标题一处内容（身份区已于 2026-10-13 移进侧栏底部）。
            未登录时的「去登录」也只在侧栏出现一次——两处各放一份是同一屏重复同一事实，
            而重复的那一份还会在登录后变成需要读者自己判断的死区。 */}
        <Header
          style={{
            display: "flex",
            alignItems: "center",
            borderBottom: `1px solid ${INK.line}`,
            background: "#fff",
          }}
        >
          <Link href={pathname === "/" ? "/" : pathname}>
            <Typography.Text style={{ fontSize: 15, fontWeight: 500 }}>
              {titleOf(pathname)}
            </Typography.Text>
          </Link>
        </Header>
        <Content style={{ padding: 16, overflow: "auto" }}>{children}</Content>
      </Layout>
    </Layout>
  );
}

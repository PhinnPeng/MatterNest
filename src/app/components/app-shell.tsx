"use client";

import { BRAND, INK } from "@/app/theme/brand";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import { App as AntdApp, Avatar, Dropdown, Layout, Menu, Space, Tag, Typography } from "antd";
import type { MenuProps } from "antd";
import {
  BarChartOutlined,
  DashboardOutlined,
  ExportOutlined,
  FileTextOutlined,
  InboxOutlined,
  LogoutOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";

import { api, useActor } from "@/app/lib/client/api";
import { DATA_SCOPE_LABELS, type DataScope } from "@/shared/enums/targets";

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
    children: [{ key: "/", label: "工作台", icon: <DashboardOutlined /> }],
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
      // 报表（MATT-46 / T8）：运维视角的聚合读数，不是某个案卷的一部分，所以与案卷并列
      { key: "/reports", label: "报表", icon: <BarChartOutlined /> },
    ],
  },
  {
    type: "group",
    label: "系统",
    children: [
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
      <Sider width={216} theme="dark" breakpoint="lg" collapsedWidth={0}>
        {/* 字标下面那行"风险事项 · 案件"已撤（2026-10-12）：它是菜单名本身的复述，
            而菜单就在正下方——同一屏里把「案件/风险事项」说两遍，第二遍不增加任何判断。 */}
        <div style={{ padding: "14px 16px 10px", lineHeight: 1.35 }}>
          <Typography.Text strong style={{ color: "#fff", fontSize: 15, letterSpacing: 0.2 }}>
            MatterNest
          </Typography.Text>
        </div>
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
          style={{ borderInlineEnd: "none", paddingBottom: 8 }}
        />
        {/* 侧栏底部那块"数据范围 · 全公司 / 全公司：每一案件/事项"已撤（2026-10-12）：
            它是当前身份**已经被 Header 右侧标签说过一遍**的内容，而且那块里的第二行
            （SCOPE_HINT）把范围谓词写成了散文——同一屏出现两处范围说明，
            用户要做的判断反而被稀释。范围仍然可见：Header 的标签 + 未授权时的 404 文案。 */}
      </Sider>

      <Layout>
        <Header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: `1px solid ${INK.line}`,
            background: "#fff",
          }}
        >
          <Space size={10}>
            <Link href={pathname === "/" ? "/" : pathname}>
              <Typography.Text style={{ fontSize: 15, fontWeight: 500 }}>
                {titleOf(pathname)}
              </Typography.Text>
            </Link>
          </Space>
          {actor ? (
            <Dropdown
              menu={{
                items: [
                  { key: "logout", icon: <LogoutOutlined />, label: "退出登录", onClick: logout },
                ],
              }}
            >
              <Space size={8} style={{ cursor: "pointer" }}>
                <Avatar size={24} style={{ background: BRAND.primary, fontSize: 12 }}>
                  {actor.displayName.slice(0, 1)}
                </Avatar>
                <Typography.Text style={{ fontSize: 13 }}>{actor.displayName}</Typography.Text>
                <Tag variant="filled" style={{ marginInlineEnd: 0, fontSize: 11 }}>
                  {DATA_SCOPE_LABELS[actor.dataScope as DataScope]?.zh ?? actor.dataScope}
                </Tag>
              </Space>
            </Dropdown>
          ) : (
            <Typography.Link href="/login">
              <Space size={4}>
                <ExportOutlined />
                去登录
              </Space>
            </Typography.Link>
          )}
        </Header>
        <Content style={{ padding: 16, overflow: "auto" }}>{children}</Content>
      </Layout>
    </Layout>
  );
}

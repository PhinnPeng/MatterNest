"use client";

import { alpha, BRAND, INK } from "@/app/theme/brand";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import { App as AntdApp, Avatar, Dropdown, Layout, Menu, Space, Tag, Typography } from "antd";
import type { MenuProps } from "antd";
import {
  DashboardOutlined,
  ExportOutlined,
  FileTextOutlined,
  LogoutOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
} from "@ant-design/icons";

import { api, useActor } from "@/app/lib/client/api";
import { DATA_SCOPE_LABELS, type DataScope } from "@/shared/enums/targets";
import { SCOPE_HINT } from "@/app/theme/antd";

/**
 * 应用外壳（antd `Layout` + 深色 `Menu`）。
 *
 * 三条实现约束没随换库变：
 *   · 它仍是客户端组件、只读 `/api/session`——菜单可见性必须由它决定，
 *     但**服务端每个 handler 仍各自判范围**（禁令⑤），菜单隐藏从来不是权限；
 *   · 菜单项写死在代码里不从配置表读：一期只有 4 个入口，读配置会变成
 *     "配置没配 → 菜单空白"这种查不出来的故障；
 *   · 退出走 POST，不用 GET——GET 会被预取和爬虫触发。
 */
const { Header, Sider, Content } = Layout;

type Item = { key: string; label: string; icon: React.ReactNode; hint: string };

const NAV: { type: "group"; label: string; children: Item[] }[] = [
  {
    type: "group",
    label: "今日",
    children: [{ key: "/", label: "工作台", icon: <DashboardOutlined />, hint: "临期与在办总览" }],
  },
  {
    type: "group",
    label: "业务",
    children: [
      { key: "/matters", label: "案件", icon: <FileTextOutlined />, hint: "立案到归档全生命周期" },
      {
        key: "/risk-matters",
        label: "风险事项",
        icon: <SafetyCertificateOutlined />,
        hint: "报备、跟踪、转案件",
      },
    ],
  },
  {
    type: "group",
    label: "系统",
    children: [
      { key: "/config", label: "配置字典", icon: <SettingOutlined />, hint: "状态与等级（只读）" },
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
        <div style={{ padding: "14px 16px 10px", lineHeight: 1.35 }}>
          <Typography.Text strong style={{ color: "#fff", fontSize: 15, letterSpacing: 0.2 }}>
            MatterNest
          </Typography.Text>
          <div style={{ color: alpha(BRAND.sider.item, 0.62), fontSize: 11 }}>风险事项 · 案件</div>
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
        {actor ? (
          <div
            style={{
              padding: "10px 16px",
              borderTop: `1px solid ${alpha(BRAND.sider.active, 0.07)}`,
            }}
          >
            <div style={{ color: alpha(BRAND.sider.item, 0.9), fontSize: 12 }}>
              数据范围 · {DATA_SCOPE_LABELS[actor.dataScope as DataScope]?.zh ?? actor.dataScope}
            </div>
            <div style={{ color: alpha(BRAND.sider.item, 0.55), fontSize: 11, marginTop: 2 }}>
              {SCOPE_HINT[actor.dataScope] ?? "—"}
            </div>
          </div>
        ) : null}
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
                <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
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

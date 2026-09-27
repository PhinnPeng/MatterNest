"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboardIcon,
  LogOutIcon,
  ScaleIcon,
  SettingsIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { api, useActor } from "@/app/lib/client/api";
import { DATA_SCOPE_LABELS, type DataScope } from "@/shared/enums/targets";
import { cn } from "cn";

/**
 * 应用外壳：深色左侧主菜单 + 浅色内容区（用户指定"左侧主菜单"）。
 *
 * 三条实现约束：
 *   · 这个组件是**客户端**的，但它只读 `/api/session` 拿"我是谁"来渲染菜单和登出按钮 ——
 *     禁令⑥ 说的是页面壳不许预取业务数据；会话不是业务数据，而且它决定菜单可见性，
 *     放在这里比在每个 page 里重复一次更不易漏。
 *   · 菜单项写死在代码里而不是从配置表读：一期只有 4 个入口，读配置会变成
 *     "配置表里没配 → 菜单空白"这种查不出来的故障。等真有角色差异化菜单时再改，
 *     而且那时也必须服务端裁一遍（菜单隐藏从来不是权限）。
 *   · 退出用 POST 而不是 GET：GET 退出会被浏览器预取、被链接爬虫触发。
 */

type NavItem = { href: string; label: string; icon: typeof ScaleIcon; hint: string };

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "今日",
    items: [{ href: "/", label: "工作台", icon: LayoutDashboardIcon, hint: "临期与在办总览" }],
  },
  {
    group: "业务",
    items: [
      { href: "/matters", label: "案件", icon: ScaleIcon, hint: "立案到归档全生命周期" },
      {
        href: "/risk-matters",
        label: "风险事项",
        icon: ShieldAlertIcon,
        hint: "报备、跟踪、转案件",
      },
    ],
  },
  {
    group: "系统",
    items: [{ href: "/config", label: "配置", icon: SettingsIcon, hint: "状态与等级字典（只读）" }],
  },
];

/**
 * 顶栏标题。规则很简单：**取当前路径命中的最长菜单前缀**，详情页也归到它的入口名下
 * （`/matters/123` 顶栏仍写"案件"，具体编号在页面自己的 PageHeader 里）。
 * 这样标题只有一处来源，不会出现"菜单叫案件、顶栏叫案卷管理"。
 */
function titleOf(pathname: string): string {
  let best = { prefix: "/", label: "工作台" };
  for (const section of NAV) {
    for (const item of section.items) {
      const hit = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
      if (hit && item.href.length > best.prefix.length)
        best = { prefix: item.href, label: item.label };
    }
  }
  return best.label;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: actor } = useActor();
  const title = titleOf(pathname ?? "/");

  async function logout() {
    await api.post("/api/auth/logout");
    router.replace("/login");
  }

  return (
    <div className="flex min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="flex h-12 items-baseline gap-2 border-b border-sidebar-border px-4">
          <span className="text-[0.95rem] font-semibold tracking-tight text-sidebar-foreground">
            MatterNest
          </span>
          <span className="text-[0.7rem] text-sidebar-foreground/55">风险事项 · 案件</span>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV.map((section) => (
            <div key={section.group} className="mb-4">
              <p className="px-2 pb-1 text-[0.68rem] text-sidebar-foreground/45">{section.group}</p>
              <ul className="space-y-px">
                {section.items.map((item) => {
                  const active =
                    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[0.84rem] outline-none transition-colors",
                          "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                          active
                            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                            : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                        )}
                      >
                        {/* 当前项靠左侧 2px 电蓝标出，不靠整块高亮：深色底上整块填色会把注意力从内容区抢走 */}
                        <span
                          aria-hidden
                          className={cn(
                            "-ml-2 h-4 w-0.5 rounded-full bg-sidebar-primary transition-opacity",
                            active ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <Icon className="size-4 shrink-0 opacity-80" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-sidebar-border px-4 py-3 text-[0.7rem] leading-relaxed text-sidebar-foreground/55">
          {actor ? (
            (() => {
              const label = DATA_SCOPE_LABELS[actor.dataScope as DataScope];
              if (!label) return <p>数据范围 · {actor.dataScope}</p>;
              // L2/L3 的 formula 是真解释（"∪ 我协办的…""不含他人加给我的…"），
              // L1 的那句只是把"全所"重说一遍 —— 重复就不显示。
              const addsInfo = !label.formula.startsWith(label.zh);
              return (
                <>
                  <p className="text-sidebar-foreground/80">数据范围 · {label.zh}</p>
                  {addsInfo ? <p>{label.formula}</p> : null}
                </>
              );
            })()
          ) : (
            <p>内部系统 · 未登录</p>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col pl-60">
        <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-background/92 px-5 backdrop-blur supports-backdrop-filter:bg-background/78">
          <h1 className="truncate text-[0.95rem] font-medium">{title}</h1>
          <div className="flex shrink-0 items-center gap-3">
            {actor && (
              <>
                <span className="text-xs text-muted-foreground">
                  {actor.displayName}
                  <span className="num"> · {actor.userId.slice(-6)}</span>
                </span>
                <button
                  type="button"
                  onClick={logout}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <LogOutIcon className="size-3.5" />
                  退出
                </button>
              </>
            )}
          </div>
        </header>
        <main className="min-w-0 flex-1 px-5 py-4">{children}</main>
      </div>
    </div>
  );
}

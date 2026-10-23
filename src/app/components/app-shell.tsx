"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment } from "react";
import { App as AntdApp, Avatar, Badge, Dropdown, Tooltip } from "antd";
import {
  BellOutlined,
  DesktopOutlined,
  LogoutOutlined,
  MoonOutlined,
  SettingOutlined,
  StarOutlined,
  SunOutlined,
} from "@ant-design/icons";

import { api, useActor } from "@/app/lib/client/api";
import { useUnreadCount } from "@/app/lib/client/api-notifications";
import { useAppearance } from "@/app/theme/appearance-provider";
import type { AppearancePref } from "@/app/theme/brand";
import { CONFIG_KIND_LABELS, isConfigKind } from "@/shared/schema/config";

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
 * 三组：概要（工作台）、业务（案件 / 事项 / 当事人 / 已归档）、
 * 系统（功能配置 / 自动化规则 / 用户管理 / 角色权限）。
 * **批量导入不在导航里**（MATT-102 把入口搬到案件页/事项页的弹层，`/config/import` 只留报告找回）。
 * 「我关注的」也**不占导航格**：它是**个人的**入口，收在侧栏底部的身份区，
 * 与「退出登录」并列——与业务实体并列会让它看起来像第五种记录。
 *
 * ## 「通知」为什么从导航里搬到身份区顶部（2026-10-19，用户裁定）
 *
 * 用户的原话是「通知元素不要放置在左侧主菜单上」。它此前是「概要」组的第二项，
 * 与「工作台」并列——于是同一屏里有两处表达"今天要看什么"，而通知的**未读计数**
 * 没有地方可挂（挂在导航项上会长出一枚与菜单名字争宽度的小红点）。
 *
 * 现在它是身份区上方的一枚**图标按钮 + 未读数**，理由是三件事，不是审美：
 *   ① 通知是**收件箱**不是**模块**：它的状态（未读几条）比它的名字重要，
 *      而导航项这种形态只能表达"有这一页"，表达不了"有 3 条等你"；
 *   ② 它是**我的**东西（收件人永远是当前用户，与数据范围无关），
 *      与「我关注的」「个人设置」「退出登录」同属"我的"那一簇——FAQ：
 *      「我关注的」当初就是这么从导航里移出来的，同一判断；
 *   ③ 位置在身份卡**正上方**：两者都是"我"，且都随会话存在而存在
 *      （没登录时这一整块都不渲染，只剩「去登录」）。
 *
 * 它**仍有一份 `EXTRA_TITLES`**：页面还在（`/notifications`），顶栏得写得出它叫什么。
 */
const NAV: { label: string; items: { href: string; label: string }[] }[] = [
  {
    // 组名从"今日"改成"概要"（2026-10-12）：这一组说的是职责（概览），不是时间。
    // 2026-10-19 只剩「工作台」一项：通知搬去身份区（见上），组名保留——
    // 将来概览类入口（例如"我的待办"）还会落回这里，拆掉分组会让它无处可归。
    label: "概要",
    items: [{ href: "/", label: "工作台" }],
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
      // 自动化规则页（P12，2026-10-18）。放在配置旁边：两者都是"系统怎么运转"的设置面。
      // 标签 2026-10-19 由「自动化规则」缩短为「自动化」。
      { href: "/rules", label: "自动化" },
      // 用户管理（MATT-10 / P13）。**不做按权限隐藏**：无 canManageUser 的人点进来看到的
      // 是"这个页面需要「管理账号」权限"这句话，而不是一个凭空消失的菜单项——
      // 菜单项消失会让人以为"系统没有这个功能"，那是另一件事。
      { href: "/users", label: "用户管理" },
      // 角色权限页（MATT-100）。只读页与只读接口都已落（`/roles`）。
      { href: "/roles", label: "角色权限" },
    ],
  },
];

const NAV_ITEMS = NAV.flatMap((group) => group.items);

/**
 * 不在导航里、但用户仍走到得到的页面的**顶栏页名**。
 *
 * `/watch`（MATT-102 移进身份区下拉）与 `/config/import`（同票降级为报告找回）
 * 都是"移出导航"而不是"删掉页面"——用户点得到，顶栏就得写得出这一页叫什么。
 * 这张表**只喂页名**，不进侧栏、不参与高亮：把入口重新塞回导航会与"个人入口不占导航格"
 * 和"报告页从弹层链接进"两条裁定相反。
 *
 * `href.length` 的比较让 `/config/import` 压过 `/config`；这条"长前缀先赢"的顺序约束
 * 早先住在 NAV 里（那时 `/config/import` 也是导航项，必须排在 `/config` 之前），
 * 移出导航后搬到这张表——它没有消失，只是换了住处。
 */
const EXTRA_TITLES: { href: string; label: string }[] = [
  { href: "/config/import", label: "批量导入" },
  { href: "/watch", label: "我关注的" },
  // 个人设置（2026-10-18）。与上面两项同款：它从身份卡菜单点进来，不占导航格，
  // 但顶栏得写得出这一页叫什么。
  { href: "/profile", label: "个人设置" },
  // 通知（2026-10-19 从「概要」组搬到身份区顶部）。页名仍要能写出来——
  // 它不在 `NAV_ITEMS` 里了，`activeHref` 因此不会为它高亮任何导航项（这正是对的：
  // 身份区那枚按钮自己带高亮），但顶栏 `h1` 必须还是「通知」而不是退回「工作台」。
  { href: "/notifications", label: "通知" },
];

/**
 * 当前所在页：取**最长前缀命中**的那一项。
 *
 * 详情页（`/matters/123`）因此落在列表项「案件」上，列表页也一样；
 * `/` 只认全等，否则它会命中所有路径。
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

/**
 * 顶栏 `h1` 的页名。**与 `activeHref`（哪个导航项高亮）分开**：有的页面不在导航里
 * 却仍会被走到（见 `EXTRA_TITLES`），页名若只在 `NAV_ITEMS` 里找，它们就会退回
 * 「工作台」/「功能配置」——那两句都不是这一页的名字。所以页名多看一张表，
 * 同样取最长前缀。
 *
 * ## 带参数的细项页要写**细项名**，不是父页名
 *
 * `canon-spec.md` §13.1 规定细项页「顶栏 `h1` = 细项名」（原型 `config-matter-status.html`
 * 的顶栏就是「案件状态」，不是「功能配置」）。前缀匹配做不到这件事：`/config/case_status`
 * 只命中 `/config`，于是顶栏写着父页名，而细项名只出现在页内 `h2` ——
 * 用户从导航点进「功能配置」后再进细项页，顶栏看不出自己换了一页。
 *
 * 所以这里显式处理一段动态路径：`/config/<kind>` 取 `CONFIG_KIND_LABELS[kind]`。
 * 标签来自 `shared/schema/config.ts`（前后端同一份，禁令⑧），**不在这个壳里抄第二份**。
 * 非法 kind 不落进这一支（`isConfigKind` 判）——那些路径由页面自己 404，顶栏不必替它表态。
 */
function configKindTitle(pathname: string): string | null {
  const m = /^\/config\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  const kind = m[1];
  if (!kind || !isConfigKind(kind)) return null;
  return CONFIG_KIND_LABELS[kind];
}

function pageTitle(pathname: string): string {
  const kindTitle = configKindTitle(pathname);
  if (kindTitle) return kindTitle;
  let best: { href: string; label: string } | undefined;
  for (const item of [...NAV_ITEMS, ...EXTRA_TITLES]) {
    const hit = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
    if (hit && (!best || item.href.length > best.href.length)) best = item;
  }
  return best?.label ?? "工作台";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const { message } = AntdApp.useApp();
  const { data: actor } = useActor();

  const active = activeHref(pathname);
  const title = pageTitle(pathname);

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
          身份区在侧栏底缘（`margin-top:auto` 把它推下去，滚动的只会是菜单上方）。

          形态：**一行两枚胶囊**——左边通知、右边头像昵称（2026-10-19 用户裁定）。
          两者都是"我的"，所以共处底缘这一簇；各自独立成枚（不是一条容器切两半），
          于是"谁能点、点了干什么"由各自的边界与悬停回答，不靠一条内部竖线去暗示。

          2026-10-20：**身份卡吃满底栏余量**（两枚都到 40px，名字 13px，卡上带一层
          极浅投影）。收窄居中的时候，两枚之间那段空档既不属于通知也不属于身份；
          撑满之后底栏是一条完整横带，右端与侧栏内缘对齐。

          左轻（一枚铃铛 + 角标）右重（头像 + 名字）：通知是经常点的**动作**，
          身份是"我在哪儿"的**锚**；把字留给后者，扫一眼就能认出是谁。

          为什么是 Avatar（antd）而不是一行字：用户管理页的人名早已用首字 Avatar 表身份
          （`matter-detail.tsx` 参与人那一列），这里用同一个记号，两处的人才"长得像同一种东西"。

          「去登录」只在没有会话时出现；两处各放一份"去登录"是同一屏重复同一事实。
          没有会话时**通知也不渲染**：未读数属于"我的收件箱"，那个概念在登录前不存在。
        */}
        <div className="navfoot">
          {actor ? (
            <>
              <InboxLink active={pathname.startsWith("/notifications")} />
              <IdentityCard
                displayName={actor.displayName}
                onLogout={logout}
                onNavigate={router.push}
              />
            </>
          ) : (
            <Link href="/login" className="who">
              去登录
            </Link>
          )}
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

/**
 * 外观切换的三档。**顺序就是那排图标的顺序**：跟随系统在前——它是新用户的默认档
 * （`DEFAULT_APPEARANCE_PREF`），也是唯一"随环境走"的一档。
 *
 * 三档只出**图标**（太阳 / 月亮 / 显示器），名称走 `Tooltip`（悬停出）。
 * 这是 2026-10-18 的形态：菜单里横排三枚，比竖排三行标签省一半高度，
 * 而"这个图标是哪一档"由 Tooltip 和选中态两处回答——图标本身不承担说明。
 */
const APPEARANCE_ITEMS: { key: AppearancePref; label: string; icon: React.ReactNode }[] = [
  { key: "system", label: "跟随系统", icon: <DesktopOutlined /> },
  { key: "light", label: "浅色", icon: <SunOutlined /> },
  { key: "dark", label: "深色", icon: <MoonOutlined /> },
];

/**
 * 侧栏底缘的**通知入口**（2026-10-19 从「概要」导航组搬到这里）。
 *
 * ## 形态：只有铃铛 + 未读角标（2026-10-19 用户裁定）
 *
 * 上一版是"铃铛 + 「通知」二字 + 未读数"的一条**全宽行**，与身份卡上下堆叠。
 * 现在两者并进**同一行**，而 191px 的侧栏内容宽装不下"两个字 + 一张身份卡"，
 * 所以词让位给图标：铃铛是这一簇里唯一的圆件，左边一枚、右边一枚身份卡，
 * 两者宽度差异本身就是"轻 / 重"的次序。
 *
 * ⚠ **词去掉之后，可读名改由三处承担**，缺一条都会退化成"猜得出但说不清"：
 *   · `aria-label="通知"` —— 读屏与可访问名（不是只有视觉）；
 *   · `title` —— 悬停给出同一句话（鼠标用户）；
 *   · `Tooltip` —— 与身份卡菜单里的三枚颜色图标同一套悬停语言。
 * 有未读时 `aria-label` 与 `title` 都带上条数，于是"有几条"不只靠那枚红点传达
 * （色不作唯一通道）。
 *
 * ## 未读数为 0 时**不画 0**
 *
 * 徽标要回答"有没有事"，而不是"确实没有"——后者已被"这里没有数字"表达过了。
 * 这一条由 `Badge` 自己兑现（`showZero` 默认关），实测 `unread=0` 时
 * `.ant-badge-count` 不渲染、`aria-label` 收成「通知」、胶囊仍是 40px，
 * 所以这里不需要再写 `unread > 0` 的条件。
 *
 * ## 99+ 截断
 *
 * `overflowCount` 走 antd 默认的 99。十人企业的通知量级远够不到它，
 * 但它挡住了一种难看的形态：四位数把这枚窄胶囊撑变形。
 *
 * ## 高亮
 *
 * 在 `/notifications` 时给 `.it.on` 的**同一对令牌**（`--nav-on` / `--nav-on-ink`），
 * 于是"当前页"在这一簇里与导航项长得一样。`aria-current="page"` 照写，
 * 色不作唯一通道。
 */
function InboxLink({ active }: { active: boolean }) {
  const { data } = useUnreadCount();
  const unread = data?.unread ?? 0;
  const name = unread > 0 ? `通知 · ${unread} 条未读` : "通知";

  return (
    <Tooltip title={name} placement="top">
      <Link
        href="/notifications"
        className={active ? "inbox on" : "inbox"}
        aria-current={active ? "page" : undefined}
        aria-label={name}
      >
        {/*
          `Badge` **包住铃铛**，不是挂在铃铛后面（2026-10-20 live 裁定 · 变体 1）。
          包住之后 antd 把计数放到图标的右上角（绝对定位），它就不参与胶囊的横向排布——
          上一版并排挂着，一枚数字把 40px 的胶囊撑到 55px（用户原话「角标不要撑开原图标大小」）。
          尺寸、字色、环宽都在 `theme/antd.ts` 的 `components.Badge` 里，不写 `style`。
          条数已由 `aria-label` / `title` / `Tooltip` 三处说出，色不作唯一通道。
        */}
        <Badge count={unread} overflowCount={99} size="small">
          <BellOutlined aria-hidden="true" />
        </Badge>
      </Link>
    </Tooltip>
  );
}

/**
 * 侧栏底缘的**身份卡**：头像 + 昵称，点开是右侧菜单。
 *
 * ## 为什么是"头像 + 昵称"
 *
 * 用户管理页的人名列早已用首字 Avatar 表身份（`Avatar` + `displayName.slice(0,1)`），
 * 这里用同一个记号——同一个人在两处长得一样，比"一处是圆头像、一处是一行字"省一次辨认。
 * 头像底色走 antd 的默认（token 派生），不写死颜色（禁令⑦）。
 *
 * ## 菜单里有什么（四组，2026-10-18 用户裁定）
 *
 *   1. 个人设置 —— 跳到 `/profile`
 *   2. 系统颜色 —— 横排三枚图标（跟随系统 / 浅色 / 深色），选中那枚高亮，悬停出 Tooltip
 *   3. 我关注的 —— 语义是"由我 star 建立、会收到状态与评论通知"（ADR-0003），
 *      与"退出登录"同处"我的"这一组，故与它们并列
 *   4. 退出登录
 *
 * 外观切换从底栏那两个常驻文字按钮**搬进这里**：同一件事两个入口会让"当前是哪档"
 * 出现两个来源；菜单里那份带选中态，是唯一的那份。
 *
 * ## 三档的选中态怎么表达
 *
 * 读 `pref`（偏好）而不是 `appearance`（解析结果）。旧实现是"哪个按钮高亮由 CSS
 * 按当前深浅决定"，那在 `system` 档下就错了——用户选的是"跟随系统"，而高亮会跟着
 * 系统的深浅跳到浅色或深色上，看起来像选了那一档。选中态必须表达**偏好**。
 * `aria-pressed` 是同一事实的第二通道（形状 + 属性，色不作唯一通道）。
 */
function IdentityCard({
  displayName,
  onLogout,
  onNavigate,
}: {
  displayName: string;
  onLogout: () => void;
  onNavigate: (href: string) => void;
}) {
  const { pref, setAppearance } = useAppearance();

  return (
    <Dropdown
      trigger={["click"]}
      /* 2026-10-20：从 `topRight` 改成 `right` —— 弹出层落在侧栏右侧的内容区上，
         而不是压在底栏自己身上。侧栏只有 191px，菜单再窄也会挡住身份卡。 */
      placement="right"
      /* 弹出层自己的宽度下限（规则见 `globals.css` 的 `.idmenu-pop`）：不设的话
         宽度由内容撑开，恰好落在触发按钮那一档，读起来像"继承了按钮的宽度"。 */
      classNames={{ root: "idmenu-pop" }}
      menu={{
        items: [
          {
            /*
             * 菜单**第一项就是颜色三档**（2026-10-19 用户裁定：由上至下为
             * 「深色浅色按钮区域 → 个人设置 → 我的关注」）。
             *
             * 三枚图标横排、**不是**三个菜单项：它作为一个菜单项的 label 塞进去，
             * 于是分隔线/缩进与其余各项自动对齐；三枚按钮各自 `stopPropagation`，
             * 否则点它们会顺着菜单的 onClick 走一遍——那条路径不认这三个 key，
             * 表现为"点了没反应"。
             *
             * 放在第一项而不是中间：颜色是"这里长什么样"的开关，改完通常还要点别的，
             * 所以它贴顶；而「退出登录」是终止动作，贴底。
             */
            key: "appearance",
            label: (
              <span className="idmenu-modes" role="group" aria-label="系统颜色">
                {APPEARANCE_ITEMS.map((it) => (
                  <Tooltip key={it.key} title={it.label} placement="top">
                    <button
                      type="button"
                      className="idmenu-mode"
                      aria-pressed={pref === it.key}
                      aria-label={it.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAppearance(it.key);
                      }}
                    >
                      {it.icon}
                    </button>
                  </Tooltip>
                ))}
              </span>
            ),
          },
          { type: "divider" },
          { key: "/profile", icon: <SettingOutlined />, label: "个人设置" },
          { key: "/watch", icon: <StarOutlined />, label: "我关注的" },
          { type: "divider" },
          { key: "logout", icon: <LogoutOutlined />, label: "退出登录" },
        ],
        onClick: ({ key }) => {
          if (key === "logout") onLogout();
          else if (key === "/profile" || key === "/watch") onNavigate(key);
        },
      }}
    >
      <button type="button" className="idcard" aria-haspopup="menu">
        <Avatar size={22} className="idcard-av">
          {displayName.slice(0, 1)}
        </Avatar>
        <span className="idcard-name">{displayName}</span>
      </button>
    </Dropdown>
  );
}

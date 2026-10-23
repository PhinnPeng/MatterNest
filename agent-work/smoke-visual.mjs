import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";
import { createRequire } from "node:module";
import { pickChrome } from "./_chrome.mjs";

/**
 * **真页面的视觉冒烟** —— 视觉重构切片（MATT-98…102）的验收工具。
 *
 * ## 为什么必须有这一个（而不是复用 `_chk/` 里那四个）
 *
 * `agent-work/_chk/` 下的 `verify-fill-all.mjs` / `check-headings.mjs` /
 * `contrast-all.mjs` / `token-contrast.mjs` **全部扫 `.impeccable/mocks/pages/*.html`（原型）**，
 * 没有一条扫 `src/` 跑出来的真页面 —— 实测过，四个文件的取数第一行都是
 * `readdirSync(".impeccable/mocks/pages")`。
 *
 * 后果在 MATT-98 的票面里是可见的：验收项写着「`contrast-all.mjs`（31 页 × 明暗两版）0 失败」，
 * 而那 31 页是**原型**，不是这一票的交付物。**绿的是原型，交付物一次都没被视觉验过。**
 * 这不是脚本坏了（它们在原型阶段用途正确），是**验收标的错位**。
 *
 * 所以这个脚本做同一批判据，**换到真页面上跑**。
 *
 * ## 判定口径（抄判据不抄实现）
 *
 * 三个数字与原型版脚本一致，但取数走真 DOM：
 *   · 底边留白 ≤40px（40 是 `.page` 的 padding-bottom）；
 *   · 正文 4.5:1 / 大字 3:1（WCAG AA，同 `token-contrast.mjs` 的线）；
 *   · 标题不跳级（h1 → h2 → h3）。
 *
 * ⚠ **断言的是「底线」不是「像素」**。不断言某元素在 x=1240 —— 像素断言会在每次有意
 * 调整布局时红，而布局调整正是这批票的目的。
 *
 * ## 明暗两版怎么测
 *
 * 外观存 `localStorage`（`theme/appearance.ts`），首帧由 `<head>` 的同步脚本读它打
 * `html.dark`。所以**先 setItem 再 goto** 才能命中深色首帧 —— 顺带验了「首帧不闪」
 * （同步脚本没生效的话，这里量到的仍是浅色底）。
 *
 * ## 失效形态与它怎么挡
 *
 * 最危险的是**空壳假绿**：白屏或只渲染骨架时，留白与对比度都轻松全绿。
 * 所以每页带一条锚（`anchor`），锚命中数为 0 即判红。
 */
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

/** 要走的真路由。`anchor` = 这一页必须有内容的最小证据 */
const PAGES = [
  /**
   * 工作台的锚在 MATT-99 换 canon 类之后改过一次：它原先靠 `table tbody tr, .ant-card`，
   * 而工作台是**指标带 + 卡片**结构（`globals.css` 的 `.metrics` / `.metric` / `.card`），
   * 从来没有表格。于是实机命中 0 —— 那是**脚本过期**，不是页面空了
   * （探过 DOM：`.metric` 5 个、`.card` 2 个、`h1` 是「工作台」，页面好好的）。
   *
   * 锚过期比锚缺失更值得警惕：它让这一页的对比度/留白/标题三项**白白失去覆盖**，
   * 而输出的红字看起来像"页面坏了"。改类名时顺手看一眼这里。
   */
  { path: "/", label: "工作台", anchor: ".metric, .card, table tbody tr" },
  { path: "/matters", label: "案件", anchor: "table tbody tr" },
  { path: "/risk-matters", label: "事项", anchor: "table tbody tr" },
  { path: "/parties", label: "当事人", anchor: "table tbody tr" },
  { path: "/archive", label: "已归档", anchor: "h1" },
  { path: "/notifications", label: "通知", anchor: "h1" },
  { path: "/users", label: "用户管理", anchor: "table tbody tr" },
  { path: "/config", label: "功能配置", anchor: "h1" },
  { path: "/roles", label: "角色权限", anchor: "h1" },
  /**
   * 自动化规则（P12，2026-10-18）。锚点取**表格行**而不是 `h1`：
   * 这一页的主体是 9 行规则，只断言页头等于没验数据到没到。
   */
  { path: "/rules", label: "自动化", anchor: "table tbody tr" },
  /**
   * 下面四条是 2026-10-18 补的（Spec 轴复核指出「31 页 × 明暗」这个验收项在本脚本里
   * 只覆盖了当时那份短清单的口径）。
   *
   * 补的标准不是"把所有路由列一遍"，而是**按形态取代表**：形态不同的页才值得单列一条，
   * 同一形态再多一条只是让失败信息更长。漏掉的四类形态与它们的代表：
   *   · `/watch` —— **不依赖任何接口的业务页**（它读 `/api/watch`，但入口在身份区、不在导航，
   *     所以它此前的"顶栏页名退回工作台"的缺陷正是没有视觉覆盖才漏过去的）；
   *   · `/config/import` —— **降级为报告找回页**之后的新形态（MATT-102）；
   *   · `/config/case_status` —— 参数化细项页，**14 个共用一个组件**，
   *     取一个可写的代表即可；这是 MATT-101 那一票的主交付物；
   *   · `/login` —— **唯一不需要会话的页**，也是唯一一个自己画 `.login` 居中卡的页。
   *
   * 详情页（`/matters/[id]`）**2026-10-21 起在清单里**，但 id 不写死：登录后从案件列表
   * 第一行取那条 `<a>` 的 href（见下面的解析段）。原先这段写着"夹具账号是空账号、
   * 拿不到可打开的 id"——那句不成立：夹具挂的是 `full_admin`，数据范围 `all`，
   * 共享库里现成的案件本来就列得出来。解析不到时**单独报红**，不会静默少一页覆盖
   * （2026-10-21 给详情页做原型对齐时，正是这条盲区让改动最重的一屏没人量过）。
   */
  { path: "/watch", label: "我关注的", anchor: "h1" },
  { path: "/config/import", label: "批量导入", anchor: "h1" },
  { path: "/config/case_status", label: "配置细项", anchor: "table tbody tr, h1" },
  /**
   * 锚 2026-10-21 从 `.login .card` 改成 `.login .inp`：品牌改版那条线把登录页从
   * "居中卡"改成了 `.login > .login-stack` 的一列，卡没了，锚却一直还"绿"——
   * 它命中 0 之后这一页的三条判定全部失去覆盖，正是本文件反复警惕的"锚过期"形态。
   */
  { path: "/login", label: "登录", anchor: ".login .inp" },
  /**
   * `/profile` —— 个人设置（2026-10-18）。
   *
   * 补它的理由与上面四条同一句：**形态不同才值得单列**。它是唯一一页
   * "只有卡片、没有表格也没有查询区"的样子（三张 `.card` + `.pagehead`），
   * 而这三张卡正好是 `h2` 卡片标题的最简用例 ——
   * 标题层级那一项在这一页最容易看出跳级。
   *
   * 锚取 `.card` 而不是 `h1`：它是纯卡片页，只断页头等于没验卡片到没到。
   */
  { path: "/profile", label: "个人设置", anchor: ".card" },
];

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 在页面里跑的测量函数。`anchor` 由参数传入（不拼字符串）。 */
function probe(anchor) {
  const root = document.documentElement;
  const isDark =
    root.classList.contains("dark") || document.body.classList.contains("dark");

  const anchors = document.querySelectorAll(anchor).length;

  // ① 底边留白：可见元素的最大底边 vs 视口底
  const vis = [...document.querySelectorAll("body *")].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const bottom = vis.length
    ? Math.max(...vis.map((e) => e.getBoundingClientRect().bottom))
    : 0;
  const gap = Math.round(window.innerHeight - bottom);

  // ② 标题层级
  const hs = [...document.querySelectorAll("h1,h2,h3,h4")].map((e) =>
    Number(e.tagName[1]),
  );
  let skip = null;
  for (let i = 1; i < hs.length; i++) {
    if (hs[i] - hs[i - 1] > 1) {
      skip = `h${hs[i - 1]} → h${hs[i]}`;
      break;
    }
  }
  if (!skip && hs.length && hs[0] !== 1) skip = `首个标题是 h${hs[0]}（应为 h1）`;

  // ③ 对比度：逐条可见文字
  const lum = ([r, g, b]) => {
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  /**
   * 取"这个元素真正压在哪块底色上"。
   *
   * ⚠ 2026-10-19 修过一条**假失败**：原先这里只要遇到非全透明背景就**只取 RGB、
   * 丢掉 alpha**，于是 `rgba(255,255,255,0.08)`（antd 禁用态按钮的底）被当成纯白读。
   * 深色下那一步算出 3.14，而真实的合成底是 `rgb(41,44,49)`、实测 4.46 —— 差了一整档。
   * 半透明底必须**逐层合成到祖先底色上**，不能丢弃 alpha。
   */
  const parseRgba = (s) => {
    const nums = (s.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return null;
    return { rgb: nums.slice(0, 3), a: nums.length > 3 ? nums[3] : 1 };
  };
  const over = (fg, a, bg) => fg.map((c, i) => a * c + (1 - a) * bg[i]);
  const bgOf = (el) => {
    const pageBg = isDark ? [16, 19, 23] : [255, 255, 255];
    // 自底向顶收集半透明层，再逐层合成
    const layers = [];
    let n = el;
    while (n && n !== root) {
      const c = parseRgba(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) {
        if (c.a >= 1) {
          // 不透明底就是最终面，直接把它作为底往上合成已收集的层
          let base = c.rgb;
          for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i].rgb, layers[i].a, base);
          return base.map(Math.round);
        }
        layers.push(c);
      }
      n = n.parentElement;
    }
    let base = pageBg;
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i].rgb, layers[i].a, base);
    return base.map(Math.round);
  };

  const seen = new Map();
  for (const el of document.querySelectorAll(
    "p,span,a,td,th,li,dt,dd,label,h1,h2,h3,h4,button",
  )) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // 只看直接文字节点，避免把容器算进来
    const text = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join("");
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.opacity === "0") continue;
    /**
     * **live 浮层不参与判定**（2026-10-21）：`impeccable live` 把助手条注入到
     * `layout.tsx`，它自带一套灰字（`#impeccable-live-global-bar` 里的 "Steer" 实测
     * 1.12:1），开着 live 模式跑这份冒烟时会在**每个页面**上贡献同一条假红。
     * 判据要量的是本仓渲染的界面文字，助手条不是——与上面"禁用态豁免"同一类：
     * 都不是应用的字，把它算进来只会逼人改工具而不是改界面。
     */
    if (el.closest('[id^="impeccable-"], [class*="impeccable-"]')) continue;
    /**
     * **非活动控件不参与判定**（WCAG 1.4.3 原文豁免 "inactive user interface
     * components"）。禁用按钮的字色本来就该读起来像"这里现在按不动"，
     * 把它算成对比度失败会逼着人把禁用态染成正常态——那是把可用性做坏。
     * 命中的都是 antd 的禁用按钮（`disabled` 属性或 `.ant-btn-disabled`）。
     */
    if (
      (el.tagName === "BUTTON" || el.closest("button")) &&
      (el.disabled || el.closest("button")?.disabled ||
        el.className.toString().includes("ant-btn-disabled") ||
        el.closest("button")?.className.toString().includes("ant-btn-disabled"))
    ) {
      continue;
    }
    const fg = parse(cs.color);
    if (fg.length < 3) continue;
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    // WCAG：大字（≥18.66px，或 ≥14px 且粗）3:1，其余 4.5:1
    const need = size >= 18.66 || (size >= 14 && bold) ? 3 : 4.5;
    const bg = bgOf(el);
    const cr = ratio(fg, bg);
    if (cr < need) {
      const key = `${cs.color}|${bg.join(",")}|${need}`;
      if (!seen.has(key)) {
        seen.set(key, {
          color: cs.color,
          ratio: +cr.toFixed(2),
          need,
          text: text.slice(0, 18),
        });
      }
    }
  }

  return {
    anchors,
    gap,
    skip,
    contrastFails: [...seen.values()],
    isDark,
    h1: document.querySelector("h1")?.textContent?.trim().slice(0, 24) ?? null,
  };
}

const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

/**
 * 账号取**两个角色**（并集语义，见权限模型 §2.1）：
 *   · `full_admin` → 数据范围 `all` + 撤销归档 + 明文导出；
 *   · `sys_admin`  → `can_manage_user` + `can_manage_config`。
 *
 * 为什么两个都要：这一趟要**走遍全站每一页**，而 `/users` 只对 `canManageUser` 渲染出内容
 * （无权限时它给的是一句「这个页面需要『管理账号』权限」）。只挂 `full_admin` 的话
 * `/users` 的锚命中 0 —— 实测踩过，表现是「渲染出内容」这条**假红**。
 * 单独一个角色都盖不全：`full_admin` 缺管理特权，`sys_admin` 的数据范围只到 `owned`
 * （看不到别人建的案件，列表页会空）。
 */
const acct = await createSmokeAccount(sql, {
  roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin],
  isAdmin: true,
});
let browser = null;

try {
  // `executablePath` 走仓里那个唯一取法（`_chrome.mjs`），不靠 playwright 自己找修订号 ——
  // 理由见 `_chrome.mjs` 头注（它期望的修订号与本机装的那份可以不一致，本仓因此栽过一次）
  browser = await chromium.launch({ executablePath: pickChrome() });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // 登录走真接口拿会话 cookie（与其余冒烟同法）
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: acct.username, password: acct.password }),
  });
  const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    return { name: pair.slice(0, i), value: pair.slice(i + 1), url: BASE };
  });
  await ctx.addCookies(cookies);
  // 这条不绿的话，下面全部是空壳假绿 —— 所以它单独断言、且最先断言
  ok("临时账号能登录（否则以下全部是空壳假绿）", loginRes.ok, `status=${loginRes.status}`);

  const page = await ctx.newPage();

  /**
   * **详情页**（案件详情）——2026-10-21 补，起因是这天给详情页做原型对齐（页头 / 归档就绪 /
   * 两列评论栏）时才发现：这份冒烟一条详情页都没跑，13 条全是列表页与静态页，
   * 改动最重的一屏恰好落在盲区里。
   *
   * id **不写死**：共享库里的行会变（今天 7001、明天可能是别的 id），写死等于造一条必红的断言。
   * 取法用列表第一行那条 `<a>` 的 href，而不是打 `/api/matters` 读载荷——
   * 前者由页面自己的列定义保证（案名那列就是这个入口），后者换字段名会把冒烟脚本一起改到。
   *
   * 解析结果单独断言：静默跳过这条路由，比它红更难发现（同"空壳假绿"一个性质）。
   */
  let matterDetail = null;
  try {
    await page.goto(`${BASE}/matters`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector('.ant-table-row a[href^="/matters/"]', { timeout: 30000 });
    matterDetail = await page.evaluate(
      () => document.querySelector('.ant-table-row a[href^="/matters/"]')?.getAttribute("href") ?? null,
    );
  } catch (e) {
    matterDetail = null;
  }
  ok("能解析出案件详情路由（解析不了＝下面这一整页失去覆盖）", Boolean(matterDetail), matterDetail ?? "");
  if (matterDetail) {
    // 锚取 `.detail .chat`：它是这一屏独有的结构（两列 + 常驻评论栏），命中即证明布局没塌回单列
    PAGES.push({ path: matterDetail, label: "案件详情", anchor: ".detail .chat" });
  }

  for (const { path, label, anchor } of PAGES) {
    for (const mode of ["light", "dark"]) {
      const tag = `${label} ${path} [${mode}]`;
      // 先设偏好再导航 —— 首帧就打上正确的类（这也验了同步脚本生效）
      await page.addInitScript((m) => {
        try {
          localStorage.setItem("mn-appearance", m);
        } catch {}
      }, mode);

      let resp;
      try {
        resp = await page.goto(`${BASE}${path}`, {
          waitUntil: "networkidle",
          timeout: 45000,
        });
      } catch (e) {
        ok(`${tag} 能打开`, false, e?.message ?? String(e));
        continue;
      }
      await page.waitForTimeout(400);

      if (resp && resp.status() >= 500) {
        ok(`${tag} 能打开`, false, `HTTP ${resp.status()}`);
        continue;
      }

      const m = await page.evaluate(probe, anchor);

      // 深色那条必须真的量到了深色底，否则"深色通过"是假的
      if (mode === "dark") {
        ok(`${tag} 深色偏好真的生效`, m.isDark, m.isDark ? "" : "html.dark 未打上");
      }
      ok(`${tag} 渲染出内容`, m.anchors > 0, `锚命中 ${m.anchors}`);
      ok(`${tag} 底边留白 ≤40px`, m.gap <= 40, `实测 ${m.gap}px`);
      ok(`${tag} 标题不跳级`, m.skip === null, m.skip ?? "");
      ok(
        `${tag} 对比度达标`,
        m.contrastFails.length === 0,
        m.contrastFails.length
          ? m.contrastFails
              .slice(0, 3)
              .map((f) => `${f.color} ${f.ratio}<${f.need} 「${f.text}」`)
              .join("；")
          : "",
      );
    }
  }
} catch (e) {
  fail++;
  console.log(`[FAIL] 视觉冒烟自身出错 — ${e?.message ?? e}`);
} finally {
  try {
    if (browser) await browser.close();
  } catch (e) {
    noteCleanupFailure("浏览器关闭", e);
  }
  try {
    await dropSmokeAccount(sql, acct.id);
  } catch (e) {
    noteCleanupFailure(`临时账号 ${acct.username}（${acct.id}）`, e);
  }
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);

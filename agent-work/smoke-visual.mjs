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
  const bgOf = (el) => {
    let n = el;
    while (n && n !== root) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/rgba?\(0,\s*0,\s*0,\s*0\)/.test(c)) return parse(c);
      n = n.parentElement;
    }
    return isDark ? [16, 19, 23] : [255, 255, 255];
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
    const fg = parse(cs.color);
    if (fg.length < 3) continue;
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    // WCAG：大字（≥18.66px，或 ≥14px 且粗）3:1，其余 4.5:1
    const need = size >= 18.66 || (size >= 14 && bold) ? 3 : 4.5;
    const cr = ratio(fg, bgOf(el));
    if (cr < need) {
      const key = `${cs.color}|${bgOf(el).join(",")}|${need}`;
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

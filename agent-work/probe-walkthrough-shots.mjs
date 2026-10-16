/**
 * MATT-30（真实浏览器观感走查）的**机器可做的那一半**：采集证据，供人眼验收。
 *
 * ## 为什么是"一半"
 *
 * MATT-30 的验收判据是"配色与密度好不好看"——**那件事只有人能判**，
 * 代理给不出结论（给了也是编的）。但这张票卡住的不是判断，是**证据没准备好**：
 * 走查要过五张页、两档视口、还要走一遍焦点环，人坐下来现点一遍成本很高。
 *
 * 所以这个脚本做的是：把五张页 × 两档视口**拍下来**，并把**能机器量的**量出来
 * （横向溢出、行高、容器宽、焦点环是否可见），人只需要看图与读数字。
 *
 * ## 明确不做的
 *
 * 不判"好不好看"。脚本的输出里**没有任何**"通过/不通过"的美学结论——
 * 那会把"我量了溢出"偷换成"我看过了"。票上的结论由人写。
 *
 * ## 用法
 *
 *   node agent-work/probe-walkthrough-shots.mjs
 *
 * 产出：`agent-work/walkthrough/`（两档 × 五张页 + 一张焦点环截图）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pickChrome, playwrightRoot } from "./_chrome.mjs";

const require = createRequire(playwrightRoot());
const { chromium } = require("playwright");
const { createSmokeAccount, dropSmokeAccount, ROLE_CODES } = await import("./_testacct.mjs");
const { default: postgres } = await import("postgres");

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const CHROME = pickChrome();
const OUT = "agent-work/walkthrough";

/** 五张页（MATT-30 判据里点名的那五张） */
const PAGES = [
  { name: "1-登录", path: "/login", needAuth: false },
  // ⚠ 工作台在 `/`（`src/app/(desk)/page.tsx`），**不是** `/workbench`。
  //   初版写成 `/workbench`，拍出来一张 h1=404 的图才暴露——而同一个错在
  //   `probe-reload-loop.mjs` 里**测着 404 页却通过了**（404 页当然不会重载）。
  //   这是本轮反复在抓的那类"静默测错"：断言绿了，但它测的不是你以为的那个东西。
  { name: "2-工作台", path: "/", needAuth: true },
  { name: "3-案件列表", path: "/matters", needAuth: true },
  { name: "4-案件详情", path: null, needAuth: true }, // 用真实案件 id
  { name: "5-事项列表", path: "/risk-matters", needAuth: true },
];

/** 两档视口（MATT-30 判据原文） */
const VIEWPORTS = [
  { label: "1440x900", width: 1440, height: 900 },
  { label: "1920x1080", width: 1920, height: 1080 },
];

mkdirSync(OUT, { recursive: true });

const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const account = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const browser = await chromium.launch({ executablePath: CHROME });
/** 量出来的东西：人读这些数字比读图快，而图负责"好不好看" */
const measured = [];

try {
  // 取一条真实案件（详情页要有内容可看）
  const [someMatter] = await sql`
    select id, name from mn_matter where not is_deleted order by id desc limit 1`;
  const pages = PAGES.map((p) =>
    p.path === null ? { ...p, path: `/matters/${someMatter?.id ?? ""}` } : p,
  );

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
    });
    await ctx.request.post(`${BASE}/api/auth/login`, {
      data: { username: account.username, password: account.password },
    });

    for (const p of pages) {
      const page = await ctx.newPage();
      try {
        await page.goto(`${BASE}${p.path}`, { waitUntil: "networkidle", timeout: 30000 });
      } catch {
        // networkidle 在长轮询页面可能等不到；退回 domcontentloaded + 固定等待
        await page.goto(`${BASE}${p.path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      }
      await page.waitForTimeout(1200);

      const file = `${OUT}/${vp.label}-${p.name}.png`;
      await page.screenshot({ path: file, fullPage: false });

      // 机器能量的：整页横向溢出、主内容容器宽、表格行高（有表时）
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const main = document.querySelector("main") ?? document.body;
        const rows = [...document.querySelectorAll("tbody tr")].slice(0, 3);
        const h = rows
          .map((r) => Math.round(r.getBoundingClientRect().height))
          .filter((x) => x > 0);
        const h1 = document.querySelector("h1");
        return {
          overflowX: de.scrollWidth - de.clientWidth,
          mainWidth: Math.round(main.getBoundingClientRect().width),
          rowHeights: h,
          h1: h1 ? h1.textContent.trim().slice(0, 40) : null,
        };
      });
      measured.push({ viewport: vp.label, page: p.name, ...m });
      await page.close();
    }

    // 焦点环：键盘 Tab 走一遍，看第一个可获得焦点的元素是否可见
    const page = await ctx.newPage();
    await page.goto(`${BASE}/matters`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().slice(0, 30),
        outlineWidth: cs.outlineWidth,
        outlineStyle: cs.outlineStyle,
        boxShadow: cs.boxShadow.slice(0, 60),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
    await page.screenshot({ path: `${OUT}/${vp.label}-6-焦点环.png`, fullPage: false });
    measured.push({ viewport: vp.label, page: "6-焦点环", focus });
    await page.close();
    await ctx.close();
  }
} finally {
  await browser.close();
  await dropSmokeAccount(sql, account.id).catch((e) => console.log("清场:", e.message));
  await sql.end();
}

writeFileSync(`${OUT}/measured.json`, JSON.stringify(measured, null, 2), "utf8");

console.log(`\n截图 ${measured.filter((m) => !m.focus).length} 张 + 焦点环 2 张 → ${OUT}/`);
console.log("\n机器量出来的（**不含任何美学结论**）：");
for (const m of measured) {
  if (m.focus) {
    console.log(
      `  ${m.viewport} 焦点环：${m.focus.tag}「${m.focus.text}」outline=${m.focus.outlineStyle}/${m.focus.outlineWidth} boxShadow=${m.focus.boxShadow || "无"}`,
    );
  } else {
    console.log(
      `  ${m.viewport} ${m.page}：横向溢出 ${m.overflowX}px · 主容器 ${m.mainWidth}px · 行高 [${m.rowHeights.join(",") || "无表"}] · h1=${m.h1 ?? "无"}`,
    );
  }
}
console.log(
  `\n**这张票的结论（配色与密度好不好看）必须由人看着 ${OUT}/ 里的图来写**——` +
    `脚本只提供证据，不给结论。`,
);

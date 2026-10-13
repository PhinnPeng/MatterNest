/**
 * 重载循环门禁：主要页面**不得在同一个地址上反复重新加载**。
 *
 * ## 为什么需要它
 *
 * `probe-staff-ui` 曾在 `page.goto(..., { waitUntil: "networkidle" })` 上超时，
 * 报的是"导航超时"——看起来像探针自己的毛病。实际是**页面在以每秒 ~8 次的速度重新加载**
 * （实测 6 秒 54 次），`networkidle` 永远等不到。根因是**我跑 `pnpm build` 时 dev server 还在跑**，
 * 而两者共用 `.next/`：build 把 `.next` 清掉，dev server 的模块图就坏了
 * （component-guidelines 明写"必须先停掉在跑的实例再 build"）。重启 dev server 后循环消失。
 *
 * 这种缺陷的形状值得单独一条门禁：
 *   · 它**不报错**——页面在转圈，控制台只有一句 "Failed to load resource"；
 *   · 它**让别的探针以假失败告终**（超时/网络空闲），于是人会去改那个探针；
 *   · DOM 断言、接口断言、`tsc`、`vitest` **全都看不见**"页面在自我重载"。
 *
 * ## 判据（两条一起看，缺一条就会误判）
 *
 *   1. 往 `window` 写一个标记，等几秒再读。**标记还在 ⇒ 文档没被换掉**，一定没有循环。
 *   2. 标记被冲掉时，再看**最终 URL**：
 *      · URL 变了（例如未登录访问 `/matters` 被带到 `/login`）⇒ **是重定向，正常**；
 *      · URL 没变 ⇒ **同一个地址被重新加载** ⇒ 那才是循环。
 *
 * ⚠ 初版只看 `page.on("framenavigated")` 的次数，把**文档内跳转**（`router.replace` 同步 URL）
 * 也算成了导航，于是连正常的登录页都报"3 次 = 循环"。**测量方式错了会把人引到错误的修复方向**——
 * 那一轮我差点去改页面。
 *
 * ## 用法
 *
 *   node agent-work/probe-reload-loop.mjs
 *
 * ⚠ 跑之前确认树是自洽的（`pnpm exec tsc --noEmit` 干净）且 **dev server 没被 build 弄坏**：
 * 三个实现子代理并行写入时，`src/shared/enums` 的中间态会让所有接口 500
 * （`ReferenceError: OUTBOX_EVENT_TYPES is not defined`），那时每张页面都在重载——
 * 这条门禁红的是"树坏了"，不是"页面坏了"。不区分的话，人会去改页面。
 */
import { createRequire } from "node:module";

const require = createRequire("F:/WorkSoftware/nvm/v22.22.2/node_modules/playwright/index.js");
const { chromium } = require("playwright");
const { createSmokeAccount, dropSmokeAccount, ROLE_CODES } = await import("./_testacct.mjs");
const { default: postgres } = await import("postgres");

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const CHROME =
  "C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1224/chrome-win64/chrome.exe";
const WINDOW_MS = 5000;

const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const account = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const browser = await chromium.launch({ executablePath: CHROME });

try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  // 先登录：不登录访问受保护页面会被带到 /login（那是正常重定向，不是循环），
  // 但那样就测不到真正的页面了。
  const login = await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: account.username, password: account.password },
  });
  ok("夹具账号能登录", login.status() === 200, `status=${login.status()}`);

  // ⚠ 工作台在 `/`（`src/app/(desk)/page.tsx`），**不是** `/workbench`。
  //   初版写成 `/workbench`：`probe-walkthrough-shots` 拍出一张 h1=404 的图才暴露，
  //   而本脚本**测着 404 页却通过了**——404 页当然不会重载。
  //   这是本轮反复在抓的那类"静默测错"：断言绿了，但它测的不是你以为的那个东西。
  for (const path of [
      "/",
      "/notifications",
      "/matters",
      "/risk-matters",
      "/parties",
      "/users",
      "/archive",
    ]) {
    const page = await ctx.newPage();
    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });

    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 25000 });
    } catch (e) {
      ok(`${path} 能打开`, false, String(e).slice(0, 80));
      await page.close();
      continue;
    }

    const startUrl = page.url().replace(BASE, "");
    await page.evaluate(() => {
      window.__marker = "kept";
    });
    await page.waitForTimeout(WINDOW_MS);
    const kept = await page.evaluate(() => window.__marker === "kept").catch(() => false);
    const endUrl = page.url().replace(BASE, "");

    ok(
      `${path} 没有同址重载`,
      kept || endUrl !== startUrl,
      kept
        ? `标记保住（${WINDOW_MS / 1000}s 内 load ${loads} 次）`
        : endUrl !== startUrl
          ? `重定向到 ${endUrl}（正常，load ${loads} 次）`
          : `**同一地址被重新加载**：load ${loads} 次`,
    );
    await page.close();
  }
} finally {
  await browser.close();
  await dropSmokeAccount(sql, account.id).catch((e) => console.log("清场:", e.message));
  await sql.end();
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

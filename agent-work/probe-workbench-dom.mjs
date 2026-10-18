import { chromium } from "playwright";
import { pickChrome } from "./_chrome.mjs";
import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

/**
 * 一次性探针：工作台 `/` 在 MATT-99 换 canon 类之后**还剩哪些可当锚的元素**。
 *
 * `smoke-visual.mjs` 给 `/` 的锚是 `table tbody tr, .ant-card`，实机命中 0 ——
 * 需要分清是「页面真的空了」还是「锚过期了」。前者是缺陷，后者是脚本要更新。
 */
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin] });
try {
  const browser = await chromium.launch(pickChrome());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="text"]', acct.username);
  await page.fill('input[type="password"]', acct.password);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);

  for (const path of ["/", "/matters", "/roles"]) {
    await page.goto(`${BASE}${path}`);
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => {
      const cls = {};
      for (const n of document.querySelectorAll("*")) {
        for (const c of n.classList) cls[c] = (cls[c] ?? 0) + 1;
      }
      const top = Object.entries(cls)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 26)
        .map(([k, v]) => `${k}:${v}`);
      return {
        h1: document.querySelector("h1")?.textContent?.trim() ?? null,
        size: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
        counts: {
          "table tbody tr": document.querySelectorAll("table tbody tr").length,
          ".ant-card": document.querySelectorAll(".ant-card").length,
          ".card": document.querySelectorAll(".card").length,
          ".metrics": document.querySelectorAll(".metrics").length,
          ".metric": document.querySelectorAll(".metric").length,
          ".panel": document.querySelectorAll(".panel").length,
          ".tbl": document.querySelectorAll(".tbl").length,
          main: document.querySelectorAll("main").length,
        },
        topClasses: top,
      };
    });
    console.log(`\n===== ${path} =====`);
    console.log(JSON.stringify(r, null, 2));
  }
  await browser.close();
} finally {
  await dropSmokeAccount(sql, acct.id);
  await sql.end();
}

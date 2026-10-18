import { chromium } from "playwright";
import { pickChrome } from "./_chrome.mjs";
import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
import { mkdirSync } from "node:fs";

/** PR 的视觉取证：若干代表页 × 明暗两版（真页，非原型）。 */
const { default: postgres } = await import("postgres");
const sql = postgres({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, database: process.env.PGDATABASE, password: process.env.PGPASSWORD });
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const OUT = process.argv[2] ?? ".";
mkdirSync(OUT, { recursive: true });

const PAGES = [
  ["workbench", "/"],
  ["matters", "/matters"],
  ["roles", "/roles"],
  ["config-detail", "/config/case_status"],
  ["login", "/login"],
];

const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin] });
try {
  const browser = await chromium.launch({ executablePath: pickChrome() });
  for (const mode of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // 登录（login 页本身不需要，但同一 ctx 拿到 cookie 后仍可访问它）
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: acct.username, password: acct.password }),
    });
    const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => {
      const [pair] = c.split(";"); const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), url: BASE };
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    for (const [name, path] of PAGES) {
      await page.addInitScript((m) => { try { localStorage.setItem("mn-appearance", m); } catch {} }, mode);
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(mode === "dark" && name === "login" ? 800 : 1600);
      // login 页在已登录时仍可直接访问（无 middleware 重定向，实测过）
      await page.screenshot({ path: `${OUT}/${name}-${mode}.png`, fullPage: false });
      console.log(`shot ${name}-${mode}`);
    }
    await ctx.close();
  }
  await browser.close();
} finally {
  await dropSmokeAccount(sql, acct.id);
  await sql.end();
}

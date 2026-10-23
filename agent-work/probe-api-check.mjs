import { pickChrome } from "./_chrome.mjs";
import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3777";
import postgres from "postgres";
import { createSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
const sql = postgres({ host: process.env.PGHOST, port: +process.env.PGPORT, user: process.env.PGUSER, database: process.env.PGDATABASE, password: process.env.PGPASSWORD });
const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin], isAdmin: true });
const browser = await chromium.launch({ executablePath: pickChrome() });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const loginRes = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: acct.username, password: acct.password }) });
const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => { const [pair]=c.split(";"); const i=pair.indexOf("="); return { name: pair.slice(0,i), value: pair.slice(i+1), url: BASE }; });
await ctx.addCookies(cookies);
page.on("response", r => { if (r.url().includes("/api/matters") && !r.url().includes("metrics")) console.log("RESP", r.status(), r.url()); });
await page.goto(`${BASE}/matters`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2500);
const info = await page.evaluate(() => ({
  tbody: document.querySelectorAll('.ant-table-tbody tr').length,
  rows: document.querySelectorAll('.ant-table-row').length,
  thead: document.querySelectorAll('.ant-table-thead th').length,
  emptyText: document.querySelector('.ant-empty')?.innerText?.slice(0,60) ?? null,
  bodyText: document.body.innerText.slice(0, 300),
}));
console.log(JSON.stringify(info, null, 1));
await browser.close(); await sql.end();

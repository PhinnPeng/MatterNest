import { pickChrome } from "./_chrome.mjs";
import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3777";
import postgres from "postgres";
import { createSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
const sql = postgres({ host: process.env.PGHOST, port: +process.env.PGPORT, user: process.env.PGUSER, database: process.env.PGDATABASE, password: process.env.PGPASSWORD });
const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin], isAdmin: true });
const browser = await chromium.launch({ executablePath: pickChrome() });
for (const [W, name] of [[2560, "2560"], [1366, "1366"]]) {
  const ctx = await browser.newContext({ viewport: { width: W, height: 1000 } });
  const page = await ctx.newPage();
  const loginRes = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: acct.username, password: acct.password }) });
  const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => { const [pair]=c.split(";"); const i=pair.indexOf("="); return { name: pair.slice(0,i), value: pair.slice(i+1), url: BASE }; });
  await ctx.addCookies(cookies);
  await page.goto(`${BASE}/matters`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector(".ant-table-row", { timeout: 30000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `agent-work/_shot-matters-${name}.png` });
  console.log("saved", W);
  await ctx.close();
}
await browser.close(); await sql.end();

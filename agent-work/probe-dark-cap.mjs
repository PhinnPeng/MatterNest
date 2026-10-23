import { pickChrome } from "./_chrome.mjs";
import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3777";
import postgres from "postgres";
import { createSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
const sql = postgres({ host: process.env.PGHOST, port: +process.env.PGPORT, user: process.env.PGUSER, database: process.env.PGDATABASE, password: process.env.PGPASSWORD });
const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin], isAdmin: true });
const browser = await chromium.launch({ executablePath: pickChrome() });
for (const mode of ["light","dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 900 } });
  const page = await ctx.newPage();
  const loginRes = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: acct.username, password: acct.password }) });
  const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => { const [pair]=c.split(";"); const i=pair.indexOf("="); return { name: pair.slice(0,i), value: pair.slice(i+1), url: BASE }; });
  await ctx.addCookies(cookies);
  await page.addInitScript((m) => { try { localStorage.setItem("mn-appearance", m); } catch {} }, mode);
  await page.goto(`${BASE}/matters`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const th = document.querySelector('.ant-table-thead th:nth-child(2)');
    const cs = th ? getComputedStyle(th) : null;
    const content = document.querySelector('.ant-table-content');
    return { dark: document.documentElement.classList.contains("dark"), thFs: cs?.fontSize, thFw: cs?.fontWeight, thColor: cs?.color, thBg: cs?.backgroundColor, overflow: content ? content.scrollWidth > content.clientWidth + 1 : null, stackW: document.querySelector('.stack') ? Math.round(document.querySelector('.stack').getBoundingClientRect().width) : null };
  });
  console.log(mode, JSON.stringify(r));
  await ctx.close();
}
await browser.close(); await sql.end();

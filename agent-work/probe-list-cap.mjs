import { pickChrome } from "./_chrome.mjs";
import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3777";
import postgres from "postgres";
import { createSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
const sql = postgres({ host: process.env.PGHOST, port: +process.env.PGPORT, user: process.env.PGUSER, database: process.env.PGDATABASE, password: process.env.PGPASSWORD });
const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin], isAdmin: true });
const browser = await chromium.launch({ executablePath: pickChrome() });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 900 } });
const page = await ctx.newPage();
const loginRes = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: acct.username, password: acct.password }) });
const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => { const [pair]=c.split(";"); const i=pair.indexOf("="); return { name: pair.slice(0,i), value: pair.slice(i+1), url: BASE }; });
await ctx.addCookies(cookies);
for (const path of ["/matters", "/risk-matters", "/parties", "/users", "/archive"]) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const stack = document.querySelector('.stack');
    const cards = [...document.querySelectorAll('.ant-card')];
    const th = document.querySelector('.ant-table-thead th:nth-child(2)') || document.querySelector('.ant-table-thead th');
    const cs = th ? getComputedStyle(th) : null;
    return {
      stackW: stack ? Math.round(stack.getBoundingClientRect().width) : null,
      stackL: stack ? Math.round(stack.getBoundingClientRect().left) : null,
      lastCardW: cards.length ? Math.round(cards[cards.length-1].getBoundingClientRect().width) : null,
      rows: document.querySelectorAll('.ant-table-row').length,
      thFs: cs?.fontSize ?? null, thFw: cs?.fontWeight ?? null, thColor: cs?.color ?? null,
      overflowX: (() => { const c = document.querySelector('.ant-table-content'); return c ? c.scrollWidth > c.clientWidth + 1 : null; })(),
    };
  });
  console.log(path, JSON.stringify(r));
}
await browser.close(); await sql.end();

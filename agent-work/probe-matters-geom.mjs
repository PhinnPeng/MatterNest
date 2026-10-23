import { pickChrome } from "./_chrome.mjs";
import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3777";
import postgres from "postgres";
import { createSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
const sql = postgres({
  host: process.env.PGHOST, port: Number(process.env.PGPORT),
  user: process.env.PGUSER, database: process.env.PGDATABASE, password: process.env.PGPASSWORD,
});
const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin], isAdmin: true });
const browser = await chromium.launch({ executablePath: pickChrome() });
for (const W of [1366, 1440, 1920, 2560]) {
  const ctx = await browser.newContext({ viewport: { width: W, height: 900 } });
  const page = await ctx.newPage();
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: acct.username, password: acct.password }),
  });
  const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => { const [pair]=c.split(";"); const i=pair.indexOf("="); return { name: pair.slice(0,i), value: pair.slice(i+1), url: BASE }; });
  await ctx.addCookies(cookies);
  await page.goto(`${BASE}/matters`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(800);
  const res = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.ant-card')];
    const card = cards[cards.length - 1];
    const table = document.querySelector('.ant-table table') || document.querySelector('.ant-table');
    const ths = [...document.querySelectorAll('.ant-table-thead th')].map((t,i)=>({i,text:t.innerText.trim().replace(/\n/g,' '),w:Math.round(t.getBoundingClientRect().width),fs:getComputedStyle(t).fontSize,h:Math.round(t.getBoundingClientRect().height)}));
    const tds = [...document.querySelectorAll('.ant-table-tbody tr:first-child td')].map((t,i)=>({i,text:t.innerText.trim().replace(/\n/g,' ').slice(0,24),w:Math.round(t.getBoundingClientRect().width),fs:getComputedStyle(t).fontSize}));
    const row = document.querySelector('.ant-table-tbody tr:first-child');
    const trh = row ? Math.round(row.getBoundingClientRect().height) : null;
    const content = document.querySelector('.ant-table-content');
    const container = document.querySelector('.ant-table-container');
    const cardRect = card.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    return { W: window.innerWidth, card: {w:Math.round(cardRect.width),l:Math.round(cardRect.left)}, table: {w:Math.round(tableRect.width), overflowX: table?getComputedStyle(table).overflowX:null, layout: table?getComputedStyle(table).tableLayout:null}, containerW: container?Math.round(container.getBoundingClientRect().width):null, contentW: content?Math.round(content.getBoundingClientRect().width):null, trh, ths, tds };
  });
  console.log("=== viewport", W, "===");
  console.log(JSON.stringify(res, null, 1));
  await ctx.close();
}
await browser.close();
await sql.end();

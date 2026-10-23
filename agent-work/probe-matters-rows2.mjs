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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: acct.username, password: acct.password }),
});
const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => { const [pair]=c.split(";"); const i=pair.indexOf("="); return { name: pair.slice(0,i), value: pair.slice(i+1), url: BASE }; });
await ctx.addCookies(cookies);
await page.goto(`${BASE}/matters`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(2000);
const res = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.ant-table-tbody tr')];
  const ths = [...document.querySelectorAll('.ant-table-thead th')].map((t,i)=>({i,text:t.innerText.replace(/\n/g,' '),h:Math.round(t.getBoundingClientRect().height),fs:getComputedStyle(t).fontSize,fw:getComputedStyle(t).fontWeight,bg:getComputedStyle(t).backgroundColor}));
  const firstTd = rows[0] ? rows[0].querySelectorAll('td') : [];
  const tds = [...firstTd].map((t,i)=>({i, text:t.innerText.slice(0,30).replace(/\n/g,' '), h:Math.round(t.getBoundingClientRect().height), fs:getComputedStyle(t).fontSize}));
  const nameLink = document.querySelector('.ant-table-tbody tr td:nth-child(3) a');
  const nameCs = nameLink ? getComputedStyle(nameLink) : null;
  const card = [...document.querySelectorAll('.ant-card')].pop();
  const stack = document.querySelector('.stack');
  return { rows: rows.length, ths, tds: tds.slice(0,6), name: nameLink ? {text:nameLink.textContent, fs:nameCs.fontSize, fw:nameCs.fontWeight, color:nameCs.color} : null, cardW: card?Math.round(card.getBoundingClientRect().width):null, stackW: stack?Math.round(stack.getBoundingClientRect().width):null };
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
await sql.end();

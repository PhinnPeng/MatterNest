import { pickChrome } from "./_chrome.mjs";
import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3777";
import postgres from "postgres";
import { createSmokeAccount, ROLE_CODES } from "./_testacct.mjs";
const sql = postgres({ host: process.env.PGHOST, port: +process.env.PGPORT, user: process.env.PGUSER, database: process.env.PGDATABASE, password: process.env.PGPASSWORD });
const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin], isAdmin: true });
const browser = await chromium.launch({ executablePath: pickChrome() });
const ctx = await browser.newContext({ viewport: { width: 2560, height: 900 } });
const page = await ctx.newPage();
const loginRes = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: acct.username, password: acct.password }) });
const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => { const [pair]=c.split(";"); const i=pair.indexOf("="); return { name: pair.slice(0,i), value: pair.slice(i+1), url: BASE }; });
await ctx.addCookies(cookies);
await page.goto(`${BASE}/matters`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForSelector(".ant-table-row", { timeout: 30000 });
await page.waitForTimeout(500);
const res = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')];
  const th = document.querySelector('.ant-table-thead th:nth-child(2)');
  const td = document.querySelector('.ant-table-tbody tr.ant-table-row td:nth-child(2)');
  const nameA = document.querySelector('.ant-table-tbody tr.ant-table-row td:nth-child(3) a');
  const card = [...document.querySelectorAll('.ant-card')].pop();
  return {
    rowHeights: rows.slice(0,3).map(r=>Math.round(r.getBoundingClientRect().height)),
    thH: th?Math.round(th.getBoundingClientRect().height):null,
    thFs: th?getComputedStyle(th).fontSize:null,
    thFw: th?getComputedStyle(th).fontWeight:null,
    tdFs: td?getComputedStyle(td).fontSize:null,
    nameFs: nameA?getComputedStyle(nameA).fontSize:null,
    nameFw: nameA?getComputedStyle(nameA).fontWeight:null,
    cardW: card?Math.round(card.getBoundingClientRect().width):null,
    cardMaxW: card?getComputedStyle(card).maxWidth:null,
  };
});
console.log(JSON.stringify(res, null, 1));
await browser.close(); await sql.end();

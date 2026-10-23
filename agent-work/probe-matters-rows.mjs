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
for (const W of [1366, 1920]) {
  const ctx = await browser.newContext({ viewport: { width: W, height: 900 } });
  const page = await ctx.newPage();
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: acct.username, password: acct.password }),
  });
  const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => { const [pair]=c.split(";"); const i=pair.indexOf("="); return { name: pair.slice(0,i), value: pair.slice(i+1), url: BASE }; });
  await ctx.addCookies(cookies);
  await page.goto(`${BASE}/matters`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector(".ant-table-row", { timeout: 30000 }).catch(()=>{});
    await page.waitForTimeout(600);
  const res = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.ant-table-row')];
    const th = document.querySelector('.ant-table-thead th:nth-child(2)');
    const thCs = th ? getComputedStyle(th) : null;
    const card = [...document.querySelectorAll('.ant-card')].pop();
    const cardCs = card ? getComputedStyle(card) : null;
    const nameCell = document.querySelector('.ant-table-row td:nth-child(3)');
    const nameLink = nameCell ? nameCell.querySelector('a') : null;
    const nameCs = nameLink ? getComputedStyle(nameLink) : null;
    const nameText = nameLink ? nameLink.textContent : null;
    const stack = document.querySelector('.stack');
    const pageEl = document.querySelector('.page');
    const main = document.querySelector('.main');
    return {
      vp: window.innerWidth,
      rowHeights: rows.slice(0,4).map(r => Math.round(r.getBoundingClientRect().height)),
      rowCount: rows.length,
      th: { fs: thCs?.fontSize, fw: thCs?.fontWeight, color: thCs?.color, bg: thCs?.backgroundColor, h: th ? Math.round(th.getBoundingClientRect().height) : null, text: th?.innerText },
      tdFont: (()=>{const td=document.querySelector('.ant-table-row td:nth-child(2)'); return td?getComputedStyle(td).fontSize:null})(),
      name: { fs: nameCs?.fontSize, fw: nameCs?.fontWeight, color: nameCs?.color, text: nameText, w: nameCell?Math.round(nameCell.getBoundingClientRect().width):null },
      cardMaxW: cardCs?.maxWidth, cardW: card?Math.round(card.getBoundingClientRect().width):null,
      pageMaxW: pageEl?getComputedStyle(pageEl).maxWidth:null, pageW: pageEl?Math.round(pageEl.getBoundingClientRect().width):null,
      mainW: main?Math.round(main.getBoundingClientRect().width):null,
      stackW: stack?Math.round(stack.getBoundingClientRect().width):null,
    };
  });
  console.log("=== " + W + " ===");
  console.log(JSON.stringify(res, null, 1));
  await ctx.close();
}
await browser.close();
await sql.end();

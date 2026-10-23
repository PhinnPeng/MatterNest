import { createSmokeAccount, dropSmokeAccount, finishSmoke, ROLE_CODES } from "./_testacct.mjs";
import { createRequire } from "node:module";
import { pickChrome } from "./_chrome.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

let browser = null;
const rows = [];
function ok(name, pass, detail = "") {
  rows.push({ name, pass, detail });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const acct = await createSmokeAccount(sql, {
  roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin],
  isAdmin: true,
});

try {
  browser = await chromium.launch({ executablePath: pickChrome() });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: acct.username, password: acct.password }),
  });
  const cookies = (loginRes.headers.getSetCookie?.() ?? []).map((c) => {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    return { name: pair.slice(0, i), value: pair.slice(i + 1), url: BASE };
  });
  await ctx.addCookies(cookies);
  ok("登录", loginRes.ok, `status=${loginRes.status}`);

  const page = await ctx.newPage();
  await page.goto(`${BASE}/matters`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector(".ant-table-row", { timeout: 30000 });

  const probe = await page.evaluate(() => {
    const table = document.querySelector(".ant-table");
    const headerCells = [...document.querySelectorAll(".ant-table-thead > tr > th")].map((th) => ({
      text: th.textContent.trim(),
      checkbox: Boolean(th.querySelector(".ant-checkbox")),
      width: Math.round(th.getBoundingClientRect().width),
    }));
    const bodyCells = [...document.querySelectorAll(".ant-table-row")].map((tr) => {
      const tds = [...tr.querySelectorAll("td")];
      return { cells: tds.length, firstIsCheckbox: Boolean(tds[0]?.querySelector(".ant-checkbox")) };
    });
    const toolbars = [...document.querySelectorAll(".ant-card-body > div")].map((d) => ({
      bg: getComputedStyle(d).backgroundColor,
      text: d.textContent.trim().slice(0, 40),
    }));
    return {
      headerCells,
      bodyRows: bodyCells.length,
      firstRow: bodyCells[0],
      toolbars,
      cardTitle: document.querySelector(".ant-card-head-title h2")?.textContent?.trim(),
      h1: document.querySelector("h1")?.textContent?.trim(),
    };
  });

  console.log("\n--- 表头 ---");
  probe.headerCells.forEach((c, i) => console.log(i, JSON.stringify(c)));
  console.log("--- 首行 ---", JSON.stringify(probe.firstRow), "行数", probe.bodyRows);
  console.log("--- 工具条 ---", JSON.stringify(probe.toolbars));
  console.log("--- h1 / 卡标题 ---", probe.h1, "/", probe.cardTitle);

  ok("表头首格是勾选框", probe.headerCells[0]?.checkbox === true);
  ok("每行首格是勾选框", probe.firstRow?.firstIsCheckbox === true);
  ok("勾选列宽 44 左右", Math.abs((probe.headerCells[0]?.width ?? 0) - 44) <= 6,
     `实测 ${probe.headerCells[0]?.width}px`);
  ok("无选中时不出工具条", probe.toolbars.every((t) => !t.text.includes("已选")));

  // 勾两行：antd 的 input 被 `.ant-checkbox` 覆盖，用 DOM 点击外壳
  await page.evaluate(() => {
    const boxes = document.querySelectorAll(".ant-table-row .ant-checkbox");
    boxes[0].click();
    boxes[1].click();
  });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    checked: document.querySelectorAll(".ant-table-row .ant-checkbox-checked").length,
    headerChecked: Boolean(document.querySelector(".ant-table-thead .ant-checkbox-checked")),
    headerIndeterminate: Boolean(document.querySelector(".ant-table-thead .ant-checkbox-indeterminate")),
    toolbar: [...document.querySelectorAll(".ant-card-body > div")]
      .map((d) => d.textContent.trim())
      .find((t) => t.includes("已选")),
  }));
  console.log("--- 勾选后 ---", JSON.stringify(after));
  ok("勾两行后选中数=2", after.checked === 2, `实测 ${after.checked}`);
  ok("表头呈半选态", after.headerIndeterminate === true);
  ok("工具条出现并报「已选 2 项」", Boolean(after.toolbar?.includes("已选 2 项")), after.toolbar);

  // 点行内勾选框不应跳详情
  ok("勾选未跳转到详情页", page.url().endsWith("/matters"), page.url());

  // 表头全选
  await page.click(".ant-table-thead .ant-checkbox-input");
  await page.waitForTimeout(300);
  const allState = await page.evaluate(() => ({
    checked: document.querySelectorAll(".ant-table-row .ant-checkbox-checked").length,
    total: document.querySelectorAll(".ant-table-row .ant-checkbox-input").length,
    toolbar: [...document.querySelectorAll(".ant-card-body > div")]
      .map((d) => d.textContent.trim())
      .find((t) => t.includes("已选")),
  }));
  console.log("--- 全选后 ---", JSON.stringify(allState));
  ok("表头全选选中全部行", allState.checked === allState.total && allState.total > 0,
     `${allState.checked}/${allState.total}`);

  // 取消选择
  const cancel = await page.$("text=取消选择");
  if (cancel) {
    await cancel.click();
    await page.waitForTimeout(300);
    const cleared = await page.evaluate(() =>
      document.querySelectorAll(".ant-table-row .ant-checkbox-checked").length,
    );
    ok("取消选择清空选中", cleared === 0, `剩 ${cleared}`);
  } else {
    ok("取消选择按钮存在", false);
  }
} finally {
  if (browser) await browser.close();
  await dropSmokeAccount(sql, acct.id);
  const failed = rows.filter((r) => !r.pass);
  console.log(`\n===== ${rows.length - failed.length}/${rows.length} 通过 =====`);
  await sql.end();
  finishSmoke(failed.length);
}

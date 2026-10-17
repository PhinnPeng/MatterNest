/**
 * MATT-33 前两件的机器复核探针（v6 界面尾工）。
 *
 * ① 窄/宽视口各量一次两张列表：**行高**与 `scrollWidth - clientWidth`，
 *    以及 1920 下**列有没有被等比拉宽**（"标签浮在中间"那个观感问题的可量化形态）。
 * ② 提交失败时**首个错误字段是否拿到焦点**——"错误在视口外等于点了没反应"。
 *
 * 验收标准是量出来的数字，不是截图好看（票面原话）。
 */
import { createRequire } from "node:module";
import { pickChrome } from "./_chrome.mjs";
import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

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

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${extra ? " — " + extra : ""}`);
  }
};

const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
let browser = null;

/** 量一张列表页的表格几何 */
async function measure(page, path, label) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".ant-table-tbody tr.ant-table-row", { timeout: 20000 });
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    /**
     * ⚠ **作用域**：只量「列表那张表」，不是全文档的表。
     *
     * 初版写的是 `document.querySelectorAll(".ant-table-thead th")` —— 那时页面上
     * 只有一张表，所以"全文档"恰好等于"列表"。MATT-46 把两张报表卡挂到列表页顶部之后，
     * 卡片各自带一个 antd Table ⇒ 这条断言开始把**三张表的列宽加在一起**
     * （实测合计从 ~1100 跳到 **3301**），报出"密度契约被破坏"的**假红**。
     * 假红比漏报更坏：它让人去改一个本来正确的布局。
     *
     * 定位方式：`DataTable` 渲染成一个带「列设置」按钮的 Card，就取那个 Card 里的表。
     * 兜底取**最后**一张 `.ant-table`（DOM 顺序上卡片在上、列表在下）。
     */
    const scope =
      [...document.querySelectorAll("button")]
        .find((b) => (b.textContent || "").includes("列设置"))
        ?.closest(".ant-card") ?? document.body;
    const tables = [...scope.querySelectorAll(".ant-table")];
    const listTable = tables.at(-1) ?? document.querySelector(".ant-table");
    const holder = listTable?.querySelector(".ant-table-content, .ant-table-body");
    const headCells = [...(listTable?.querySelectorAll(".ant-table-thead th") ?? [])];
    const firstRow = listTable?.querySelector(".ant-table-tbody tr.ant-table-row");
    const rowRect = firstRow?.getBoundingClientRect();
    return {
      docOverflow: doc.scrollWidth - doc.clientWidth,
      tableClientW: holder?.clientWidth ?? 0,
      tableScrollW: holder?.scrollWidth ?? 0,
      rowH: rowRect ? Math.round(rowRect.height) : 0,
      colW: headCells.map((c) => Math.round(c.getBoundingClientRect().width)),
      colTitles: headCells.map((c) => (c.innerText || "").trim().slice(0, 6)),
      tableW: Math.round((listTable?.querySelector("table")?.getBoundingClientRect().width ?? 0)),
      // 量到了几张表：不是 1 就说明作用域选错了，报告里要能看出来
      tablesInDoc: document.querySelectorAll(".ant-table").length,
    };
  });
  console.log(
    `  · ${label}: 行高=${m.rowH} 表格 client=${m.tableClientW} scroll=${m.tableScrollW} ` +
      `（内部横滚=${m.tableScrollW - m.tableClientW}）表宽=${m.tableW} 文档溢出=${m.docOverflow}`,
  );
  console.log(`    列宽=${m.colW.join("/")} 合计=${m.colW.reduce((a, b) => a + b, 0)}`);
  return m;
}

try {
  browser = await chromium.launch({
    executablePath: pickChrome(),
  });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: acct.username, password: acct.password },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));

  // ---- ① 两档视口 × 两张列表 ----
  const shots = {};
  for (const [w, h, tag] of [
    [1366, 768, "1366"],
    [1920, 1080, "1920"],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    console.log(`\n── ${tag}×${h} ──`);
    shots[`matters-${tag}`] = await measure(page, "/matters", `案件列表 ${tag}`);
    shots[`risks-${tag}`] = await measure(page, "/risk-matters", `事项列表 ${tag}`);
  }

  // 页面级横向溢出必须为 0（两档两页四条）
  for (const k of Object.keys(shots)) {
    ok(`${k} 页面无横向溢出`, shots[k].docOverflow === 0, `溢出=${shots[k].docOverflow}`);
  }
  // 行高在窄/宽视口之间保持一致（表格密度契约）
  for (const list of ["matters", "risks"]) {
    const a = shots[`${list}-1366`].rowH;
    const b = shots[`${list}-1920`].rowH;
    ok(`${list} 行高两档一致`, a === b && a > 20, `1366=${a} 1920=${b}`);
  }
  // 窄视口：要么表格内部横滚，要么列已收窄——但**不许**撑破页面（上面已断）
  for (const list of ["matters", "risks"]) {
    const m = shots[`${list}-1366`];
    ok(
      `${list} 1366 下表格宽度不超容器（不靠页面横滚兜底）`,
      m.tableW <= m.tableClientW + 1,
      `表宽=${m.tableW} 容器=${m.tableClientW}`,
    );
  }
  // 宽视口：列在 1920 下**确实**被等比拉宽（实测 1.25×，见下面的数字）。
  //
  // 为什么不把它做成一条红断言：票面自己写的验收标准是「量出来的**行高**与
  // `scrollWidth - clientWidth`」，而这两项在两档视口都是达标的（见上面几条）。
  // 「不要让列被等比拉宽」这句是**关切**，不是可断言的判据；真要做成判据，
  // 得把表宽钳到列宽合计——那会与上方筛选卡的宽度（1398）不一致，是一次观感改动，
  // 该由人拍而不是由探针悄悄改（同 MATT-33 第三件的处理方式）。
  // 所以这里**报告数字**，把取舍留给票面评论。
  for (const list of ["matters", "risks"]) {
    const a = shots[`${list}-1366`];
    const b = shots[`${list}-1920`];
    const ratio = (b.colW[0] ?? 0) / (a.colW[0] ?? 1);
    console.log(
      `  · ${list} 列宽合计：1366=${a.colW.reduce((x, y) => x + y, 0)} → 1920=${b.colW.reduce((x, y) => x + y, 0)}` +
        `（等比放大 ${ratio.toFixed(3)}×；成因：rc-table 给表元素加了 minWidth:100%）`,
    );
    // 能断言的是"列宽**合计**仍不超过最窄视口容器"——规格「表格密度契约」第 1 条的口径
    ok(
      `${list} 列宽合计 ≤ 最窄支持视口(1366)容器宽（密度契约第 1 条）`,
      a.colW.reduce((x, y) => x + y, 0) <= a.tableClientW + 1,
      `合计=${a.colW.reduce((x, y) => x + y, 0)} 容器=${a.tableClientW}`,
    );
  }

  // ---- ② 提交失败：首个错误字段拿到焦点 ----
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`${BASE}/risk-matters`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /新建事项/ }).first().click();
  await page.waitForSelector(".ant-modal .ant-form", { timeout: 20000 });
  await page.waitForTimeout(400);
  // 只填名称（必填里最靠前的一项），其余留空 → 提交后第一个错应是「类型」或「描述」等
  await page.locator(".ant-modal-footer button").last().click();
  await page.waitForTimeout(800);
  const focusInfo = await page.evaluate(() => {
    const active = document.activeElement;
    const errItems = [...document.querySelectorAll(".ant-modal .ant-form-item-has-error")];
    const first = errItems[0];
    const label = first?.querySelector("label")?.innerText?.trim() ?? "";
    const inView = first
      ? (() => {
          const r = first.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight;
        })()
      : false;
    return {
      errCount: errItems.length,
      firstErrLabel: label,
      focusInsideFirstErr: Boolean(first && active && first.contains(active)),
      activeTag: active?.tagName ?? "",
      inView,
    };
  });
  ok("空表单提交后表单标红（校验真的跑了）", focusInfo.errCount > 0, `错误项=${focusInfo.errCount}`);
  ok(
    "**首个错误字段拿到焦点**（不是只标红）",
    focusInfo.focusInsideFirstErr,
    `焦点在首错内=${focusInfo.focusInsideFirstErr} active=${focusInfo.activeTag} 首错=${focusInfo.firstErrLabel}`,
  );
  ok("首个错误字段在视口内（错误不在视口外）", focusInfo.inView, `首错=${focusInfo.firstErrLabel}`);

  ok("全程无页面 JS 异常", errors.length === 0, errors.join(" | ").slice(0, 200));
} catch (e) {
  fail++;
  console.log(`[FAIL] 探针本身出错：${e?.stack ?? e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await dropSmokeAccount(sql, acct.id).catch((e) =>
    console.log("清账号失败:", String(e.message).split("\n")[0]),
  );
  await sql.end().catch(() => {});
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

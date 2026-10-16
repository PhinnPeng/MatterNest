/**
 * 费用 UI 的真浏览器 CRUD 测试 —— 补上 HTTP 冒烟**结构上看不见**的那一半。
 *
 * ## 为什么必须有它
 *
 * MATT-47 的 67 条冒烟全是 HTTP 层。而检查子代理抓到的那条阻断缺陷正好落在
 * **HTTP 看不见的地方**：编辑弹窗的 `initialValues` 漏了 `occurredDate`，
 * 而 update schema 里该字段是选填 ⇒ 客户端校验放行 ⇒ `v.occurredDate.format()` 对
 * `undefined` 取属性抛 TypeError；`onOk` 是 async 而 antd 不 await ⇒
 * **点「保存」毫无反应、无报错、无 loading**。
 *
 * 这类缺陷的形状是：**服务端全对、接口全 200、只有人点下去才知道**。
 * 检查子代理因本机浏览器面板 0×0 无法复现，只给了静态推断 —— 本脚本把它坐实。
 *
 * ## 它验什么
 *
 *   ① 登记一笔费用（新建路径）→ 行出现；
 *   ② 点「编辑」→ **日期框必须是回填过的**（这正是缺陷点，空的就是坏的）；
 *   ③ 改金额 → 点「保存」→ 行真的变了（不是"点了没反应"）；
 *   ④ 控制台/页面**没有**未捕获异常。
 *
 * 用法：`node --env-file=.env agent-work/probe-expense-ui.mjs`
 */
import { createRequire } from "node:module";
import { pickChrome } from "./_chrome.mjs";

const require = createRequire("F:/WorkSoftware/nvm/v22.22.2/node_modules/playwright/index.js");
const { chromium } = require("playwright");
const { createSmokeAccount, dropSmokeAccount, ROLE_CODES } = await import("./_testacct.mjs");
const { default: postgres } = await import("postgres");

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const CHROME = pickChrome();
const stamp = Date.now().toString(36).slice(-6);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const acc = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
let matterId = null;
const pageErrors = [];
let browser;

try {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: acc.username, password: acc.password }),
  });
  ok("夹具账号能登录", login.status === 200, `status=${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  const mk = await fetch(`${BASE}/api/matters`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      name: `费用 UI 探针 ${stamp}`,
      cause: "买卖合同纠纷",
      caseType: "civil_commercial",
      procedure: "first_instance",
      litigationRole: "plaintiff",
      level: "high",
    }),
  });
  const mb = await mk.json();
  matterId = mb.id;
  ok("夹具案件建出来了", mk.status === 201, `status=${mk.status}`);

  browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: acc.username, password: acc.password },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 160)));

  await page.goto(`${BASE}/matters/${matterId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator(".ant-tabs-tab", { hasText: "费用" }).first().click();
  await page.waitForTimeout(800);
  ok("案件详情页有「费用」页签", (await page.locator(".ant-tabs-tab", { hasText: "费用" }).count()) > 0);

  // ① 新建
  await page.locator("button", { hasText: "登记费用" }).first().click();
  const dlg = page.locator(".ant-modal-wrap:visible");
  await dlg.locator(".ant-modal-title", { hasText: "登记费用" }).waitFor({ timeout: 10000 });
  await dlg.locator(".ant-select").first().click();
  await page.waitForTimeout(400);
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").first().click();
  await dlg.locator('input[id$="amount"]').fill("12.34");
  // 日期：直接填输入框（DatePicker 接受 YYYY-MM-DD 文本 + 回车）
  const dateInput = dlg.locator('input[id$="occurredDate"]');
  await dateInput.click();
  await dateInput.fill("2026-10-01");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await dlg.locator("button", { hasText: "登 记" }).or(dlg.locator("button", { hasText: "登记" })).first().click();
  await page.waitForTimeout(1500);
  const rowAfterCreate = page.locator(".ant-table-tbody tr", { hasText: "12.34" });
  ok("① 登记一笔费用后，行出现在列表里", (await rowAfterCreate.count()) > 0, `行数=${await rowAfterCreate.count()}`);

  // ② 编辑：日期框必须回填（这正是缺陷点）
  await page.locator("button", { hasText: "编辑" }).first().click();
  const editDlg = page.locator(".ant-modal-wrap:visible");
  await editDlg.locator(".ant-modal-title", { hasText: "编辑费用" }).waitFor({ timeout: 10000 });
  const editDate = await editDlg.locator('input[id$="occurredDate"]').inputValue();
  ok(
    "**② 编辑弹窗的「发生日期」是回填过的**（空的就是那条阻断缺陷）",
    editDate.trim().length > 0,
    `日期框值=${JSON.stringify(editDate)}`,
  );
  const editAmount = await editDlg.locator('input[id$="amount"]').inputValue();
  ok("编辑弹窗的金额也回填了", editAmount.trim() === "12.34", `金额框=${JSON.stringify(editAmount)}`);

  // ③ 改金额 → 保存 → 行真的变了
  await editDlg.locator('input[id$="amount"]').fill("56.78");
  await editDlg
    .locator("button", { hasText: "保 存" })
    .or(editDlg.locator("button", { hasText: "保存" }))
    .first()
    .click();
  await page.waitForTimeout(1800);
  const updated = page.locator(".ant-table-tbody tr", { hasText: "56.78" });
  ok(
    "**③ 点「保存」后金额真的改了**（不是「点了没反应」）",
    (await updated.count()) > 0,
    `56.78 的行数=${await updated.count()}`,
  );
  const oldGone = page.locator(".ant-table-tbody tr", { hasText: "12.34" });
  ok("旧金额不再出现", (await oldGone.count()) === 0, `12.34 的行数=${await oldGone.count()}`);

  // ④ 页面没有未捕获异常
  ok(
    "④ 整个流程没有未捕获的页面异常",
    pageErrors.length === 0,
    pageErrors.slice(0, 2).join(" · "),
  );
} catch (e) {
  fail += 1;
  console.log(`[FAIL] 脚本中断 —— ${e?.message ?? e}`);
} finally {
  if (browser) await browser.close();
  if (matterId) {
    await sql.unsafe(`delete from mn_matter_expense where matter_id=${matterId}`).catch(() => {});
    await sql.unsafe(`delete from mn_activity_log where matter_id=${matterId}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_staff where matter_id=${matterId}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_node where matter_id=${matterId}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_party where matter_id=${matterId}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter where id=${matterId}`).catch(() => {});
  }
  await dropSmokeAccount(sql, acc.id).catch((e) => console.log("清场:", e.message));
  await sql.end();
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

/**
 * 转案件表单（MATT-39 / IQ-18）的浏览器端到端探针。
 *
 * 服务层已被 smoke-convert 46 条真 HTTP 覆盖（含 N=2、追加、金额不继承、案号非唯一）。
 * 这里验的是**只有浏览器能证**的三件事：
 *   ① 结果条与切换条随「加一个案件」同步（IQ-18①②：N 张都可见）；
 *   ② **切换卡不丢填写**——一次只渲染一张，未渲染那张靠 antd 的 preserve 保值。
 *      这条是本实现最容易静默出错的地方：漏值不会有任何报错，只是提交时少了一个字段；
 *   ③ 未渲染的卡**不跑 rules**，缺必填只能靠 schema 兜——所以提交失败时要把出错那张
 *      切到前台再标红（否则用户看到"提交失败"却看不见错在哪个框）。
 *
 * 只断行为与存在，不断观感（N7 边界）。
 */
import { createRequire } from "node:module";
import { pickChrome } from "./_chrome.mjs";
import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const CHROME = pickChrome();
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

const stamp = Date.now();
const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const riskIds = [];
const caseIds = [];
let browser = null;

async function call(method, path, cookie, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

try {
  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: acct.username, password: acct.password }),
  });
  const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  // 夹具：一条带当事人的事项（无当事人转不了，服务层会 422）
  const created = await call("POST", "/api/risk-matters", cookie, {
    name: `转换表单冒烟 ${stamp}`,
    type: "contract",
    level: "high",
    description: "冒烟：N 案表单",
    amount: "500000.00",
  });
  const riskId = created.body?.id;
  riskIds.push(riskId);
  const p = await call("POST", `/api/risk-matters/${riskId}/parties`, cookie, {
    parties: [
      { partyId: "", name: `表单冒烟对手方 ${stamp}`, type: "legal_person", partyRole: "defendant" },
    ],
  });
  ok("夹具：事项带上了当事人", p.status === 200, `status=${p.status}`);

  browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: acct.username, password: acct.password },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));

  // 从**详情页**入口进（列表入口是另一条，本轮验详情这条；AC 要求两处都能发起）
  await page.goto(`${BASE}/risk-matters/${riskId}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".ant-tabs-tab", { timeout: 20000 });
  await page.getByRole("button", { name: "转案件" }).first().click();
  await page.waitForSelector(".ant-modal .ant-form", { timeout: 20000 });
  await page.waitForTimeout(400);

  const modalText = () => page.locator(".ant-modal-body").first().innerText();
  // ① 结果条：默认 1 个案件
  ok("结果条显示 1 个案件", (await modalText()).includes("1 个案件"), "");

  // ② 加一个案件 → 2 个 + 切换条出现
  await page.getByRole("button", { name: /加一个案件/ }).click();
  await page.waitForTimeout(400);
  ok("加一个案件后结果条显示 2 个案件", (await modalText()).includes("2 个案件"), "");
  ok(
    "切换条出现且含 2 张卡",
    (await modalText()).includes("案件 1") && (await modalText()).includes("案件 2"),
    "",
  );
  // 派生名「事项名 -2」应已预填（矩阵 §2.1）
  ok(
    "第 2 张卡按「事项名 -2」派生",
    (await page.locator(`.ant-modal input[value*=" -2"]`).count()) >= 1,
    "",
  );

  // ③ 填第 2 张的必填（当前正在编辑第 2 张）
  const fill = async (label, value) => {
    const item = page.locator(".ant-modal .ant-form-item", { hasText: label }).first();
    const input = item.locator("input").first();
    await input.click();
    await input.fill(value);
    // ⚠ 不能按 Escape 关下拉：antd Modal 默认 keyboard=true，Escape 会把**整个弹层**关掉，
    //   后面所有定位都变成"元素不可见"（本轮踩到，排查了半天）。
    //   点弹层标题栏即可让输入失焦、收掉下拉。
    await page.locator(".ant-modal-title").first().click();
    await page.waitForTimeout(150);
  };
  await fill("案由", "建设工程施工合同纠纷");
  // 三个 Select：诉讼地位 / 案件类型 / 程序
  const pickSelect = async (label) => {
    const item = page.locator(".ant-modal .ant-form-item", { hasText: label }).first();
    await item.locator(".ant-select").first().click();
    await page.waitForTimeout(200);
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").first().click();
    await page.waitForTimeout(150);
  };
  await pickSelect("我方诉讼地位");
  await pickSelect("案件类型");
  await pickSelect("审级 / 程序");
  await fill("标的金额", "12000.00");

  // ④ 切回第 1 张 → 填它的必填 → 再切回第 2 张，验"值没丢"
  await page.locator(".ant-modal button", { hasText: "案件 1" }).first().click();
  await page.waitForTimeout(300);
  await fill("案由", "买卖合同纠纷");
  await pickSelect("我方诉讼地位");
  await pickSelect("案件类型");
  await pickSelect("审级 / 程序");

  await page.locator(".ant-modal button", { hasText: "案件 2" }).first().click();
  await page.waitForTimeout(300);
  const card2Cause = await page
    .locator(".ant-modal .ant-form-item", { hasText: "案由" })
    .first()
    .locator("input")
    .inputValue();
  ok("**切回第 2 张，案由仍在**（未渲染的卡靠 preserve 保值）", card2Cause === "建设工程施工合同纠纷", `值=${card2Cause}`);
  const card2Amount = await page
    .locator(".ant-modal .ant-form-item", { hasText: "标的金额" })
    .first()
    .locator("input")
    .inputValue();
  ok("**切回第 2 张，金额仍在**", card2Amount === "12000.00", `值=${card2Amount}`);

  // ⑤ 跨卡复制（MATT-19 的 AC）：从第 2 张复制到其余卡，**案号必须不被抄**
  await fill("案号", "COPY-TEST-案号");
  await page.locator(".ant-modal button", { hasText: "复制到其余卡" }).first().click();
  await page.waitForTimeout(300);
  await page.locator(".ant-modal button", { hasText: "案件 1" }).first().click();
  await page.waitForTimeout(300);
  const c1 = async (label) =>
    page.locator(".ant-modal .ant-form-item", { hasText: label }).first().locator("input").inputValue();
  ok("**跨卡复制：案由抄过来了**", (await c1("案由")) === "建设工程施工合同纠纷", `案由=${await c1("案由")}`);
  ok(
    "**跨卡复制：案号没被抄**（id 类字段排除——抄了就是给 N 个案卷安同一个法院案号）",
    (await c1("案号")) === "",
    `案号=${JSON.stringify(await c1("案号"))}`,
  );
  // 还原第 1 张的案由，让下面「两案案由不同」那条库断言仍然判得动
  await fill("案由", "买卖合同纠纷");

  // ⑥ 提交 → 成功屏列出 2 个内部编号
  await page.locator(".ant-modal-footer button").last().click();
  await page.waitForSelector(".ant-modal .ant-result", { timeout: 20000 });
  await page.waitForTimeout(600);
  const resultText = await page.locator(".ant-modal-body").first().innerText();
  const codeHits = resultText.match(/AJ-\d{8}-\d{3}/g) ?? [];
  ok("提交成功屏列出 2 个内部编号", codeHits.length === 2, `codes=${codeHits.join(" / ")}`);

  // 回读库：两案都建出来了，且金额各是各的（12000 / 空→0）
  const rows = await sql`
    select id::text as id, amount::text as amount, cause from mn_matter
    where id in (select matter_id from mn_risk_matter_case where risk_matter_id = ${riskId})`;
  for (const r of rows) caseIds.push(r.id);
  ok("库里确有 2 个案件", rows.length === 2, `n=${rows.length}`);
  ok(
    "两案案由不同（各填各的，没有被同一份覆盖）",
    new Set(rows.map((r) => r.cause)).size === 2,
    rows.map((r) => r.cause).join(" / "),
  );
  ok(
    "第 2 张的金额落库为 12000.00",
    rows.some((r) => r.amount === "12000.00"),
    rows.map((r) => r.amount).join(" / "),
  );

  ok("全程无页面 JS 异常", errors.length === 0, errors.join(" | ").slice(0, 200));
} catch (e) {
  fail++;
  console.log(`[FAIL] 探针本身出错：${e?.stack ?? e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const id of riskIds) {
    await sql.unsafe(`delete from mn_activity_log where risk_matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_risk_matter_staff where risk_matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_risk_matter_party where risk_matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_risk_matter_case where risk_matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_event_outbox where payload->>'risk_matter_id' = '${id}'`).catch(() => {});
    await sql.unsafe(`delete from mn_risk_matter where id=${id}`).catch(() => {});
  }
  for (const id of caseIds) {
    await sql.unsafe(`delete from mn_matter_staff where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_node where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_party where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter where id=${id}`).catch(() => {});
  }
  await sql.unsafe(`delete from mn_party where name like '%${stamp}%'`).catch(() => {});
  await dropSmokeAccount(sql, acct.id).catch((e) => console.log("drop:", e.message));
  await sql.end().catch(() => {});
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

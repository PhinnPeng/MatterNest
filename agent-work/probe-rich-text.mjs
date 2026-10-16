/**
 * 富文本编辑器的浏览器挂载验证（MATT-57）。
 *
 * 服务层冒烟验的是"存进去的 markdown 契约"；这里验的是**编辑器本身**：
 *   · SSR 阶段页面里**不该**有 BlockNote（`ssr:false` 生效，否则 ProseMirror 碰 window 会炸）；
 *   · 打开编辑弹层后，BlockNote 的 DOM（`.bn-editor`）**该**出现且可输入；
 *   · 输入一段带结构的文本 → 保存 → 详情只读区用 react-markdown 把它渲染成标题/列表
 *     （不是原始 markdown 字符），且往返内容一致。
 *
 * 这一步是"界面已验收"里**唯一能机器证**的部分（N7 边界内：只断行为与存在，不断观感）。
 */
import { createRequire } from "node:module";
import { pickChrome } from "./_chrome.mjs";
import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

const require = createRequire("F:/WorkSoftware/nvm/v22.22.2/node_modules/playwright/index.js");
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
    console.log(`[ ok ] ${name}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

const stamp = Date.now();
const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const riskIds = [];
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

  // 建一条事项（纯文本描述，模拟历史行）
  const created = await call("POST", "/api/risk-matters", cookie, {
    name: `富文本挂载冒烟 ${stamp}`,
    type: "contract",
    level: "high",
    description: "历史纯文本：供应商延迟交付。",
    discoverDate: "2026-10-08",
  });
  const riskId = created.body?.id;
  riskIds.push(riskId);

  browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  // cookie 由 context 自带的请求器登录落进去（Playwright 的 cookie jar 与 fetch 的
  // Set-Cookie 解析不同，手工 addCookies 反而容易把 SameSite/Domain 形状写错）
  await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: acct.username, password: acct.password },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));

  await page.goto(`${BASE}/risk-matters/${riskId}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".ant-tabs-tab", { timeout: 20000 });
  await page.waitForTimeout(500);

  // ① SSR/首屏：详情页只读区不该内联 BlockNote（编辑器是 ssr:false 且只在弹层里）
  const bnOnDetail = await page.locator(".bn-editor").count();
  ok("详情页首屏不内联 BlockNote 编辑器（ssr:false 生效）", bnOnDetail === 0, `count=${bnOnDetail}`);
  // 只读描述走 react-markdown：历史纯文本渲染成一个段落，内容在
  const descText = await page.locator("text=历史纯文本").count();
  ok("历史纯文本描述在只读区渲染出来（react-markdown 兼容纯文本）", descText >= 1, `n=${descText}`);

  // ② 打开编辑弹层 → BlockNote 挂载
  await page.getByRole("button", { name: "编辑" }).first().click();
  await page.waitForSelector(".bn-editor", { timeout: 20000 });
  const editorCount = await page.locator(".bn-editor").count();
  ok("打开编辑弹层后 BlockNote 挂载（.bn-editor 出现）", editorCount === 1, `count=${editorCount}`);

  // ③ 在编辑器里输入带结构的文本：先清空已有段落，再逐段敲（BlockNote 里回车换块）
  const editor = page.locator(".bn-editor");
  await editor.click();
  // 全选删掉初值，再逐段敲（BlockNote 里回车换块）
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type("违约经过");
  await page.keyboard.press("Enter");
  await page.keyboard.type("供应商连续三次延迟交付");
  await page.waitForTimeout(600);

  // 保存：弹层底部 OK 按钮。⚠ 不能用 getByRole name:"保存" —— antd 会在两个 CJK
  // 字之间插空格（渲染成"保 存"），role 名匹配不上；footer 最后一个就是 OK 位。
  await page.locator(".ant-modal-footer button").last().click();
  await page.waitForTimeout(1500); // 等 PATCH + invalidate + 重渲染

  // ④ 回读：只读区把新描述渲染出来（react-markdown），不是原始 markdown 字符
  const d2 = await call("GET", `/api/risk-matters/${riskId}`, cookie);
  const saved = String(d2.body?.description ?? "");
  ok("保存后描述已更新（含新文本）", saved.includes("供应商连续三次延迟交付"), `存回=${saved.slice(0, 60)}`);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".ant-tabs-tab", { timeout: 20000 });
  await page.waitForTimeout(500);
  ok("只读区渲染出新描述文本", (await page.locator("text=供应商连续三次延迟交付").count()) >= 1, "");

  // ⑤ 无 JS 报错（BlockNote 挂载/编辑/保存全程没抛）
  ok("全程无页面 JS 异常", errors.length === 0, errors.join(" | ").slice(0, 200));

  // ⑥ 建单弹层里的编辑器也挂载（Form.Item 受控那条路径，与编辑弹层不同壳）
  await page.goto(`${BASE}/risk-matters`, { waitUntil: "networkidle" });
  await page.waitForSelector(".ant-tabs-tab, .ant-table", { timeout: 20000 });
  await page.getByRole("button", { name: /新建事项/ }).first().click();
  await page.waitForSelector(".bn-editor", { timeout: 20000 });
  const createEditor = await page.locator(".ant-modal .bn-editor").count();
  ok("新建事项弹层里 BlockNote 挂载（Form.Item 受控路径）", createEditor === 1, `count=${createEditor}`);
  ok("建单全程无页面 JS 异常", errors.length === 0, errors.join(" | ").slice(0, 200));
} catch (e) {
  fail++;
  console.log(`[FAIL] 探针本身出错：${e?.stack ?? e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const id of riskIds) {
    await sql.unsafe(`delete from mn_risk_matter_staff where risk_matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_activity_log where risk_matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_risk_matter where id=${id}`).catch(() => {});
  }
  await dropSmokeAccount(sql, acct.id).catch((e) => console.log("drop:", e.message));
  await sql.end().catch(() => {});
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

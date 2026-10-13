/**
 * 参与人选择面与创建表单选人字段的真浏览器探针（MATT-49 的界面层）。
 *
 * 服务层已被 `smoke-staff.mjs` 34 条真 HTTP 覆盖。这里验的是**只有浏览器能证**的三件事：
 *  ① 案件详情页「参与人」页签真的能加人（按钮在、弹窗能开、选完人名单会变）；
 *  ② 经办人那条**没有「移出」按钮**（服务端会拒 owner_protected，界面不摆必被拒的按钮）；
 *  ③ 两个创建表单上的「处理人 / 关注人」字段**真的有选项**——这是本票最容易被糊过去的一条：
 *     字段摆在那里、下拉恒空，从服务层冒烟完全看不出来（案件侧此前"加人"入口干脆没做，
 *     成因就是选择面接口不存在）。所以这里断言的是 `options > 0`，不是"字段存在"。
 *
 * 只断行为与存在，不断观感（N7 边界）。
 */
import { createRequire } from "node:module";
import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

const require = createRequire("F:/WorkSoftware/nvm/v22.22.2/node_modules/playwright/index.js");
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

const stamp = Date.now();
const boss = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const mate = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
const matterIds = [];

async function api(method, path, cookie, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: r.status, cookie };
}

let browser = null;
const errors = [];

async function cleanup() {
  for (const id of matterIds) {
    await sql.unsafe(`delete from mn_activity_log where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_staff where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_node where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter_party where matter_id=${id}`).catch(() => {});
    await sql.unsafe(`delete from mn_matter where id=${id}`).catch(() => {});
  }
  const ids = [boss.id, mate.id];
  await sql`delete from mn_activity_log where operator_id = any(${sql.array(ids)}::bigint[])`;
  await sql`delete from mn_auth_session where user_id = any(${sql.array(ids)}::bigint[])`;
  await sql`delete from mn_app_user_role where user_id = any(${sql.array(ids)}::bigint[])`;
  // ⚠ **不许吞掉失败**。`dropSmokeAccount` 在"还有业务行引用这个账号"时会**拒绝**删除
  //   （那是它的保护，不是 bug）。吞掉它 = 每失败一轮就留一个孤儿账号，
  //   而孤儿账号会让下一轮的选择面多出几个人、管理员数悄悄变成 2——
  //   症状出现在**下一轮**，归因却指向"上一轮某个探针"，最难查。
  //   （本轮实测：连续抖动那几轮留下了 3 个，其中一个 is_admin=true。）
  for (const u of [boss, mate]) {
    try {
      await dropSmokeAccount(sql, u.id);
    } catch (e) {
      console.log(`[clean] 删不掉 ${u.username} —— ${String(e.message).split("\n")[0]}`);
    }
  }
}

try {
  const s = await login(boss.username, boss.password);
  ok("夹具账号能登录", s.status === 200, `status=${s.status}`);

  const m = await api("POST", "/api/matters", s.cookie, {
    name: `选人面探针案件 ${stamp}`,
    cause: "买卖合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "plaintiff",
    level: "high",
  });
  ok("夹具案件建出来了", m.status === 201, `status=${m.status}`);
  matterIds.push(m.body?.id);

  browser = await chromium.launch({
    executablePath:
      "C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1224/chrome-win64/chrome.exe",
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: boss.username, password: boss.password },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));

  // ---- ① 案件详情页「参与人」页签能加人 ----
  await page.goto(`${BASE}/matters/${m.body.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.locator(".ant-tabs-tab", { hasText: "参与人" }).first().click();
  await page.waitForTimeout(400);

  const addCo = page.locator("button", { hasText: "加协办" });
  ok("**参与人页签里有「加协办」入口**", (await addCo.count()) > 0, `count=${await addCo.count()}`);

  await addCo.first().click();
  const dlg = page.locator(".ant-modal-wrap:visible");
  await dlg.locator(".ant-select").first().waitFor({ state: "visible", timeout: 10000 });
  await dlg.locator(".ant-select").first().click();
  /**
   * ⚠ 这里等的是**条件**，不是固定时长。
   *
   * 初版写 `waitForTimeout(500)` 然后数选项 —— 选项来自
   * `GET /api/matters/{id}/selectable-users`，首次请求在 dev 下要编译 + 查库，
   * 500ms 常常不够，于是数出 0 个，报成"选择面接口没接上"。
   * **那是个假失败，而且指向错误的修复方向**（会让人去查接口，而接口是好的：
   * `smoke-staff.mjs` 的 34 条真 HTTP 断言覆盖着它）。
   * 探针等条件而不是等时间，才不会把"慢"报成"坏"。
   */
  const opts = page.locator(".ant-select-dropdown:visible .ant-select-item-option");
  const optCount = await opts
    .first()
    .waitFor({ state: "visible", timeout: 15000 })
    .then(() => opts.count())
    .catch(() => 0);
  ok(
    "**加协办弹窗的选项不是空的**（选择面接口真的接上了）",
    optCount > 0,
    `选项=${optCount}`,
  );

  if (optCount > 0) {
    const firstText = (await opts.first().innerText()).trim();
    // ⚠ 必须点**内层内容节点**：antd 的选项外层 `<div>` 会被内层
    // `.ant-select-item-option-content` 挡住 pointer events，直接点外层会一直重试到超时
    // （本轮踩到）。也不用 `force: true`——那会跳过"元素真的可点"这条检查，
    // 而这条检查正是探针存在的理由之一。
    await opts.first().locator(".ant-select-item-option-content").click();
    // ⚠ 选完必须**主动把下拉收起来**再点底部按钮。antd 的 `mode="multiple"` 下拉
    //   **故意不自动关闭**（方便连着选好几个人），所以它会一直盖在 Modal footer 上面；
    //   此时点「加入」会报 "subtree intercepts pointer events" 并重试到超时
    //   （本轮实测：约一半概率红，红的都是这一行）。
    //   收起的办法是点一处**空白**（弹窗标题），不是按 Escape——antd 的 Modal 默认响应
    //   Escape，那会把整个弹窗关掉。
    await dlg.locator(".ant-modal-header").click({ position: { x: 8, y: 8 } });
    await page
      .locator(".ant-select-dropdown:visible")
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => {});
    await dlg.locator(".ant-modal-footer button").last().click();
    // ⚠ 等"名字真的出现在名单里"，**不要**固定睡一段时间赌它渲染完：
    //   批跑时前一个探针刚压过 dev server，编译/首屏会慢一拍，固定 sleep 就会随机红
    //   （本轮实测：单跑 12/0，批跑红一条）。等元素是确定性的，等时钟不是。
    const displayName = firstText.split("（")[0];
    await page
      .locator(".ant-list-item", { hasText: displayName })
      .first()
      .waitFor({ state: "visible", timeout: 15000 })
      .catch(() => {});
    const body = await page.locator("body").innerText();
    ok(
      "**选完人之后名单里真的出现了他**（不是只弹了个提示）",
      body.includes(displayName),
      `找的是「${displayName}」`,
    );
    // 库里那一行同理：等它出现，而不是赌它已经写完
    let row = { n: 0 };
    for (let i = 0; i < 20 && row.n === 0; i++) {
      [row] = await sql`
        select count(*)::int n from mn_matter_staff
        where matter_id=${m.body.id} and staff_role='co_owner'`;
      if (row.n === 0) await new Promise((r) => setTimeout(r, 150));
    }
    ok("库里也落了协办行", row.n === 1, `co_owner 行=${row.n}`);
  }

  // ---- ② 经办人那条没有「移出」按钮 ----
  const ownerRow = page.locator(".ant-list-item", { hasText: boss.displayName }).first();
  ok(
    "**经办人那条没有「移出」**（服务端会拒 owner_protected，界面不摆必被拒的按钮）",
    (await ownerRow.locator("button", { hasText: "移出" }).count()) === 0,
    "",
  );
  const anyRemove = await page.locator("button", { hasText: "移出" }).count();
  ok("但协办那条有「移出」（对照：不是整个页面都没有这个按钮）", anyRemove > 0, `count=${anyRemove}`);

  // ---- ③ 创建表单的处理人/关注人真的有选项 ----
  await page.goto(`${BASE}/risk-matters`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const newBtn = page.locator("button", { hasText: /新\s*建/ }).first();
  await newBtn.click();
  const createDlg = page.locator(".ant-modal-wrap:visible");
  await createDlg.locator(".ant-form").waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(500);
  const dlgText = await createDlg.innerText();
  ok("**创建事项表单上有「处理人」字段**", dlgText.includes("处理人"), "");
  ok("**创建事项表单上有「关注人」字段**", dlgText.includes("关注人"), "");

  const ownerSelect = createDlg
    .locator(".ant-form-item", { hasText: "处理人" })
    .locator(".ant-select")
    .first();
  await ownerSelect.click();
  await page.waitForTimeout(500);
  const createOpts = page.locator(".ant-select-dropdown:visible .ant-select-item-option");
  const createOptCount = await createOpts.count();
  ok(
    "**创建表单的处理人下拉不是空的**（IQ-14 创建期例外真的接上了）",
    createOptCount > 0,
    `选项=${createOptCount}`,
  );

  ok("全程无页面 JS 异常", errors.length === 0, errors.join(" | ").slice(0, 200));
} catch (e) {
  fail++;
  console.log(`[FAIL] 探针本身出错：${e?.stack ?? e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await cleanup().catch((e) => console.log("清场失败:", String(e.message).split("\n")[0]));
  await sql.end().catch(() => {});
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

/**
 * 用户与角色页的真浏览器探针（MATT-10 的界面层 / P13）。
 *
 * 服务层已被 `smoke-users.mjs` 30 条真 HTTP 覆盖。这里验的是**只有浏览器能证**的四件事：
 *  ① 三个面都在：待批队列 / 用户列表 / 两个弹窗；
 *  ② **不给必被拒的按钮**——自己的行上「改角色」「停用」不可点，系统所有者那行「停用」不可点；
 *  ③ 凭据入口**只对系统所有者出现**（换个有 canManageUser 但不是所有者的账号登录，按钮应消失）；
 *  ④ 无权限者看到的是"需要「管理账号」权限"这句话，不是一张 403 空表。
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
const owner = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin] });
const mgr = await createSmokeAccount(sql, { roles: [ROLE_CODES.sysAdmin] });
const plain = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
// 待开通账号：队列的来源
const pendingName = `mn_smoke_pending_${stamp}`;
const [pendingUser] = await sql`
  insert into mn_app_user (id, username, display_name, is_enabled, is_admin, activation_status, created_at, updated_at)
  values (${BigInt(Date.now() * 1000)}, ${pendingName}, ${`待开通 ${stamp}`}, true, false, 'pending', now(), now())
  returning id`;

await sql`update mn_app_user set is_system_owner = false where is_system_owner and id <> ${owner.id}`;
await sql`update mn_app_user set is_system_owner = true where id = ${owner.id}`;

let browser = null;
const errors = [];

/** 用某个账号开一个 context 并打开 /users */
async function openAs(username, password) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.request.post(`${BASE}/api/auth/login`, { data: { username, password } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${username}: ${String(e.message).slice(0, 160)}`));
  await page.goto(`${BASE}/users`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  return { ctx, page };
}

async function cleanup() {
  await sql`delete from mn_activity_log where target_type='app_user' and target_id in (${owner.id}, ${mgr.id}, ${plain.id}, ${pendingUser.id})`;
  await sql`delete from mn_activity_log where operator_id in (${owner.id}, ${mgr.id}, ${plain.id})`;
  await sql`delete from mn_auth_session where user_id in (${owner.id}, ${mgr.id}, ${plain.id}, ${pendingUser.id})`;
  await sql`delete from mn_app_user_role where user_id in (${owner.id}, ${mgr.id}, ${plain.id}, ${pendingUser.id})`;
  await sql`delete from mn_app_user where id = ${pendingUser.id}`;
  // 先清冒烟账号的所有者标记再授回 admin：partial unique index 要求全局至多一行为 true
  await sql`update mn_app_user set is_system_owner = false where username like 'mn_smoke_%'`;
  await sql`update mn_app_user set is_system_owner = true where username = 'admin' and not is_system_owner`;
  for (const u of [owner, mgr, plain]) await dropSmokeAccount(sql, u.id).catch((e) => console.log("drop:", e.message));
}

try {
  browser = await chromium.launch({
    executablePath:
      "C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1224/chrome-win64/chrome.exe",
  });

  // ---- ① 系统所有者视角：三个面都在 ----
  const asOwner = await openAs(owner.username, owner.password);
  const body = await asOwner.page.locator("body").innerText();
  ok("列表卡片头是页面主标题「用户与角色」", body.includes("用户与角色"), "");
  ok("账号列表里有本账号行", body.includes(owner.username), "");
  ok("**待批队列出现**且带待开通账号", body.includes("待开通") && body.includes(pendingName), "");
  ok("状态列把「启用/停用」与「已开通/待开通」分开表达", body.includes("启用") && body.includes("已开通"), "");

  // 系统所有者那行：停用按钮不可点
  //
  // ⚠ 按钮文案要按**正则**匹配：antd 会在**恰好两个 CJK 字**之间插一个空格，
  //   所以「停用」渲染成「停 用」——`hasText: "停用"` 匹配不到（本轮踩到；
  //   probe-rich-text 里「保 存」是同一个坑，那里记过一次，这里又踩了一次）。
  const ownerRow = asOwner.page.locator(".ant-table-tbody tr", { hasText: owner.username }).first();
  const ownerStop = ownerRow.locator("button", { hasText: /停\s*用/ });
  ok(
    "**系统所有者那行「停用」不可点**（服务端也会拒，界面不摆必被拒的按钮）",
    (await ownerStop.count()) > 0 && (await ownerStop.isDisabled()),
    `count=${await ownerStop.count()}`,
  );

  // 凭据入口对所有者可见
  ok("**系统所有者能看到「设口令/重置口令」入口**", (await ownerRow.locator("button", { hasText: /口令/ }).count()) > 0, "");

  // 移交入口：只在"我是所有者、且这行不是所有者"时出现（「不可停用」的唯一出路）
  const mgrRowEarly = asOwner.page.locator(".ant-table-tbody tr", { hasText: mgr.username }).first();
  ok(
    "**非所有者那行有「移交所有权」入口**（不可停用那条守卫的出路）",
    (await mgrRowEarly.locator("button", { hasText: "移交所有权" }).count()) > 0,
    "",
  );
  ok(
    "**所有者自己那行没有移交入口**（移交给自己的自己 = 无意义动作）",
    (await ownerRow.locator("button", { hasText: "移交所有权" }).count()) === 0,
    "",
  );

  // ---- ② 批准待开通（F6-11）----
  await asOwner.page.locator("button", { hasText: "批准并指定角色" }).first().click();
  // ⚠ 作用域必须是**可见**弹窗：两个弹窗的 children 都在 DOM 里（antd 首次打开后保留），
  //   用 `.ant-modal .ant-checkbox-group` 会撞到两个，Playwright 取第一个（不可见的那个）后超时。
  const dlg = asOwner.page.locator(".ant-modal-wrap:visible");
  await dlg.locator(".ant-checkbox-group").first().waitFor({ state: "visible", timeout: 10000 });
  await dlg.locator(".ant-checkbox-group label").first().click();
  await dlg.locator(".ant-modal-footer button").last().click();
  await asOwner.page.waitForTimeout(1200);
  const afterApprove = await asOwner.page.locator("body").innerText();
  ok("批准后该账号离开待批队列", !afterApprove.includes("批准并指定角色") || !afterApprove.includes(pendingName), "");
  const [row] = await sql`select activation_status from mn_app_user where id = ${pendingUser.id}`;
  ok("库里 activation_status 已变 active", row.activation_status === "active", `值=${row.activation_status}`);

  // ---- ③ 改角色弹窗（对 mgr，不是自己）----
  //
  // ⚠ 这里**不能点"第一个勾选框"**：`setUserRoles` 是**整体替换**语义，而弹窗打开时
  //   已把该账号现有角色勾上（这是对的——它表达"他现在是什么"）。点第一个 = 把它已有的
  //   角色取消掉，于是 mgr 变成"无角色"，下一次请求 `readActor` 直接返回 null（401）。
  //   本轮踩到：探针后面那句"非所有者也能看用户列表"就因此红了。
  //   正确做法是**按名字勾一个新的**，再断言两个角色都在。
  const mgrRow = asOwner.page.locator(".ant-table-tbody tr", { hasText: mgr.username }).first();
  await mgrRow.locator("button", { hasText: "改角色" }).click();
  await dlg.locator(".ant-checkbox-group").first().waitFor({ state: "visible", timeout: 10000 });
  const dlgText = await dlg.innerText();
  ok("改角色弹窗列出角色字典", dlgText.includes("系统管理") || dlgText.includes("参与经办"), "");
  // 现有角色应已勾上（弹窗表达"他现在是什么"）
  const preChecked = await dlg
    .locator(".ant-checkbox-wrapper", { hasText: "系统管理" })
    .locator("input")
    .isChecked();
  ok("**弹窗预勾该账号现有角色**（不是空表让人重选）", preChecked, "");
  await dlg.locator(".ant-checkbox-wrapper", { hasText: "参与经办" }).click();
  await dlg.locator(".ant-modal-footer button").last().click();
  await asOwner.page.waitForTimeout(1000);
  ok("保存角色后弹窗关闭", (await asOwner.page.locator(".ant-modal-wrap:visible").count()) === 0, "");
  const [mgrRoles] = await sql`
    select count(*)::int n from mn_app_user_role where user_id = ${mgr.id}`;
  ok("**整体替换语义下两个角色都在**（原有 + 新勾）", mgrRoles.n === 2, `角色行=${mgrRoles.n}`);

  // ---- ④ 有 canManageUser 但**不是**系统所有者：凭据入口应消失 ----
  const asMgr = await openAs(mgr.username, mgr.password);
  const mgrBody = await asMgr.page.locator("body").innerText();
  ok("非所有者也能看用户列表（有 canManageUser）", mgrBody.includes("用户与角色"), "");
  ok(
    "**非所有者的界面上没有凭据入口**（F6-9 只对系统所有者开放）",
    (await asMgr.page.locator("button", { hasText: /口令/ }).count()) === 0,
    "",
  );
  ok(
    "**非所有者的界面上没有移交入口**（移交不是权限操作，是身份转移）",
    (await asMgr.page.locator("button", { hasText: "移交所有权" }).count()) === 0,
    "",
  );
  // 自己那行：改角色与停用都不可点
  const selfRow = asMgr.page.locator(".ant-table-tbody tr", { hasText: mgr.username }).first();
  ok(
    "**自己那行「改角色」不可点**（禁自助提权；服务端也拒）",
    await selfRow.locator("button", { hasText: "改角色" }).isDisabled(),
    "",
  );
  ok("**自己那行「停用」不可点**", await selfRow.locator("button", { hasText: /停\s*用/ }).isDisabled(), "");

  // ---- ⑤ 无 canManageUser：看到的是权限说明，不是 403 空表 ----
  const asPlain = await openAs(plain.username, plain.password);
  const plainBody = await asPlain.page.locator("body").innerText();
  ok(
    "**无权限者看到「需要「管理账号」权限」**，不是一张空表",
    plainBody.includes("管理账号") && plainBody.includes("权限"),
    "",
  );
  ok("无权限者看不到任何账号名（列表没渲染）", !plainBody.includes(owner.username), "");

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

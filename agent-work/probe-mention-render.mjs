/**
 * @提及**渲染侧**的真浏览器探针（MATT-68 / T4b2）。
 *
 * ## 为什么它必须是浏览器脚本
 *
 * 票面判据有一半在 HTTP 响应里看不见：**「这段是提及」与「正文里恰好写了 `@张三`」
 * 必须长得不一样**。那是两段 `<span>` 的差别（`data-mention` / `data-mention-state`），
 * 只有真 DOM 能给。而另一半（分段本身）由 API 断言钉住，两边互为对照。
 *
 * ## 三个场景，覆盖两页
 *
 * | 场景 | 造法 | 期望 |
 * |---|---|---|
 * | A 真提及 | 评论正文写 `@<同事>`，`mention_ids` 因此有他 | 高亮 chip，`data-mention-state="active"` |
 * | B 假提及 | **先发一条没有 @ 的评论，再 PATCH 成带 @ 的正文**（`editRiskComment` 不重算 `mention_ids`） | **没有 chip**，`@<同事>` 是普通文字 |
 * | C 停用 | 把被点名的账号 `is_enabled=false`，再刷新 | chip **还在**，`data-mention-state="inactive"` + 一句说明 |
 *
 * ⚠ B 为什么只能靠"编辑"造：matters 侧没有编辑评论的端点，而 risk 侧的
 *   `editRiskComment` 不刷新 `mention_ids` —— 这正是"正文与通知事实会分叉"的真实来源。
 *   matters 侧的 B 用**另一个真实途径**造：在同事被停用之后才发评论
 *   （写入口径只认在职账号 ⇒ `mention_ids` 为空），正文里的 @ 同样只是文字。
 *
 * 夹具一律走 API 造（不手写 SQL 塞评论），否则看到的是页面在真实约束下不会呈现的样子。
 *
 * 用法：`node --env-file=.env agent-work/probe-mention-render.mjs`（需 dev 在 3777）。
 */
import { createRequire } from "node:module";
import { pickChrome } from "./_chrome.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { createSmokeAccount, dropSmokeAccount, ROLE_CODES } = await import("./_testacct.mjs");
const { default: postgres } = await import("postgres");

/**
 * 浏览器可执行文件的路径**不写死版本号** —— 取法收敛在 `_chrome.mjs`（原先这里有一份本地副本）。
 */

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const CHROME = pickChrome();
const stamp = Date.now().toString(36).slice(-6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function call(method, path, cookie, payload) {
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

/**
 * ⚠ 两个临时账号**不能在同一毫秒建**：`createSmokeAccount` 用
 * `Date.now()*1000 + random(0..999)` 当 id，撞上就整个脚本死在插入上。串开一秒是实测过的代价。
 */
const author = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
await sleep(1100);
const target = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined], suffix: "_t" });

const [trow] = await sql`select display_name from mn_app_user where id = ${target.id}`;
const targetName = trow?.display_name;
const targetId = String(target.id);

const matterIds = [];
const riskIds = [];
/** 每个阶段自己的页面异常桶：混在一起会让"哪一步炸的"看不出来 */
const pageErrors = [];
let browser = null;

try {
  if (!targetName) throw new Error("拿不到被点名同事的显示名 —— 夹具没建起来");

  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: author.username, password: author.password }),
  });
  ok("夹具账号能登录", lr.status === 200, `status=${lr.status}`);
  const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  // ── 夹具：一个案件 + 一条事项（各挂评论）──
  const mk = await call("POST", "/api/matters", cookie, {
    name: `提及渲染探针 ${stamp}`,
    cause: "买卖合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole: "plaintiff",
    level: "high",
  });
  ok("夹具案件建出来了", mk.status === 201, `status=${mk.status}`);
  const matterId = mk.body.id;
  matterIds.push(matterId);

  const mr = await call("POST", "/api/risk-matters", cookie, {
    name: `提及渲染探针事项 ${stamp}`,
    type: "contract",
    level: "mid",
    description: "探针：核对 @提及在评论列表里的渲染。",
  });
  ok("夹具事项建出来了", mr.status === 201, `status=${mr.status}`);
  const riskId = mr.body.id;
  riskIds.push(riskId);

  // ── 场景 A（案件侧）：真提及 ──
  const cA = await call("POST", `/api/matters/${matterId}/comments`, cookie, {
    body: `MATTERA · 请 @${targetName} 复核`,
  });
  ok("案件侧：发了一条带 @ 的评论", cA.status === 201, `status=${cA.status}`);

  // ── 场景 A（事项侧）：真提及 ──
  const rA = await call("POST", `/api/risk-matters/${riskId}/comments`, cookie, {
    body: `RISKA · 请 @${targetName} 复核`,
  });
  ok("事项侧：发了一条带 @ 的评论", rA.status === 201, `status=${rA.status}`);
  const rAId = rA.body?.id;

  // ── 场景 B（事项侧）：先发无 @ 的评论，再 PATCH 出 @（editRiskComment 不重算 mention_ids）──
  const rB0 = await call("POST", `/api/risk-matters/${riskId}/comments`, cookie, {
    body: "RISKB · 先没有提及",
  });
  ok("事项侧：发了第二条评论（此刻无 @）", rB0.status === 201, `status=${rB0.status}`);
  const rBId = rB0.body?.id;
  const rB = await call(
    "PATCH",
    `/api/risk-matters/${riskId}/comments?commentId=${rBId}`,
    cookie,
    { body: `RISKB · 编辑后才写 @${targetName}` },
  );
  ok("事项侧：把第二条评论改成带 @ 的正文", rB.status === 200, `status=${rB.status}`);

  // ── API 层：分段真的来自 mention_ids，且 id 不出现在响应里 ──
  const md = await call("GET", `/api/matters/${matterId}`, cookie);
  ok("案件详情接口 200", md.status === 200, `status=${md.status}`);
  const cmtA = (md.body?.comments ?? []).find((c) => String(c.body).startsWith("MATTERA"));
  const partsA = cmtA?.parts ?? [];
  const mentionA = partsA.find((p) => p.kind === "mention");
  ok(
    "① 案件侧：真提及的 parts 里有一段 mention，status=active",
    mentionA && mentionA.status === "active" && mentionA.name === targetName,
    JSON.stringify(partsA),
  );
  ok(
    "案件侧：分段把正文完整覆盖（拼回去等于原文）",
    partsA.map((p) => (p.kind === "text" ? p.text : `@${p.name}`)).join("") === cmtA?.body,
    JSON.stringify(partsA),
  );
  ok(
    "案件侧：响应里**没有** mentionIds（bigint 过不了 JSON，也不该送出去）",
    !JSON.stringify(md.body).includes("mentionIds"),
  );

  const rd = await call("GET", `/api/risk-matters/${riskId}`, cookie);
  ok("事项详情接口 200", rd.status === 200, `status=${rd.status}`);
  const rAparts = (rd.body?.comments ?? []).find((c) => c.id === rAId)?.parts ?? [];
  const rBparts = (rd.body?.comments ?? []).find((c) => c.id === rBId)?.parts ?? [];
  ok(
    "① 事项侧：真提及的 parts 有一段 mention",
    rAparts.some((p) => p.kind === "mention" && p.name === targetName),
    JSON.stringify(rAparts),
  );
  ok(
    "**② 事项侧：编辑出来的 @ 在 parts 里是纯文本**（mention_ids 里没有他）",
    rBparts.length === 1 && rBparts[0].kind === "text" && rBparts[0].text.includes(`@${targetName}`),
    JSON.stringify(rBparts),
  );

  // ── 浏览器：真 DOM 上的 chip ──
  browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: author.username, password: author.password },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 160)));

  const itemOf = (marker) => page.locator(".ant-list-item", { hasText: marker });
  const chipOf = (item) => item.locator(`span[data-mention="${targetId}"]`);

  // 案件页：点开「过程记录」
  await page.goto(`${BASE}/matters/${matterId}`, { waitUntil: "networkidle" });
  await page.locator(".ant-tabs-tab", { hasText: "过程记录" }).first().click();
  await page.waitForTimeout(700);
  const mItemA = itemOf("MATTERA");
  ok("案件页：「过程记录」里有那条评论", (await mItemA.count()) === 1, `行数=${await mItemA.count()}`);
  ok("① 案件页：真提及画成了 chip（`data-mention` 命中被点名的人）", (await chipOf(mItemA).count()) === 1);
  ok(
    "① 案件页：chip 的状态是 active",
    (await chipOf(mItemA).first().getAttribute("data-mention-state")) === "active",
  );
  ok(
    "① 案件页：chip 的文字就是 `@名字`",
    (await chipOf(mItemA).first().innerText()).trim() === `@${targetName}`,
    await chipOf(mItemA).first().innerText(),
  );

  // 事项页：右栏「处置记录」
  await page.goto(`${BASE}/risk-matters/${riskId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const rItemA = itemOf("RISKA");
  const rItemB = itemOf("RISKB");
  ok("② 事项页：两条评论都在", (await rItemA.count()) === 1 && (await rItemB.count()) === 1);
  ok("① 事项页：真提及画成了 chip", (await chipOf(rItemA).count()) === 1);
  ok(
    "**② 事项页：编辑出来的 @ 没有 chip（与正文里随手打的 @ 长得一样）**",
    (await rItemB.locator("[data-mention]").count()) === 0 &&
      (await rItemB.innerText()).includes(`@${targetName}`),
    `chip=${await rItemB.locator("[data-mention]").count()}`,
  );

  // ── 场景 C：停用被点名的人 → chip 还在，只是降级 ──
  await sql`update mn_app_user set is_enabled = false, updated_at = now() where id = ${target.id}`;

  // 场景 B（案件侧）：同事停用之后才发的评论 —— 写入口径不认他 ⇒ mention_ids 为空
  const cB = await call("POST", `/api/matters/${matterId}/comments`, cookie, {
    body: `MATTERB · 停用之后才写 @${targetName}`,
  });
  ok("案件侧：在同事停用之后又发了一条带 @ 的评论", cB.status === 201, `status=${cB.status}`);

  await page.goto(`${BASE}/matters/${matterId}`, { waitUntil: "networkidle" });
  await page.locator(".ant-tabs-tab", { hasText: "过程记录" }).first().click();
  await page.waitForTimeout(700);
  const mItemA2 = itemOf("MATTERA");
  const mItemB = itemOf("MATTERB");
  ok(
    "**③ 案件页：同事停用后，原来的提及 chip 仍在（不静默消失）**",
    (await chipOf(mItemA2).count()) === 1,
    `chip=${await chipOf(mItemA2).count()}`,
  );
  ok(
    "③ 案件页：chip 的降级状态是 inactive",
    (await chipOf(mItemA2).first().getAttribute("data-mention-state")) === "inactive",
    await chipOf(mItemA2).first().getAttribute("data-mention-state"),
  );
  ok(
    "**② 案件页：停用之后发的评论里 `@名字` 是纯文本（mention_ids 为空）**",
    (await mItemB.count()) === 1 &&
      (await mItemB.locator("[data-mention]").count()) === 0 &&
      (await mItemB.innerText()).includes(`@${targetName}`),
    `chip=${await mItemB.locator("[data-mention]").count()}`,
  );

  await page.goto(`${BASE}/risk-matters/${riskId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const rItemA2 = itemOf("RISKA");
  ok(
    "③ 事项页：同事停用后提及 chip 仍在且为 inactive",
    (await chipOf(rItemA2).count()) === 1 &&
      (await chipOf(rItemA2).first().getAttribute("data-mention-state")) === "inactive",
  );
  // 降级 chip 还要有一句说明 —— 悬停才出 tooltip，所以真悬一次
  await chipOf(rItemA2).first().hover();
  await page.waitForTimeout(1200);
  // antd v6 的 tooltip 内容类名是 `ant-tooltip-container`（v5 的 `ant-tooltip-inner` 已经没了）——
  // 拿旧类名断言会把**对的实现**断成红的（`probe-d2-layout.mjs` 在 tabs 类名上栽过同一次）
  const tip = page.locator(".ant-tooltip-container:visible");
  ok(
    "③ 事项页：降级 chip 悬停后有「该同事已停用」说明",
    (await tip.count()) > 0 && (await tip.first().innerText()).includes("已停用"),
    `tooltip 数=${await tip.count()}`,
  );

  ok("④ 全程没有未捕获的页面异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" · "));
  await ctx.close();
} catch (e) {
  fail += 1;
  console.log(`[FAIL] 探针本身出错：${e?.stack ?? e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  // 清场：逐夹具删干净（评论/活动/参与人/节点/当事人），再删账号。
  // ⚠ 不静默吞错（照抄 probe-d2-layout.mjs 的教训：`.catch(()=>{})` 让"绿着漏数据"活了很久）。
  const problems = [];
  const del = async (label, text) => {
    try {
      await sql.unsafe(text);
    } catch (e) {
      problems.push(`${label}: ${String(e.message).split("\n")[0]}`);
    }
  };
  for (const id of matterIds) {
    await del("m-comment", `delete from mn_comment where target_type='matter' and target_id=${id}`);
    await del("m-activity(fk)", `delete from mn_activity_log where matter_id=${id}`);
    await del("m-activity(target)", `delete from mn_activity_log where target_type='matter' and target_id=${id}`);
    await del("m-staff", `delete from mn_matter_staff where matter_id=${id}`);
    await del("m-node", `delete from mn_matter_node where matter_id=${id}`);
    await del("m-party", `delete from mn_matter_party where matter_id=${id}`);
    await del("matter", `delete from mn_matter where id=${id}`);
  }
  for (const id of riskIds) {
    await del("r-comment", `delete from mn_comment where target_type='risk_matter' and target_id=${id}`);
    await del("r-activity(fk)", `delete from mn_activity_log where risk_matter_id=${id}`);
    await del("r-activity(target)", `delete from mn_activity_log where target_type='risk_matter' and target_id=${id}`);
    await del("r-staff", `delete from mn_risk_matter_staff where risk_matter_id=${id}`);
    await del("r-node", `delete from mn_risk_matter_node where risk_matter_id=${id}`);
    await del("r-party", `delete from mn_risk_matter_party where risk_matter_id=${id}`);
    await del("r-case", `delete from mn_risk_matter_case where risk_matter_id=${id}`);
    await del("risk", `delete from mn_risk_matter where id=${id}`);
  }
  if (problems.length) console.log("清场有问题:", problems.join(" | "));
  await dropSmokeAccount(sql, target.id).catch((e) =>
    console.log("清账号失败:", String(e.message).split("\n")[0]),
  );
  await dropSmokeAccount(sql, author.id).catch((e) =>
    console.log("清账号失败:", String(e.message).split("\n")[0]),
  );
  await sql.end().catch(() => {});
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

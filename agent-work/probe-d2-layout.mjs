/**
 * MATT-55（P5-D2 ①）的布局门禁：IQ-19 的 D2 形态在真浏览器下量出来的数字。
 *
 * ## 为什么它必须是浏览器脚本而不是 API 冒烟
 *
 * 票面判据是几何（列宽、顶边、等高、栏底距折线、横向溢出、页签数、按钮落点）。
 * 这些不在 HTTP 响应里，服务层冒烟看不见。但 Playwright 起的 headless Chromium
 * **带显式视口**，`getBoundingClientRect` 给的是真实布局（区别于本机 MCP 浏览器
 * 面板那个 0×0 hidden 会话，那里全是 0）。所以几何断言在这里成立。
 *
 * 夹具一律**走 API 造**（同 standby-browser.mjs：手写 SQL 绕过校验，看到的就是
 * 页面在真实约束下不会呈现的样子）。跑 1366×768 与 1920×1080 两档 + 空态 + 归档态。
 *
 * 用法：`node agent-work/probe-d2-layout.mjs`（需 dev/start 在 3777）。
 * 截图写 `agent-work/d2-shots/`（gitignore 内，不参与门禁判定，只是给人眼补看）。
 */
import { createRequire } from "node:module";
import { pickChrome, playwrightRoot } from "./_chrome.mjs";
import { mkdirSync } from "node:fs";
import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

const require = createRequire(playwrightRoot());
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
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

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

/** 页面上量一次，全部返回数字/计数，没有一条靠肉眼看截图。在浏览器上下文里执行。 */
function measure() {
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, bottom: b.bottom, right: b.right };
  };
  const row = document.querySelector(".ant-row");
  const cols = row ? [...row.children].filter((c) => c.classList.contains("ant-col")) : [];
  const left = cols[0];
  const rail = cols[1];
  const railCard = rail ? rail.querySelector(".ant-card") : null;

  // 元素级横向溢出：任何元素超出视口右边都算。只量 documentElement 会被容器 overflow 骗过去。
  let overflow = 0;
  let worst = null;
  const vw = document.documentElement.clientWidth;
  for (const el of document.querySelectorAll("body *")) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    const over = b.right - vw;
    if (over > 1 && over > overflow) {
      overflow = over;
      worst = (el.className && String(el.className).slice(0, 48)) || el.tagName;
    }
  }

  const tabs = [...document.querySelectorAll(".ant-tabs-tab")].map((t) => t.innerText.trim());
  const addNodeBtn = [...document.querySelectorAll("button")].find((b) =>
    b.innerText.includes("手动添加节点"),
  );
  // antd 6 的 Tabs 内容类名是 `ant-tabs-content-active`（antd 5 的 `tabpane` 系列已不存在，
  // 第一版探针拿旧类名断言，把**对的实现**断成了红的）
  const activePane = document.querySelector(".ant-tabs-content-active");
  const commentInput = rail ? rail.querySelector("textarea") : null;

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight, cw: vw },
    row: rect(row),
    left: rect(left),
    rail: rect(rail),
    railCard: rect(railCard),
    overflow: Math.round(overflow * 10) / 10,
    worst,
    tabs,
    addNodeInPanel: Boolean(addNodeBtn && activePane && activePane.contains(addNodeBtn)),
    hasCommentInput: Boolean(commentInput),
    // 栏底到折线（视口底）的距离：负数 = 越过折线
    railBottomGap: Math.round(window.innerHeight - (rect(rail)?.bottom ?? 0)),
    bodyText: document.body.innerText,
  };
}

const acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const riskIds = [];
const shotDir = "agent-work/d2-shots";
let browser = null;

try {
  mkdirSync(shotDir, { recursive: true });
  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: acct.username, password: acct.password }),
  });
  const cookie = (lr.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("登录没拿到 cookie");

  // ── 有载荷夹具：节点 + 评论 + 当事人 + 参与人 ──
  const mk = await call("POST", "/api/risk-matters", cookie, {
    name: "布局验收 · 供应商纠纷反复出现",
    type: "contract",
    level: "high",
    description: "供应商连续三次延迟交付，业务侧已在函件往来中提出解约意向，等待对方书面回复。",
    measure: "先固定证据，等对方书面回复后再决定是否转案件。",
    discoverDate: "2026-10-08",
    amount: "128000.00",
  });
  if (mk.status !== 201) throw new Error(`建事项失败 ${mk.status} ${JSON.stringify(mk.body)}`);
  const riskId = mk.body.id;
  riskIds.push(riskId);

  const detail = (await call("GET", `/api/risk-matters/${riskId}`, cookie)).body;
  const nodeTypes = detail.nodeTypes;
  await call("POST", `/api/risk-matters/${riskId}/nodes`, cookie, {
    nodeTypeId: nodeTypes[0].id,
    startTime: "2026-10-20",
  });
  await call("POST", `/api/risk-matters/${riskId}/nodes`, cookie, {
    nodeTypeId: nodeTypes[1 % nodeTypes.length].id,
  });
  await call("POST", `/api/risk-matters/${riskId}/comments`, cookie, {
    body: "已发函，等对方书面回复。这里写长一点，让评论列表真的有可滚的内容，而不是空态。",
  });
  await call("POST", `/api/risk-matters/${riskId}/comments`, cookie, {
    body: "对方口头答应补货，未见书面。",
  });
  const party = (await call("GET", "/api/parties?page=1&pageSize=1", cookie)).body?.items?.[0];
  if (party) {
    const add = await call("POST", `/api/risk-matters/${riskId}/parties`, cookie, {
      partyId: party.id,
      partyRole: "opponent",
    });
    if (add.status >= 400) console.log(`  · 当事人挂接 ${add.status}（夹具可空，不影响几何）`);
  }

  // ── 空态夹具：只有描述，没有任何子记录 ──
  const empty = await call("POST", "/api/risk-matters", cookie, {
    name: "布局验收 · 空态",
    type: "contract",
    level: "low",
    description: "一条只有描述的事项，用来验三处空态是否都有交代。",
    discoverDate: "2026-10-09",
  });
  riskIds.push(empty.body.id);

  browser = await chromium.launch({ executablePath: CHROME });

  /** 打开详情页并等两列 + 页签真的出现（客户端渲染，networkidle 不够） */
  async function open(id, width, height, label) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    // 用 context 自带的请求器登录，cookie 落进 context，后续 goto 直接带上
    await ctx.request.post(`${BASE}/api/auth/login`, {
      data: { username: acct.username, password: acct.password },
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/risk-matters/${id}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".ant-row > .ant-col", { timeout: 20000 });
    await page.waitForSelector(".ant-tabs-tab", { timeout: 20000 });
    await page.waitForTimeout(600);
    const m = await page.evaluate(measure);
    await page.screenshot({ path: `${shotDir}/d2-${label}.png`, fullPage: false });
    return { ctx, page, m };
  }

  // ════ 1366×768（内网常见，票面写死那档）════
  const A = await open(riskId, 1366, 768, "1366");
  console.log(`\n── 1366×768 ── 视口 ${JSON.stringify(A.m.viewport)}`);
  console.log(`  页签：${A.m.tabs.join(" | ")}`);
  console.log(
    `  行=${Math.round(A.m.row.w)} 左=${Math.round(A.m.left.w)} 右卡=${Math.round(A.m.railCard.w)} 顶(左${Math.round(A.m.left.y)}/右${Math.round(A.m.rail.y)}) 高(左${Math.round(A.m.left.h)}/右${Math.round(A.m.rail.h)}) 栏底距折线=${A.m.railBottomGap}`,
  );
  ok("两列都在（右栏存在）", A.m.left && A.m.rail && A.m.railCard);
  ok("右栏卡片宽 340（不随视口拉宽）", near(A.m.railCard.w, 340), `实际=${Math.round(A.m.railCard.w)}`);
  ok("左列 + 16 + 右栏卡 ≈ 行宽", near(A.m.left.w + 16 + A.m.railCard.w, A.m.row.w, 20), `${Math.round(A.m.left.w)}+16+${Math.round(A.m.railCard.w)} vs 行${Math.round(A.m.row.w)}`);
  ok("两列顶边同 y", near(A.m.left.y, A.m.rail.y, 2), `左=${Math.round(A.m.left.y)} 右=${Math.round(A.m.rail.y)}`);
  ok("左列高 ≥ 右栏高（min-height 撑等高）", A.m.left.h + 2 >= A.m.rail.h, `左=${Math.round(A.m.left.h)} 右=${Math.round(A.m.rail.h)}`);
  ok("右栏底边在折线以上 ≥16px（不越界）", A.m.railBottomGap >= 16, `距折线=${A.m.railBottomGap}px`);
  ok("元素级横向溢出 0", A.m.overflow <= 0, `溢出=${A.m.overflow} 最坏=${A.m.worst}`);
  ok("页签恰两枚：事项节点 + 活动日志", A.m.tabs.length === 2 && A.m.tabs.some((t) => t.includes("事项节点")) && A.m.tabs.some((t) => t.includes("活动日志")), A.m.tabs.join(" | "));
  ok("「手动添加节点」在节点面板内（不在页头）", A.m.addNodeInPanel);
  ok("评论输入框存在（非归档态）", A.m.hasCommentInput);
  await A.ctx.close();

  // ════ 1920×1080 ════
  const B = await open(riskId, 1920, 1080, "1920");
  console.log(`\n── 1920×1080 ── 视口 ${JSON.stringify(B.m.viewport)}`);
  console.log(
    `  行=${Math.round(B.m.row.w)} 左=${Math.round(B.m.left.w)} 右卡=${Math.round(B.m.railCard.w)} 栏底距折线=${B.m.railBottomGap}`,
  );
  ok("右栏卡片宽 340 不随窗口拉宽", near(B.m.railCard.w, 340), `实际=${Math.round(B.m.railCard.w)}`);
  ok("两列顶边同 y", near(B.m.left.y, B.m.rail.y, 2), `左=${Math.round(B.m.left.y)} 右=${Math.round(B.m.rail.y)}`);
  ok("右栏底边在折线以上 ≥16px", B.m.railBottomGap >= 16, `距折线=${B.m.railBottomGap}px`);
  ok("元素级横向溢出 0", B.m.overflow <= 0, `溢出=${B.m.overflow} 最坏=${B.m.worst}`);
  ok("左列高 ≥ 右栏高", B.m.left.h + 2 >= B.m.rail.h, `左=${Math.round(B.m.left.h)} 右=${Math.round(B.m.rail.h)}`);
  await B.ctx.close();

  // ════ 空态：三处空态都要有交代 ════
  const C = await open(empty.body.id, 1366, 768, "empty");
  // 折叠区**默认收起**（票面要求），antd 收起时不渲染面板内容 ⇒ 当事人空态点开才量得到。
  // 先点页签到「事项节点」（默认就在这枚），再点开折叠区。
  await C.page.locator(".ant-collapse-header").first().click();
  await C.page.waitForTimeout(400);
  const et = await C.page.evaluate(() => document.body.innerText);
  console.log("\n── 空态 1366×768 ──");
  ok("节点空态有文案", et.includes("还没有节点"));
  ok("评论空态有文案（核查走评论）", et.includes("事项的核查走评论"));
  ok("当事人空态说明转案件前置（折叠区展开后）", et.includes("没有当事人时无法转案件"));
  ok("空态下横向溢出仍 0", C.m.overflow <= 0, `溢出=${C.m.overflow}`);
  await C.ctx.close();

  // ════ 归档态：无输入框 / 无加节点 / 无变更经办人 ════
  const arch = await call("POST", `/api/risk-matters/${riskId}/status`, cookie, {
    to: "archived",
    reason: "布局验收：归档态只读",
  });
  ok("归档成功（进入终态）", arch.status === 200, `status=${arch.status}`);
  const D = await open(riskId, 1366, 768, "archived");
  const at = D.m.bodyText;
  console.log("\n── 归档态 1366×768 ──");
  ok("归档态没有评论输入框", !D.m.hasCommentInput);
  ok("归档态没有「手动添加节点」", !D.m.addNodeInPanel && !at.includes("手动添加节点"));
  ok("归档态没有「变更经办人」按钮", !at.includes("变更经办人"));
  // MATT-54 交叉验收：归档态无关注**菜单**（眼睛与下拉都撤），但「n 人关注」这条读事实留着。
  // 判据：含"人关注"的**按钮**数 = 0（非归档态是 1，右段就是按钮），同时纯文本里还有这个词。
  const followButtons = await D.page.locator("button:has-text('人关注')").count();
  ok(
    "归档态关注组退化为只读文本（按钮 0 个、计数仍在）",
    followButtons === 0 && at.includes("人关注"),
    `按钮=${followButtons} 含文本=${at.includes("人关注")}`,
  );
  ok("归档态页签仍两枚", D.m.tabs.length === 2, D.m.tabs.join(" | "));
  ok("归档态横向溢出 0", D.m.overflow <= 0, `溢出=${D.m.overflow}`);
  await D.ctx.close();
} catch (e) {
  fail++;
  console.log(`[FAIL] 探针本身出错：${e?.stack ?? e}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  // 逐夹具删干净（含账号写进去的 staff/comment/node/activity），再删账号。
  //
  // ⚠ 三个坑，都是**踩过才知道**的：
  //  1. 列名是 `risk_matter_id` 不是 `host_id`。原先写 `host_id` ⇒ 每条语句都报
  //     "column does not exist"，而 `.catch(() => {})` 把错误**吞掉**了 ⇒ 一行都没删，
  //     接着删事项被 `mn_risk_matter_node` 的外键挡住、又被吞掉 ⇒ 每跑一次漏一条事项。
  //     静默 catch 让这个 bug 活了很久：探针一直"绿"，残留只在 db:check 的 C14 上现形。
  //  2. `mn_activity_log` 对事项有**独立外键列** `risk_matter_id`（不只 target_id 多态列），
  //     两个都得删。
  //  3. 因此这里**不再静默吞错**：清场失败必须喊出来，否则下次还是"绿着漏数据"。
  const problems = [];
  const del = async (label, sqlText) => {
    try {
      await sql.unsafe(sqlText);
    } catch (e) {
      problems.push(`${label}: ${String(e.message).split("\n")[0]}`);
    }
  };
  for (const id of riskIds) {
    await del("staff", `delete from mn_risk_matter_staff where risk_matter_id=${id}`);
    await del("party", `delete from mn_risk_matter_party where risk_matter_id=${id}`);
    await del("node", `delete from mn_risk_matter_node where risk_matter_id=${id}`);
    await del("comment", `delete from mn_comment where target_type='risk_matter' and target_id=${id}`);
    await del("activity(target)", `delete from mn_activity_log where target_type='risk_matter' and target_id=${id}`);
    await del("activity(fk)", `delete from mn_activity_log where risk_matter_id=${id}`);
    await del("case-link", `delete from mn_risk_matter_case where risk_matter_id=${id}`);
    await del("risk", `delete from mn_risk_matter where id=${id}`);
  }
  if (problems.length) console.log("清场有问题:", problems.join(" | "));
  await dropSmokeAccount(sql, acct.id).catch((e) =>
    console.log("清账号失败:", String(e.message).split("\n")[0]),
  );
  await sql.end().catch(() => {});
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}：${pass} 通过 / ${fail} 失败（截图见 agent-work/d2-shots/）`);
process.exit(fail === 0 ? 0 : 1);

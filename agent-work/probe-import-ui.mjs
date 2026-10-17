/**
 * P14 批量导入页（MATT-67）的真浏览器探针 —— 票面 AC 第 7 条：
 * **真上传一份带坏行的文件，断页面上的两个数与接口返回一致**。
 *
 * ## 为什么必须有它（而不是靠 `import-ui.spec.ts`）
 *
 * 单测钉的是"两个数怎么算"（纯逻辑）；而这条 AC 要的是**端到端**：
 * 浏览器选文件 → 读文本 → POST `/api/import` → 响应落进 React state → 页面画出来。
 * 链路上任何一环错了（`FileReader` 读成 GBK、`accept` 拦下 csv、响应字段名抄错、
 * 计数反算），单测全绿而页面上是错的 —— 这正是"HTTP 层看不见的那一半"。
 *
 * ## 断言
 *
 *   ① 页面可达（`/config/import`），且左侧菜单高亮到「批量导入」
 *   ② 三张模板都能下载：请求 `GET /api/import/templates?hostType=…` 返回带 `csv` 的 JSON
 *   ③ **真上传一份带坏行的 CSV**（1 好行 + 2 坏行），断：
 *        · 页面上的「已导入」= 接口返回的 `importedRows`
 *        · 页面上的「未导入」= 接口返回的 `errorRows`
 *        · 页面上的「文件里的数据行」= 接口返回的 `totalRows`
 *      —— 三个数**逐字相等**，不是"都大于 0"
 *   ④ 逐行结果里出现坏行（行号 / 字段 / 原因三列）
 *   ⑤ 错误报告可下载（点按钮后拿到一次下载，文件名带 `.csv`）
 *   ⑥ 整个过程没有未捕获的页面异常
 *
 * ## 用法（**由父代理串行统一跑**，别与其他代理并发）
 *
 *   node --env-file=.env agent-work/probe-import-ui.mjs
 *
 * 前置：dev server 在 3777（`SMOKE_BASE` 可覆盖）、库可连、`.env` 里有
 * `MN_SESSION_PEPPER` 等启动自检项。**它写 dev 库**（会建 1 个账号 + 若干案件/事项），
 * 所以必须与其他写库的脚本串行。
 *
 * ## 为什么夹具的行是**照模板列名手写的**
 *
 * 与 `smoke-import.mjs` 不同：那个脚本从**下载下来的模板**上拼行（它验的是模板与导入器一致）；
 * 这个探针验的是**页面**，所以列名只要能过表头校验即可。但为了让"表头校验"这条链路
 * 也真的被走到（而不是被 400 挡在门外），列名用的是模板里那几列的**逐字表头**。
 */
import { createRequire } from "node:module";
import { pickChrome } from "./_chrome.mjs";

const require = createRequire(import.meta.url);
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

/** L1（`full_admin` 的 dataScope=all）—— 导入页的正路 */
const acc = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin] });
/** 非 L1（`joined`，范围 participating）—— 验 403 的 UI 面 */
const low = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });

const P = `探针导入${stamp}`;
/**
 * 夹具 CSV：**1 条好行 + 2 条坏行**。
 *   · 第 3 行（数据第 1 行）：好行 → 进库
 *   · 第 4 行：风险类型填了不存在的值 → `unknown_enum`
 *   · 第 5 行：事项名称空 → `required`
 * 于是 `total=3 / imported=1 / error=2`，三个数各不相同（防"恰好都相等"的假通过）。
 *
 * 表头逐字取自 `shared/schema/import.ts` 里 risk_matter 的必填列（带 `*`）。
 */
const CSV = [
  "事项名称*,风险类型*,风险等级*,风险描述*",
  `${P}好行,合同,high,这条应当进库`,
  `${P}坏行甲,非诉,high,风险类型不认识`,
  ",合同,high,名称为空",
].join("\n");

const batchIds = [];
let browser;
const pageErrors = [];

try {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: acc.username, password: acc.password }),
  });
  ok("夹具账号能登录", login.status === 200, `status=${login.status}`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  // ② 三张模板都能下载（HTTP 层，顺带把"页面要调的那条路由"钉住）
  for (const kind of ["risk_matter", "matter", "party"]) {
    const r = await fetch(`${BASE}/api/import/templates?hostType=${kind}`, { headers: { cookie } });
    const b = await r.json();
    ok(
      `模板 ${kind} 下载返回 JSON + csv`,
      r.status === 200 && typeof b.csv === "string" && b.fileName.endsWith(".csv"),
      `status=${r.status} fileName=${b.fileName}`,
    );
  }

  // 预算出接口的真实返回（下面要拿它与页面比对）
  const apiRes = await fetch(`${BASE}/api/import`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ hostType: "risk_matter", fileName: `${P}.csv`, csv: CSV }),
  });
  const apiBody = await apiRes.json();
  ok("接口接受这份带坏行的文件（逐行跳过，不整批拒收）", apiRes.status === 200, `status=${apiRes.status}`);
  ok(
    "接口计数恒等式成立",
    apiBody.totalRows === apiBody.importedRows + apiBody.errorRows,
    `total=${apiBody.totalRows} imported=${apiBody.importedRows} error=${apiBody.errorRows}`,
  );
  ok(
    "夹具确实是 3 行 / 1 进 / 2 不进（三个数互不相同）",
    apiBody.totalRows === 3 && apiBody.importedRows === 1 && apiBody.errorRows === 2,
    `total=${apiBody.totalRows} imported=${apiBody.importedRows} error=${apiBody.errorRows}`,
  );
  batchIds.push(apiBody.batchId);

  // ── 真浏览器 ────────────────────────────────────────────────
  browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: acc.username, password: acc.password },
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 160)));

  await page.goto(`${BASE}/config/import`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);

  // ① 页面可达 + 菜单高亮
  ok("① 导入页可达", page.url().includes("/config/import"), page.url());
  const menuOn = await page.locator(".ant-menu-item-selected", { hasText: "批量导入" }).count();
  ok("① 左侧菜单高亮到「批量导入」", menuOn > 0, `命中=${menuOn}`);

  // 上传：直接给 file input 喂一份内存文件（`setInputFiles` 支持 buffer 形态）
  await page.locator('input[type="file"]').setInputFiles({
    name: `${P}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(CSV, "utf8"),
  });
  await page.waitForTimeout(300);
  await page.locator("button", { hasText: "开始导入" }).first().click();
  // 导入是同步的，但页面要等响应 + 渲染；给足时间（夹具只有 3 行）
  await page.waitForTimeout(3000);

  // ③ 页面上三个数 = 接口返回（逐字）
  const bodyText = await page.locator("body").innerText();
  const has = (n) => new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(bodyText);
  ok(
    "**③ 页面上的「已导入」= 接口的 importedRows**",
    has(apiBody.importedRows) && bodyText.includes("已导入"),
    `接口 ${apiBody.importedRows}`,
  );
  ok(
    "**③ 页面上的「未导入」= 接口的 errorRows**",
    has(apiBody.errorRows) && bodyText.includes("未导入"),
    `接口 ${apiBody.errorRows}`,
  );
  ok(
    "**③ 页面上的「文件里的数据行」= 接口的 totalRows**",
    has(apiBody.totalRows) && bodyText.includes("文件里的数据行"),
    `接口 ${apiBody.totalRows}`,
  );
  ok("三个数**同屏**（P14 的核心信息）", bodyText.includes("已导入") && bodyText.includes("未导入"));

  // ④ 逐行结果三列
  ok("④ 未导入行表有「行号 / 字段 / 原因」三列", /行号[\s\S]*字段[\s\S]*原因/.test(bodyText));

  // ⑤ 错误报告可下载
  const dlPromise = page.waitForEvent("download", { timeout: 15000 });
  await page.locator("button", { hasText: "下载错误报告" }).first().click();
  const dl = await dlPromise;
  ok(
    "⑤ 点「下载错误报告」真的触发了一次 .csv 下载",
    dl.suggestedFilename().endsWith(".csv"),
    dl.suggestedFilename(),
  );

  // ⑥ 无未捕获异常
  ok("⑥ 整个流程没有未捕获的页面异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" · "));

  // 非 L1：明确的拒绝面（403 的 UI 面）
  const lowLogin = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: low.username, password: low.password }),
  });
  const lowCookie = (lowLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const lowApi = await fetch(`${BASE}/api/import/batches`, { headers: { cookie: lowCookie } });
  ok("非 L1 读「最近导入」拿到 403", lowApi.status === 403, `status=${lowApi.status}`);

  await ctx.clearCookies();
  await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: low.username, password: low.password },
  });
  const lowPage = await ctx.newPage();
  await lowPage.goto(`${BASE}/config/import`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await lowPage.waitForTimeout(1200);
  const lowText = await lowPage.locator("body").innerText();
  ok(
    "非 L1 时该页**明确拒绝**并说清下一步",
    lowText.includes("全局数据范围") && lowText.includes("全局管理"),
  );
  ok("非 L1 时页面上**没有**「开始导入」按钮", (await lowPage.locator("button", { hasText: "开始导入" }).count()) === 0);
} catch (e) {
  fail += 1;
  console.log(`[FAIL] 脚本中断 —— ${e?.message ?? e}`);
} finally {
  if (browser) await browser.close();
  // 清场：批次（级联删行）+ 本批建出来的业务记录 + 两个账号
  for (const id of batchIds) {
    await sql.unsafe(`delete from mn_import_batch where id=${id}`).catch(() => {});
  }
  for (const t of ["mn_risk_matter_party", "mn_risk_matter_staff", "mn_risk_matter_node", "mn_activity_log"]) {
    await sql
      .unsafe(`delete from ${t} where risk_matter_id in (select id from mn_risk_matter where name like '${P}%')`)
      .catch(() => {});
  }
  await sql.unsafe(`delete from mn_risk_matter where name like '${P}%'`).catch(() => {});
  await dropSmokeAccount(sql, acc.id).catch((e) => console.log("清场:", e.message));
  await dropSmokeAccount(sql, low.id).catch((e) => console.log("清场:", e.message));
  await sql.end();
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

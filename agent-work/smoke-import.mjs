import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";

/**
 * 批量导入（MATT-44 / T6 / F7-4）的**真 HTTP 冒烟**。
 *
 * ## 跑法
 *
 *   node --env-file=.env agent-work/smoke-import.mjs     # dev server 在 3777（SMOKE_BASE 可覆盖）
 *
 * ## 先反向红一次（本仓纪律：没有反向红的冒烟等于没有冒烟）
 *
 *   node agent-work/revred-import.mjs <mode>          # 注入
 *   node --env-file=.env agent-work/smoke-import.mjs  # ⇒ 必须红
 *   node agent-work/revred-import.mjs restore         # 还原（**别用 git checkout**）
 *   node --env-file=.env agent-work/smoke-import.mjs  # ⇒ 必须绿
 *
 * ## 断言清单（票面 AC 逐条）
 *
 *   ① 三张模板可下载，字段/取值与枚举一致（含**作废值不在模板里**）
 *   ② 仅 L1 可执行：L2/L3/未登录三条拒绝路径 + L1 正路（角色给的 `dataScope=all`）
 *      + `is_admin` 逃生口（数据范围不是 L1，但 `is_admin=true`）
 *   ③ 逐行跳过：坏行不阻断好行，`total = imported + error` **恒等式**当场验
 *   ④ 错误报告可下载：行号/字段/原因，且**不含证件号原文**
 *   ⑤ 一次导入**一条** `BULK_IMPORT`（载荷五键与 §3.5 逐字一致）+ 逐行 `*_CREATED`
 *   ⑥ 当事人随行按 (类型, 证件号哈希) 查重：命中挂接既有、否则建档、同名不同号不自动合并
 *   ⑦ 幂等重放：同文件重导 0 新增；改一行重传只补那一行；同文件内重复行报出来
 *   ⑧ 金额精度、日期归一、初始态取配置、案号默认取内部编号
 *   ⑨ 幂等键的 DB 级兜底（并发也拦得住）
 *   ⑩ 批次列表：计数自洽、状态收尾、`reportRef` 可点
 *   ⑪ 预检（`?dryRun=1`）与真导**同一实现**：同文件两跑计数与行级明细逐条相同、
 *      预检不写库（不落批次、不给报告号）、导完再预检报 `replayed`（MATT-102 留的活）
 *
 * ## 为什么夹具的行是从**下载下来的模板**上拼的
 *
 * 表头与列顺序都从真实下载的文件里读（`headerLabels`），而不是在脚本里另写一份列清单。
 * 于是"模板与导入器对不上"这类错会在这一条链路上直接暴露 —— 在脚本里抄一份列名，
 * 抄错的那一份会让两边**看起来都对**。
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

/**
 * 本企业名（IQ-7 防呆）：从 env 读，不写死 —— 部署事实，脚本里写死会在别的环境变成假断言。
 *
 * ⚠ 这里**不许** `?? ""`（2026-10-15，MATT-88）。原先那么写，于是变量缺失时
 * `OWN_COMPANY` 是空串 —— 而它下面第 481 行的夹具 `{ 对方当事人: OWN_COMPANY }`
 * 正是 IQ-7「我方永不入当事人表」那条防呆用例的输入。
 * 结果那条断言变成在测「对方当事人为空」，红或绿取决于数据，而不取决于配置对不对。
 *
 * 2026-10-15 CI 上就是这么红的：`17 脚本 · 失败 8 · 断言 443 通过 / 21 失败`，
 * 而根因只是少注入一个环境变量 —— **一个部署事实的缺失，伪装成了一堆断言失败**。
 *
 * 缺了就当场停，且**一条断言都不许先跑出来**（见 `smoke-import.spec.ts`）。
 * 守卫写在读变量的地方、探库之前 —— 与 `smoke-parties.mjs` 同一形状，
 * 且这样它在没有库的环境里也照样生效（本仓的单测从不依赖一个活着的数据库）。
 */
const ownNames = (process.env.MN_OWN_COMPANY_NAMES ?? "")
  .split(/[,，]/)
  .map((s) => s.trim())
  .filter(Boolean);
if (ownNames.length === 0) {
  console.error(
    "缺 MN_OWN_COMPANY_NAMES：本企业名防呆（IQ-7）要知道本企业叫什么，猜不出来。\n" +
      "在 .env 里写：MN_OWN_COMPANY_NAMES=某某集团有限公司（多个别名用逗号分隔）",
  );
  process.exit(3); // 3 = 环境不对（2 已专留给「清场失败」，见 _testacct.mjs）
}
/** 本企业名（IQ-7 防呆）：从 env 读，不写死 —— 部署事实，脚本里写死会在别的环境变成假断言 */
const OWN_COMPANY = ownNames[0];

let pass = 0;
let fail = 0;
const failedNames = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failedNames.push(name);
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, cookie };
}
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

const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

/**
 * 前置探活：**隧道断了不是断言失败**（与其余冒烟同口径）。
 * 让 60 条断言集体变红，然后把"隧道抖了一下"当成"代码坏了"去查，是最贵的假红。
 */
try {
  await sql`select 1`;
} catch (e) {
  console.error(
    `数据库连不上（${e?.message ?? e}）—— 隧道可能正在抖。\n` +
      `这不是断言失败：等一会儿重跑 \`node --env-file=.env agent-work/_tables.mjs\` 探活成功再来。`,
  );
  // 3 = 环境不对；此时还没建任何夹具，所以不可能是「清场失败」（那个码是 2）
  process.exit(3);
}

const stamp = Date.now();
/** 夹具名前缀：清场按它反查（比记 id 稳 —— 报告里的行号、批次 id 都不需要留着） */
const P = `冒烟导入${stamp}`;
/**
 * 证件号也**由时间戳派生**，不写死常量。
 *
 * 写死的代价本轮实测过一次：`91110000MA0000A01` 撞上了上一次崩溃运行留下的档案，
 * 于是整批被 `identity_exists` 挡下 —— 断言红得莫名其妙，查了半天才发现是残留数据。
 * 另一条更隐蔽：**seed 里已有演示当事人**（同证件号会被判为同一主体），
 * 写死的号段迟早会撞上。派生之后每次运行都是干净的主体。
 */
const uscc = (n) => `91${stamp}${String(n).padStart(3, "0")}`;
const idCard = (n) => `32${stamp}${String(n).padStart(3, "0")}`;

/**
 * L1 的**正路**夹具：`full_admin` 角色给的 `dataScope='all'` —— **刻意不带 `isAdmin`**。
 *
 * 带上的代价实测过：`canImport` 的第一条 early return 就是 `actor.isAdmin`，
 * 于是全部"L1 能导"的断言都从逃生口出去了，`dataScope === "all"` 那一支
 * **只剩拒绝方向有覆盖**（把那一支改成恒 false，96 条照样全绿）。
 * 逃生口由下面的 `escapee` 专门验，两个夹具各管一条分支。
 */
const admin = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin] });
const escapee = await createSmokeAccount(sql, { roles: [ROLE_CODES.self], isAdmin: true });
const joined = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
const selfOnly = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const adminC = (await login(admin.username, admin.password)).cookie;
const escapeeC = (await login(escapee.username, escapee.password)).cookie;
const joinedC = (await login(joined.username, joined.password)).cookie;
const selfC = (await login(selfOnly.username, selfOnly.password)).cookie;
/** 处理人按**姓名**解析那条路径要有真夹具：用冒烟账号自己的显示名（不依赖 seed 里的人） */
const [adminRow] = await sql`select display_name from mn_app_user where id = ${admin.id}`;
const adminName = adminRow?.display_name ?? admin.username;

const batchIds = [];
const ACCOUNTS = [selfOnly, joined, escapee, admin];

/**
 * 数据行的行号：**表头是第 1 行、说明行是第 2 行**，所以第 i 条数据（0 起）落在 `i + 3`。
 * 写成函数而不是散落的字面量：报告里的行号必须是用户在 Excel 里看到的那个，
 * 而这套夹具是"从下载下来的模板上追加数据行"，说明行在不在直接决定差一行。
 */
const rowNo = (i) => i + 3;

/**
 * 清场。**注册到崩溃路径上**：上一版只把清场写在脚本末尾，于是断言一抛错
 * 就留下 4 个账号 + 3 份档案 + 1 个批次 —— 而残留数据会让**下一次**运行莫名变红
 * （写死的证件号撞上残留档案 ⇒ 全是 identity_exists）。清理必须发生在 finally。
 *
 * `dropSmokeAccount` 逐个 try：一个账号删不掉不该挡住其余账号与业务行的清理。
 */
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const riskIds = (await sql`select id from mn_risk_matter where name like ${`${P}%`}`).map((r) => r.id);
  const matterIds = (await sql`select id from mn_matter where name like ${`${P}%`}`).map((r) => r.id);
  const partyIds = (await sql`select id from mn_party where name like ${`${P}%`}`).map((r) => r.id);
  if (riskIds.length) {
    await sql`delete from mn_risk_matter_party where risk_matter_id in ${sql(riskIds)}`;
    await sql`delete from mn_risk_matter_staff where risk_matter_id in ${sql(riskIds)}`;
    await sql`delete from mn_risk_matter_node where risk_matter_id in ${sql(riskIds)}`;
    await sql`delete from mn_activity_log where risk_matter_id in ${sql(riskIds)}`;
    await sql`delete from mn_risk_matter where id in ${sql(riskIds)}`;
  }
  if (matterIds.length) {
    await sql`delete from mn_matter_party where matter_id in ${sql(matterIds)}`;
    await sql`delete from mn_matter_staff where matter_id in ${sql(matterIds)}`;
    await sql`delete from mn_matter_node where matter_id in ${sql(matterIds)}`;
    await sql`delete from mn_activity_log where matter_id in ${sql(matterIds)}`;
    await sql`delete from mn_matter where id in ${sql(matterIds)}`;
  }
  if (partyIds.length) await sql`delete from mn_party where id in ${sql(partyIds)}`;
  // 导入批次：`mn_import_row` 随批次 CASCADE（迁移 0013 的外键动作）
  if (batchIds.length) await sql`delete from mn_import_batch where id in ${sql(batchIds)}`;
  for (const u of ACCOUNTS) {
    try {
      await dropSmokeAccount(sql, u.id);
    } catch (e) {
      // 记账而不是只打一句：否则这次「跑过了」在退出码上与「跑干净了」同形
      noteCleanupFailure(`临时账号 ${u.username}（${u.id}）`, e);
    }
  }
}
// 顶层 await 抛错走 `unhandledRejection`；同步抛错走 `uncaughtException`。两条都要挂。
for (const ev of ["unhandledRejection", "uncaughtException"]) {
  process.on(ev, async (e) => {
    console.error(`\n冒烟中断：${e?.message ?? e}\n正在清场（避免残留污染下一次运行）…`);
    try {
      await cleanup();
      console.error("清场完成");
    } catch (err) {
      console.error(`清场也失败了：${err?.message ?? err}`);
    }
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
}

/* ───────────────────────── ① 三张模板 ───────────────────────── */

const tpl = {};
for (const kind of ["risk_matter", "matter", "party"]) {
  const r = await call("GET", `/api/import/templates?hostType=${kind}`, adminC);
  const csv = typeof r.body?.csv === "string" ? r.body.csv : "";
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  tpl[kind] = { csv, header: lines[0] ?? "", hint: lines[1] ?? "", fileName: r.body?.fileName ?? "" };
  ok(`模板 ${kind} 可下载（200 + csv 文本）`, r.status === 200 && csv.length > 0, `status=${r.status}`);
  ok(`模板 ${kind} 带 UTF-8 BOM（Windows Excel 中文不乱码）`, csv.startsWith("\uFEFF"));
  ok(`模板 ${kind} 第二行是说明行（导入时自动跳过）`, tpl[kind].hint.startsWith("※说明行"));
  ok(`模板 ${kind} 文件名是「…导入模板.csv」`, /导入模板\.csv$/.test(tpl[kind].fileName));
}

ok(
  "事项模板表头含四个必填列且带星号",
  ["事项名称*", "风险类型*", "风险等级*", "风险描述*"].every((h) =>
    tpl.risk_matter.header.includes(h),
  ),
  tpl.risk_matter.header,
);
ok(
  "事项模板说明行给出风险类型取值（合同/劳动争议/…）",
  tpl.risk_matter.hint.includes("合同") && tpl.risk_matter.hint.includes("劳动争议"),
);
ok(
  "事项模板说明行列出**配置表里**的风险等级（高（high）/中（mid）/低（low））",
  ["高（high）", "中（mid）", "低（low）"].every((s) => tpl.risk_matter.hint.includes(s)),
);
ok(
  "事项模板说明行**不含作废值**「客户投诉」（E16 作废值不得回到用户手里）",
  !tpl.risk_matter.hint.includes("客户投诉"),
);
ok(
  "说明行的取值分隔符不与取值相撞：「对外纠纷/投诉」是一个完整取值（退回 `/` 会切出半个）",
  // 下载下来的那一行才是用户看的。清单用「、」；退回 `/` 时这段会变成
  // `业务报备/对外纠纷/投诉/…`，其中「投诉」看起来是一个可填的值（抄它 → unknown_enum）。
  tpl.risk_matter.hint.includes("业务报备、对外纠纷/投诉") &&
    !tpl.risk_matter.hint.includes("/投诉/"),
);
ok(
  "案件模板表头含必填列，说明行含案件类型取值且**不含作废值「非诉」**",
  ["案件名称*", "案由*", "案件类型*", "审级程序*", "我方诉讼地位*", "处理人*"].every((h) =>
    tpl.matter.header.includes(h),
  ) &&
    tpl.matter.hint.includes("民商事") &&
    !tpl.matter.hint.includes("非诉"),
  tpl.matter.header,
);
ok(
  "当事人模板表头含名称/类型/证件类型/证件号",
  ["当事人名称*", "当事人类型*", "证件类型", "证件号"].every((h) => tpl.party.header.includes(h)),
  tpl.party.header,
);
ok(
  "模板下载也走 L1 门（参与经办 403）",
  (await call("GET", "/api/import/templates?hostType=party", joinedC)).status === 403,
);
ok(
  "模板类型非法 → 400（不是 500）",
  (await call("GET", "/api/import/templates?hostType=nope", adminC)).status === 400,
);

/** 表头 → 列下标。行按**中文列名**给值，列顺序从真实模板读 */
function headerLabels(kind) {
  return tpl[kind].header.split(",").map((s) => s.replace(/[*＊]+$/, ""));
}
/**
 * 与 `csvCell`（`services/exports.ts`）同规则的最小实现：含逗号/引号/空白就包起来。
 *
 * ⚠ 这是**夹具生成器**，不是第二条导出链路 —— 被测的东西是服务端的解析与归一。
 *   之所以不省掉它：Excel 对含逗号的单元格**总会**加引号（金额 `1,234,567.89`
 *   就是最常见的那个），所以"引号路径"是真实输入的一部分。在夹具里写死
 *   "不许出现逗号"等于把这条路径从端到端冒烟里挖掉。
 */
function cell(v) {
  const s = String(v).replace(/\r?\n/g, " ");
  return /[",\s]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rowOf(kind, values) {
  return headerLabels(kind).map((label) => cell(values[label] ?? ""));
}
/** 模板原文 + 追加数据行（用真实的模板文件，不另拼表头） */
function fileWith(kind, rows) {
  return `${tpl[kind].csv}\r\n${rows.map((r) => rowOf(kind, r).join(",")).join("\r\n")}`;
}
function post(kind, fileName, csv, cookie = adminC) {
  return call("POST", "/api/import", cookie, { hostType: kind, fileName, csv });
}

/* ───────────────────────── ② 仅 L1 可执行 ───────────────────────── */

const tinyFile = fileWith("party", [{ 当事人名称: `${P}-越权尝试`, 当事人类型: "法人" }]);
const deniedL2 = await post("party", "越权.csv", tinyFile, joinedC);
ok(
  "参与经办（L2）导入 → 403 import_forbidden",
  deniedL2.status === 403 && deniedL2.body?.error === "import_forbidden",
  `status=${deniedL2.status} error=${deniedL2.body?.error}`,
);
const deniedL3 = await post("party", "越权.csv", tinyFile, selfC);
ok(
  "承办经办（L3）导入 → 403 import_forbidden",
  deniedL3.status === 403 && deniedL3.body?.error === "import_forbidden",
);
ok(
  "未登录导入 → 401（不是 403、不是 200）",
  (await call("POST", "/api/import", "", { hostType: "party", fileName: "x.csv", csv: "a" }))
    .status === 401,
);
const [leak] = await sql`select count(*)::int as n from mn_party where name = ${`${P}-越权尝试`}`;
ok("被拒的导入**一行都没写**（拒绝发生在写之前）", leak.n === 0, `库里有 ${leak.n} 行`);
ok(
  "批次列表也走 L1 门（L3 → 403）",
  (await call("GET", "/api/import/batches", selfC)).status === 403,
);
ok(
  "报告下载也走 L1 门（L2 → 403）",
  (await call("GET", "/api/import/report/1", joinedC)).status === 403,
);
ok(
  "is_admin 逃生口：数据范围不是 L1 但 is_admin=true 可导（与护栏 1 同一口径）",
  (await call("GET", "/api/import/templates?hostType=party", escapeeC)).status === 200,
);
// 原来这段是把 `await call(...)` 直接塞进 `ok()` 的第一个参数里：结果**用**了
// （`.status === 400`），但门禁只认"整行就是一个裸 await"与"接住"，于是它算违规。
// 拆成先接住再断言，形状与本文件其余断言一致。
const unknownKey = await call("POST", "/api/import", adminC, {
  hostType: "party",
  fileName: "x.csv",
  content: "a,b",
});
ok(
  "请求体带未知键（把 csv 写成 content）→ 400，不静默丢弃",
  unknownKey.status === 400,
  `status=${unknownKey.status}`,
);

/* ───────────────────────── ③ 当事人模板：建档 + 查重 ───────────────────────── */

const preName = `${P}-既有档案`;
const preIdNumber = uscc(1);
const pre = await call("POST", "/api/parties", adminC, {
  name: preName,
  type: "legal_person",
  idType: "unified_social_credit",
  idNumber: preIdNumber,
});
ok("夹具：先建一份既有当事人档案（供查重命中）", pre.status === 201, `status=${pre.status}`);

const A_ID = uscc(2);
const B_ID = idCard(3);
const partyRows = [
  { 当事人名称: `${P}-当事人A`, 当事人类型: "法人", 证件类型: "统一社会信用代码", 证件号: A_ID },
  // 与上一行**逐字相同** → 本文件内重复，必须报出来而不是静默吞
  { 当事人名称: `${P}-当事人A`, 当事人类型: "法人", 证件类型: "统一社会信用代码", 证件号: A_ID },
  {
    当事人名称: `${P}-当事人B`,
    当事人类型: "自然人",
    证件类型: "居民身份证",
    证件号: B_ID,
    联系方式: "13800000000",
    备注: "历史台账里的对手方",
  },
  // 证件号命中既有档案 → 未新建（不自动合并、也不重复建档）
  { 当事人名称: preName, 当事人类型: "法人", 证件类型: "统一社会信用代码", 证件号: preIdNumber },
  // 同证件号、**不同名称** → 仍然算命中（证件号唯一确定主体）
  { 当事人名称: `${P}-换个名字`, 当事人类型: "法人", 证件号: A_ID },
  // 本企业名 → 我方永不入表（IQ-7）
  { 当事人名称: OWN_COMPANY, 当事人类型: "法人" },
  { 当事人名称: `${P}-当事人C`, 当事人类型: "非法人组织" },
  // 名称 1 个字 → DTO 层拦下（`请输入当事人名称（至少 2 个字）`）
  { 当事人名称: "甲", 当事人类型: "法人" },
];
const partyRes = await post("party", "当事人.csv", fileWith("party", partyRows));
if (partyRes.body?.batchId) batchIds.push(partyRes.body.batchId);
ok(
  "当事人导入：7 行里 3 行进库、5 行未进库",
  partyRes.status === 200 &&
    partyRes.body.importedRows === 3 &&
    partyRes.body.errorRows === 5 &&
    partyRes.body.totalRows === 8,
  `status=${partyRes.status} total=${partyRes.body?.totalRows} imported=${partyRes.body?.importedRows} error=${partyRes.body?.errorRows}`,
);
const pIssues = partyRes.body?.issues ?? [];
const codeAt = (row) => pIssues.filter((i) => i.row === row).map((i) => i.code);
ok(
  `第 ${rowNo(1)} 行（同文件重复）→ duplicate_row`,
  codeAt(rowNo(1)).includes("duplicate_row"),
  codeAt(rowNo(1)).join(","),
);
ok(
  `第 ${rowNo(3)} 行（证件号命中既有档案）→ identity_exists`,
  codeAt(rowNo(3)).includes("identity_exists"),
  codeAt(rowNo(3)).join(","),
);
ok(
  `第 ${rowNo(4)} 行（同证件号不同名称）→ identity_exists（证件号优先于名称）`,
  codeAt(rowNo(4)).includes("identity_exists"),
  codeAt(rowNo(4)).join(","),
);
ok(
  `第 ${rowNo(5)} 行（本企业名）→ own_company`,
  codeAt(rowNo(5)).includes("own_company"),
  codeAt(rowNo(5)).join(","),
);
ok(
  `第 ${rowNo(7)} 行（名称只有 1 个字）→ invalid_field，且字段名是中文列名`,
  codeAt(rowNo(7)).includes("invalid_field") &&
    pIssues.some((i) => i.row === rowNo(7) && i.field === "当事人名称"),
  JSON.stringify(pIssues.filter((i) => i.row === rowNo(7))),
);

const [partyCount] = await sql`
  select count(*)::int as n from mn_party where name like ${`${P}-当事人%`}`;
ok("库里新增 3 份档案（重复行没有多建）", partyCount.n === 3, `n=${partyCount.n}`);
const [preCount] = await sql`select count(*)::int as n from mn_party where name = ${preName}`;
ok("既有档案没有被复制成第二份", preCount.n === 1, `n=${preCount.n}`);
const [enc] = await sql`
  select id_number, id_number_hash from mn_party where name = ${`${P}-当事人A`}`;
ok(
  "证件号落库是**密文**且带盲索引（导入没有绕开加密链路）",
  Boolean(enc) && enc.id_number !== A_ID && enc.id_number?.startsWith("v1:") && enc.id_number_hash,
  `id_number=${String(enc?.id_number).slice(0, 12)}… hash=${String(enc?.id_number_hash).slice(0, 8)}…`,
);

/* ───────────────────────── ④ 事项模板：逐行跳过 ───────────────────────── */

const tplLevel = "高";
const riskRows = [
  {
    事项名称: `${P}-事项1`,
    风险类型: "合同",
    风险等级: tplLevel,
    风险描述: "对方拖欠货款三个月",
    发现日期: "2024/1/5",
    处理人: admin.username,
    对方当事人: `${P}-对手甲`,
    对方当事人证件号: uscc(4),
    对方诉讼地位: "被告",
  },
  {
    事项名称: `${P}-事项2`,
    风险类型: "劳动争议",
    风险等级: "中",
    风险描述: "员工仲裁申请",
    来源: "对外纠纷/投诉",
    对方当事人: `${P}-对手甲、${P}-对手乙`,
    对方当事人证件号: `${uscc(4)}、`,
  },
  // 同名不同证件号 → **新建一份**（T3 口径：绝不自动合并）
  {
    事项名称: `${P}-事项3`,
    风险类型: "contract",
    风险等级: "低",
    风险描述: "同名不同证件号",
    对方当事人: `${P}-对手甲`,
    对方当事人证件号: uscc(5),
  },
  // ↓↓↓ 坏行（逐行跳过，各自的原因码不同）
  { 事项名称: `${P}-坏1`, 风险类型: "非诉", 风险等级: "高", 风险描述: "作废枚举值" },
  { 事项名称: `${P}-坏2`, 风险类型: "合同", 风险等级: "超高", 风险描述: "等级不在配置里" },
  { 事项名称: `${P}-坏3`, 风险类型: "合同", 风险等级: "高", 风险描述: "" },
  { 事项名称: `${P}-坏4`, 风险类型: "合同", 风险等级: "高", 风险描述: "处理人查不到", 处理人: "查无此人" },
  { 事项名称: `${P}-坏5`, 风险类型: "合同", 风险等级: "高", 风险描述: "日期读不出来", 发现日期: "去年三月" },
  { 事项名称: "短", 风险类型: "合同", 风险等级: "高", 风险描述: "名称太短" },
  {
    事项名称: `${P}-坏7`,
    风险类型: "合同",
    风险等级: "高",
    风险描述: "证件号比当事人多",
    对方当事人: `${P}-对手丙`,
    对方当事人证件号: `${uscc(6)}、${uscc(7)}`,
  },
  { 事项名称: `${P}-坏8`, 风险类型: "合同", 风险等级: "高", 风险描述: "本企业名随行", 对方当事人: OWN_COMPANY },
];
const riskFile = fileWith("risk_matter", riskRows);
const riskRes = await post("risk_matter", "事项.csv", riskFile);
if (riskRes.body?.batchId) batchIds.push(riskRes.body.batchId);
const R = riskRes.body ?? {};
ok(
  "事项导入：11 行里 3 行进库、8 行未进库",
  riskRes.status === 200 && R.importedRows === 3 && R.errorRows === 8 && R.totalRows === 11,
  `status=${riskRes.status} total=${R.totalRows} imported=${R.importedRows} error=${R.errorRows}`,
);
ok(
  "**恒等式**：total_rows = imported_rows + error_rows（防「少了行」的头号断言）",
  R.totalRows === R.importedRows + R.errorRows,
);
const rIssues = R.issues ?? [];
const rCodeAt = (row) => rIssues.filter((i) => i.row === row).map((i) => i.code);
ok(
  `第 ${rowNo(3)} 行（作废值「非诉」）→ unknown_enum（模板与导入器都不收作废值）`,
  rCodeAt(rowNo(3)).includes("unknown_enum"),
  rCodeAt(rowNo(3)).join(","),
);
ok(`第 ${rowNo(4)} 行（等级不在配置里）→ unknown_config`, rCodeAt(rowNo(4)).includes("unknown_config"));
ok(`第 ${rowNo(5)} 行（风险描述空）→ required`, rCodeAt(rowNo(5)).includes("required"));
ok(`第 ${rowNo(6)} 行（处理人查不到）→ unknown_user`, rCodeAt(rowNo(6)).includes("unknown_user"));
ok(`第 ${rowNo(7)} 行（日期读不出来）→ invalid_field`, rCodeAt(rowNo(7)).includes("invalid_field"));
ok(
  `第 ${rowNo(8)} 行（名称太短）→ invalid_field 且字段是「事项名称」（zod 路径翻成人话）`,
  rCodeAt(rowNo(8)).includes("invalid_field") &&
    rIssues.some((i) => i.row === rowNo(8) && i.field === "事项名称"),
  JSON.stringify(rIssues.filter((i) => i.row === rowNo(8))),
);
ok(`第 ${rowNo(9)} 行（证件号比当事人多）→ party_mismatch`, rCodeAt(rowNo(9)).includes("party_mismatch"));
ok(`第 ${rowNo(10)} 行（本企业名随行）→ own_company`, rCodeAt(rowNo(10)).includes("own_company"));

const [riskRowsDb] = await sql`
  select count(*)::int as n from mn_risk_matter where name like ${`${P}%`}`;
ok("坏行**一条记录都没建**（3 条好行 = 库里 3 条）", riskRowsDb.n === 3, `n=${riskRowsDb.n}`);
const [good1] = await sql`
  select code, status, discover_date::text as discover_date, owner_id, source, type, level
  from mn_risk_matter where name = ${`${P}-事项1`}`;
ok("事项编号走 FX 生成器（不是空、不是手写）", /^FX-\d{8}-\d{3,}$/.test(good1?.code ?? ""), good1?.code);
const [initial] = await sql`
  select code from mn_status_config where host_type = 'risk_matter' and is_initial_status`;
ok(
  "初始态取自配置表（`is_initial_status` 那一行），不是字面量",
  good1?.status === initial?.code,
  `落库=${good1?.status} 配置=${initial?.code}`,
);
ok("日期 2024/1/5 归一成 2024-01-05", good1?.discover_date === "2024-01-05", String(good1?.discover_date));
ok("处理人按账号解析成 id", String(good1?.owner_id) === String(admin.id));
ok("枚举中文名解析成码（合同→contract）", good1?.type === "contract" && good1?.level === "high");
const [good2] = await sql`
  select source, owner_id from mn_risk_matter where name = ${`${P}-事项2`}`;
ok(
  "来源中文名（对外纠纷/投诉）解析成码，且**事项侧处理人可空**（未指派是一等状态）",
  good2?.source === "external_dispute" && good2?.owner_id === null,
  `source=${good2?.source} owner=${good2?.owner_id}`,
);
const [partyLinks] = await sql`
  select count(*)::int as n from mn_risk_matter_party rp
  join mn_risk_matter r on r.id = rp.risk_matter_id
  where r.name = ${`${P}-事项2`}`;
ok("一行挂两个当事人（多值按位置配证件号）", partyLinks.n === 2, `n=${partyLinks.n}`);
const [sameNameParties] = await sql`
  select count(*)::int as n from mn_party where name = ${`${P}-对手甲`}`;
ok(
  "同名不同证件号**新建**了第二份档案（绝不自动合并 —— T3 口径）",
  sameNameParties.n === 2,
  `n=${sameNameParties.n}`,
);

/* ───────────────────────── ⑤ 错误报告下载 ───────────────────────── */

const rep = await call("GET", `/api/import/report/${R.reportRef}`, adminC);
const repCsv = typeof rep.body?.csv === "string" ? rep.body.csv.replace(/^\uFEFF/, "") : "";
const repLines = repCsv.split("\r\n").filter((l) => l !== "");
ok("报告可下载（200 + csv）", rep.status === 200 && repLines.length > 1, `status=${rep.status}`);
ok("报告前三列是「行号/字段/原因」", repLines[0]?.startsWith("行号,字段,原因"), repLines[0]);
ok(
  "报告覆盖全部 8 个坏行（行号就是 Excel 里那个行号）",
  [3, 4, 5, 6, 7, 8, 9, 10].map(rowNo).every((n) =>
    repLines.slice(1).some((l) => l.split(",")[0] === String(n)),
  ),
  repLines
    .slice(1)
    .map((l) => l.split(",")[0])
    .join(" "),
);
ok(
  "报告**不含证件号原文**（当事人行里的敏感值不许抄进不加密的表）",
  !repCsv.includes(uscc(4)) && !repCsv.includes(uscc(5)) && !repCsv.includes(B_ID),
);
ok(
  "报告里带「未导入」状态列",
  repLines.slice(1).some((l) => l.includes("未导入")),
);
ok(
  "报告引用不存在 → 404（不是 500）",
  (await call("GET", "/api/import/report/999999999999", adminC)).status === 404,
);
ok(
  "报告 id 非法 → 400（不是 500）",
  (await call("GET", "/api/import/report/abc", adminC)).status === 400,
);

/* ───────────────────────── ⑥ 一条 BULK_IMPORT + 逐行 *_CREATED ───────────────────────── */

const audits = await sql`
  select action, payload, target_type, matter_id, risk_matter_id
  from mn_activity_log
  where action = 'BULK_IMPORT' and payload->>'report_ref' = ${String(R.reportRef)}`;
ok("这次导入**恰好一条** BULK_IMPORT 汇总", audits.length === 1, `n=${audits.length}`);
const ap = audits[0]?.payload ?? {};
ok(
  "载荷五键与枚举表 §3.5 逐字一致",
  JSON.stringify(Object.keys(ap).sort()) ===
    JSON.stringify(["error_rows", "host_type", "imported_rows", "report_ref", "total_rows"]),
  JSON.stringify(ap),
);
ok(
  "载荷里的行数与响应一致（日志与批次不会各说一套）",
  ap.total_rows === R.totalRows && ap.imported_rows === R.importedRows && ap.error_rows === R.errorRows,
  JSON.stringify(ap),
);
ok(
  "汇总日志**不挂业务宿主**（账号维度落点，E03 的 app_user 是唯一合法口子）",
  audits[0]?.target_type === "app_user" &&
    audits[0]?.matter_id === null &&
    audits[0]?.risk_matter_id === null,
);
const [bulkTotal] = await sql`
  select count(*)::int as n from mn_activity_log
  where action = 'BULK_IMPORT' and operator_id = ${admin.id}`;
ok(
  "两次导入 → 两条汇总（**不逐行写**：11 行的事项导入只留 1 条）",
  bulkTotal.n === 2,
  `n=${bulkTotal.n}（当事人 + 事项；案件那条还没跑）`,
);
const [createdAudit] = await sql`
  select count(*)::int as n from mn_activity_log a
  join mn_risk_matter r on r.id = a.risk_matter_id
  where a.action = 'RISK_CREATED' and r.name like ${`${P}%`}`;
ok(
  "导入行本身各写一条 *_CREATED（§3.5 末句；否则详情页的活动日志会从空开始）",
  createdAudit.n === 3,
  `n=${createdAudit.n}`,
);

/* ───────────────────────── ⑦ 案件模板：挂接既有档案 + 精度 ───────────────────────── */

const matterRows = [
  {
    案件名称: `${P}-案件1`,
    案由: "买卖合同纠纷",
    案件类型: "民商事",
    审级程序: "一审",
    我方诉讼地位: "原告",
    受理法院: "南京市中级人民法院",
    立案日期: "2024/3/7",
    // 带千分位：Excel 会给含逗号的格加引号，这条夹具同时覆盖「引号路径」与 18 位精度
    标的额: "1,234,567,890,123,456.78",
    风险等级: "高",
    案件描述: "历史案件",
    处理人: adminName,
    对方当事人: preName,
    对方当事人证件号: preIdNumber,
  },
  // 处理人必填：留空必须报出来，而不是回落到导数据的人头上
  {
    案件名称: `${P}-坏案1`,
    案由: "买卖合同纠纷",
    案件类型: "民商事",
    审级程序: "一审",
    我方诉讼地位: "原告",
    风险等级: "高",
  },
  // 我方诉讼地位不是枚举值
  {
    案件名称: `${P}-坏案2`,
    案由: "买卖合同纠纷",
    案件类型: "民商事",
    审级程序: "一审",
    我方诉讼地位: "原告方",
    风险等级: "高",
    处理人: adminName,
  },
];
const matterRes = await post("matter", "案件.csv", fileWith("matter", matterRows));
if (matterRes.body?.batchId) batchIds.push(matterRes.body.batchId);
const M = matterRes.body ?? {};
ok(
  "案件导入：3 行里 1 行进库、2 行未进库",
  matterRes.status === 200 && M.importedRows === 1 && M.errorRows === 2 && M.totalRows === 3,
  `total=${M.totalRows} imported=${M.importedRows} error=${M.errorRows}`,
);
ok(
  "缺处理人 → required（**不回落成操作人**：那会把历史案件挂到导数据的人头上）",
  (M.issues ?? []).some((i) => i.row === rowNo(1) && i.field === "处理人" && i.code === "required"),
  JSON.stringify((M.issues ?? []).filter((i) => i.row === rowNo(1))),
);
ok(
  "我方诉讼地位不认识「原告方」→ unknown_enum（枚举名而不是静默写入）",
  (M.issues ?? []).some((i) => i.row === rowNo(2) && i.code === "unknown_enum"),
);
const [m1] = await sql`
  select id, internal_code, case_no, amount, status, owner_id, filing_date::text as filing_date, court
  from mn_matter where name = ${`${P}-案件1`}`;
ok("案号留空时取内部编号（A…）", m1?.case_no === m1?.internal_code, `${m1?.case_no} / ${m1?.internal_code}`);
ok("案件金额 18 位有效数字不丢分（全程字符串，零 Number()）", m1?.amount === "1234567890123456.78", String(m1?.amount));
ok("立案日期归一", m1?.filing_date === "2024-03-07", String(m1?.filing_date));
const [initialM] = await sql`
  select code from mn_status_config where host_type = 'matter' and is_initial_status`;
ok("案件初始态也取配置表", m1?.status === initialM?.code, `${m1?.status} / ${initialM?.code}`);
const [link] = await sql`
  select mp.party_id from mn_matter_party mp where mp.matter_id = ${m1?.id}`;
ok(
  "当事人随行**挂接既有档案**（不是又建一份）",
  String(link?.party_id) === String(pre.body?.id),
  `link=${link?.party_id} 既有=${pre.body?.id}`,
);
const [staff] = await sql`
  select user_id from mn_matter_staff where matter_id = ${m1?.id} and staff_role = 'owner'`;
ok("案件处理人落成 owner 参与人行", String(staff?.user_id) === String(admin.id));
const [court] = await sql`select court from mn_matter where name = ${`${P}-案件1`}`;
ok("受理法院按原文落库", court?.court === "南京市中级人民法院");

/**
 * 报告里那一列「字段」要是**中文列名**，不是内部键。
 * 这条钉的是 `labelIssues` 在**落库**那一侧的调用点（摘要那一侧由上面那条 required 断言钉）。
 * 少了它，"报告里写 ownerId 而不是「处理人」"这种回归是看不见的 —— 报告照样能下载。
 */
const mReport = await call("GET", `/api/import/report/${M.reportRef}`, adminC);
const mReportCsv = typeof mReport.body?.csv === "string" ? mReport.body.csv : "";
ok(
  "报告里的字段列是中文列名（「处理人」而不是 ownerId）",
  mReportCsv.includes("处理人") && !mReportCsv.includes("ownerId"),
  mReportCsv.split("\r\n")[1] ?? "",
);

/* ───────────────────────── ⑧ 幂等重放 ───────────────────────── */

const before = await sql`
  select
    (select count(*)::int from mn_risk_matter where name like ${`${P}%`}) as risks,
    (select count(*)::int from mn_party where name like ${`${P}%`}) as parties,
    (select count(*)::int from mn_activity_log where operator_id = ${admin.id} and action in ('RISK_CREATED','MATTER_CREATED','PARTY_CREATED')) as created_logs`;
const replay = await post("risk_matter", "事项.csv", riskFile);
if (replay.body?.batchId) batchIds.push(replay.body.batchId);
ok(
  "同文件重导：**一行都不新增**（好行按内容命中，坏行照旧是坏的）",
  replay.status === 200 && replay.body.importedRows === 0 && replay.body.errorRows === 11,
  `imported=${replay.body?.importedRows} error=${replay.body?.errorRows}`,
);
ok(
  "同文件重导被识别为 replayed（零新增 + 确有行是「已经导过」）",
  replay.body.replayed === true,
);
const replayAt = (row) => (replay.body.issues ?? []).filter((i) => i.row === row).map((i) => i.code);
ok(
  "三条好行的原因都是 already_imported（不是笼统一句「重复」）",
  [0, 1, 2].map(rowNo).every((n) => replayAt(n).includes("already_imported")),
  [0, 1, 2].map((i) => `${rowNo(i)}:${replayAt(rowNo(i)).join("|")}`).join(" "),
);
ok(
  "坏行重导时**仍然是原来的原因**（它们本来就没进库，不该被说成「已导入」）",
  replayAt(rowNo(3)).includes("unknown_enum") && replayAt(rowNo(5)).includes("required"),
  `${rowNo(3)}:${replayAt(rowNo(3)).join("|")} ${rowNo(5)}:${replayAt(rowNo(5)).join("|")}`,
);
const after = await sql`
  select
    (select count(*)::int from mn_risk_matter where name like ${`${P}%`}) as risks,
    (select count(*)::int from mn_party where name like ${`${P}%`}) as parties,
    (select count(*)::int from mn_activity_log where operator_id = ${admin.id} and action in ('RISK_CREATED','MATTER_CREATED','PARTY_CREATED')) as created_logs`;
ok(
  "重导之后库里的业务行数与逐行审计数**一个都没变**",
  before[0].risks === after[0].risks &&
    before[0].parties === after[0].parties &&
    before[0].created_logs === after[0].created_logs,
  `risks ${before[0].risks}→${after[0].risks} parties ${before[0].parties}→${after[0].parties} logs ${before[0].created_logs}→${after[0].created_logs}`,
);

// 改一行再传：只有被改的那一行进库，其余按内容命中
const fixedRows = riskRows.map((r) =>
  r.事项名称 === `${P}-坏1`
    ? { ...r, 风险类型: "知识产权", 风险描述: "改过之后应该只补这一行" }
    : r,
);
const fixedRes = await post("risk_matter", "事项-已修正.csv", fileWith("risk_matter", fixedRows));
if (fixedRes.body?.batchId) batchIds.push(fixedRes.body.batchId);
ok(
  "改一行再传：只补那 1 行，其余 10 行按内容命中（**不整份重导**）",
  fixedRes.body?.importedRows === 1 && fixedRes.body?.errorRows === 10,
  `imported=${fixedRes.body?.importedRows} error=${fixedRes.body?.errorRows}`,
);
ok(
  "补进来的那一行真的是改后的内容",
  (await sql`select type from mn_risk_matter where name = ${`${P}-坏1`}`)[0]?.type === "ip",
);
const [ipCount] = await sql`select count(*)::int as n from mn_risk_matter where name = ${`${P}-坏1`}`;
ok("改后重传没有把那一行建两次", ipCount.n === 1, `n=${ipCount.n}`);

/* ───────────────────────── ⑨ 幂等键的 DB 兜底 ───────────────────────── */

const probeBatch = BigInt(Date.now()) * 1000n + 7n;
await sql`insert into mn_import_batch (id, host_type, file_name, status, created_by)
  values (${probeBatch}, 'party', 'probe.csv', 'completed', ${admin.id})`;
await sql`insert into mn_import_row (id, batch_id, host_type, row_no, row_hash, status)
  values (${probeBatch + 1n}, ${probeBatch}, 'party', 2, 'probehash', 'imported')`;
let dupErr = null;
try {
  await sql`insert into mn_import_row (id, batch_id, host_type, row_no, row_hash, status)
    values (${probeBatch + 2n}, ${probeBatch}, 'party', 3, 'probehash', 'imported')`;
} catch (e) {
  dupErr = e;
}
ok(
  "幂等键有 **DB 级**兜底：同 kind 同内容不可能被导入两次（并发也拦得住）",
  dupErr?.code === "23505",
  dupErr ? dupErr.code : "第二次插入竟然成功了",
);
let nullOk = false;
try {
  await sql`insert into mn_import_row (id, batch_id, host_type, row_no, row_hash, status)
    values (${probeBatch + 3n}, ${probeBatch}, 'party', 4, null, 'imported')`;
  nullOk = true;
} catch {
  nullOk = false;
}
ok("partial 索引的边界：未占键（row_hash IS NULL）的行不受它约束", nullOk);
await sql`delete from mn_import_batch where id = ${probeBatch}`;

/* ───────────────────────── ⑩ 批次列表 ───────────────────────── */

const batches = await call("GET", "/api/import/batches", adminC);
const mine = (batches.body?.items ?? []).filter((b) => batchIds.includes(b.id));
ok(
  "批次列表带 reportRef，且能看到本次几次导入",
  batches.status === 200 && mine.length === batchIds.length && mine.every((b) => b.reportRef === b.id),
  `看到 ${mine.length}/${batchIds.length} 批`,
);
ok(
  "批次列表里的计数与当时响应一致",
  mine.every((b) => b.totalRows === b.importedRows + b.errorRows),
);
ok(
  "批次状态收尾为 completed",
  mine.every((b) => b.status === "completed"),
  [...new Set(mine.map((b) => b.status))].join(","),
);

/* ─────────── ⑪ 预检（`?dryRun=1`）与真导走同一条实现 ─────────── */

/**
 * 票面那条**真库**验收（MATT-102 干完活后留给父代理的那条）：同一份文件先预检再真导，
 * 两个响应的计数一致。
 *
 * 结构证明在 `import.spec.ts`（预检不另起一条解析路径）。这里补的是库这一侧：
 * "同一段代码"不蕴含"两次跑出的数字一样" —— 中间隔着**既有档案查重**与**幂等判定**，
 * 而这两件事都要读库，是分支之外的活。
 *
 * 五条断言各钉一个失效方式：
 *   ① 计数逐项一致 —— 预检说能导 2 行，真导就得进 2 行。预检谎报的代价是用户按预检
 *      决定要不要导，导完发现不是那个数；
 *   ② 行级明细一致 —— 行号/字段/原因逐条相同，不是"总数碰巧对上、各错一半"；
 *   ③ 预检**没写库** —— 不落批次行、不给批次 id。给了会引出两个后果：「最近导入」
 *      多一条什么都没导的记录，以及预检把幂等键占掉、真导反倒变成"重放"；
 *   ④ 真导不是重放 —— ③ 的直接后果，单独钉一条（否则 ③ 红了会伪装成"导入坏了"）；
 *   ⑤ **导完再预检**要报 0 新增且 `replayed`。谁把幂等判定挪进 `if (!dryRun)` 这条就红，
 *      而那正是"预检把已导过的行报成还能导"的成因。
 *
 * 夹具**夹了一行坏行**：只比计数的话，一行坏行 + 一行被吞，总数照样对得上。
 */
const drA = `${P}-预检甲`;
const drB = `${P}-预检乙`;
const drCsv = fileWith("party", [
  { 当事人名称: drA, 当事人类型: "法人", 证件类型: "统一社会信用代码", 证件号: uscc(11) },
  // 名称 1 个字 → DTO 拦下。它必须在**两份**响应里以同样的行号/字段/原因出现
  { 当事人名称: "乙", 当事人类型: "法人" },
  { 当事人名称: drB, 当事人类型: "自然人", 证件类型: "居民身份证", 证件号: idCard(12) },
]);
const DR_FILE = "预检与真导.csv";
/** 这一批落库了没有 —— 按「谁建的 + 文件名」查：预检那次本来就没有 id 可查 */
const drBatches = async () =>
  (
    await sql`select count(*)::int as n from mn_import_batch
      where created_by = ${admin.id} and file_name = ${DR_FILE}`
  )[0].n;
/** 行级明细的指纹。**不含 message** —— `already_imported` 的文案里带着上一次的批次号，
    两次跑必然不同，把它算进去会把"同一判定"误判成"两次不一样" */
const drKey = (r) =>
  (r.body?.issues ?? [])
    .map((i) => `${i.row}:${i.field ?? ""}:${i.code}`)
    .sort()
    .join(" | ");

const dry = await call("POST", "/api/import?dryRun=1", adminC, {
  hostType: "party",
  fileName: DR_FILE,
  csv: drCsv,
});
ok(
  "预检：200，逐行判定照跑（2 行能导、1 行坏行）",
  dry.status === 200 && dry.body?.importedRows === 2 && dry.body?.errorRows === 1,
  `status=${dry.status} total=${dry.body?.totalRows} imported=${dry.body?.importedRows} error=${dry.body?.errorRows}`,
);
ok(
  "预检**不落批次行**（库里查不到这一批：「最近导入」不该多一条什么都没导的记录）",
  (await drBatches()) === 0,
);
ok(
  "预检不给批次 id / 报告号（给了用户就会去点「下载错误报告」，撞 404 读起来像报告丢了）",
  dry.body?.batchId === "" && dry.body?.reportRef === "",
  `batchId=${JSON.stringify(dry.body?.batchId)} reportRef=${JSON.stringify(dry.body?.reportRef)}`,
);

const real = await post("party", DR_FILE, drCsv);
if (real.body?.batchId) batchIds.push(real.body.batchId);
ok(
  "同一份文件真导：计数与预检**逐项相同**",
  real.status === 200 &&
    real.body?.importedRows === dry.body?.importedRows &&
    real.body?.errorRows === dry.body?.errorRows &&
    real.body?.totalRows === dry.body?.totalRows,
  `预检 ${dry.body?.importedRows}/${dry.body?.errorRows}/${dry.body?.totalRows} · 真导 ${real.body?.importedRows}/${real.body?.errorRows}/${real.body?.totalRows}`,
);
ok(
  "两份响应的行级明细**逐条相同**（行号 / 字段 / 原因），不是只有总数齐",
  drKey(dry) !== "" && drKey(dry) === drKey(real),
  `预检 [${drKey(dry)}] · 真导 [${drKey(real)}]`,
);
ok(
  "真导**不是重放**：预检没把幂等键占掉",
  real.body?.replayed === false,
  `replayed=${real.body?.replayed}`,
);
ok("真导落了**一批**（预检那次没落）", (await drBatches()) === 1, `n=${await drBatches()}`);

const dry2 = await call("POST", "/api/import?dryRun=1", adminC, {
  hostType: "party",
  fileName: DR_FILE,
  csv: drCsv,
});
ok(
  "导完再预检：0 新增 + `replayed` —— 幂等判定在预检里照样参与，预检不谎报「还能导」",
  dry2.status === 200 && dry2.body?.importedRows === 0 && dry2.body?.replayed === true,
  `imported=${dry2.body?.importedRows} error=${dry2.body?.errorRows} replayed=${dry2.body?.replayed}`,
);
ok(
  "再预检的**未导入数 = 原来能导的 + 原来就坏的**：那两行由「能导」翻成了 `already_imported`",
  // 这一条一开始被我写成 `errorRows === 预检的 errorRows`（1），红了。**红得对**：
  // 重放的行落在 `errorRows` 里（它们确实没进库），所以是 1 + 2 = 3。
  // 写成"两次数相等"会把这条恒等式钉错，等于给"重放的行从计数里消失"背书。
  dry2.body?.errorRows === dry.body.importedRows + dry.body.errorRows,
  `再预检 error=${dry2.body?.errorRows}（预期 ${dry.body?.importedRows}+${dry.body?.errorRows}）`,
);

/* ───────────────────────── 清场 ───────────────────────── */

await cleanup();

const [residue] = await sql`
  select
    (select count(*)::int from mn_risk_matter where name like ${`${P}%`}) as risks,
    (select count(*)::int from mn_matter where name like ${`${P}%`}) as matters,
    (select count(*)::int from mn_party where name like ${`${P}%`}) as parties,
    (select count(*)::int from mn_import_batch where id in ${sql(batchIds.length ? batchIds : ["0"])}) as batches`;
ok(
  "清场：夹具的业务行与批次都删干净了",
  residue.risks === 0 && residue.matters === 0 && residue.parties === 0 && residue.batches === 0,
  JSON.stringify(residue),
);

console.log(`\n通过 ${pass} · 失败 ${fail}`);
if (fail > 0) console.log(`失败项：\n  - ${failedNames.join("\n  - ")}`);
await sql.end();
finishSmoke(fail > 0);

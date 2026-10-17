import {
  createSmokeAccount,
  dropSmokeAccountsSafely,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";

/**
 * 列表导出（MATT-64 / F1-20 事项 + F2-23 案件）的**真 HTTP 冒烟**。
 *
 * ## 跑法
 *
 *   node --env-file=.env agent-work/smoke-list-export.mjs      # dev server 在 3777（SMOKE_BASE 可覆盖）
 *
 * ## 先反向红一次（本仓纪律：没有反向红的冒烟等于没有冒烟）
 *
 *   node agent-work/revred-list-export.mjs split-predicate     # 让导出自己拼一套谓词（漏掉归档二态）
 *   node --env-file=.env agent-work/smoke-list-export.mjs      # ⇒ 必须红（④ 两条）
 *   node agent-work/revred-list-export.mjs split-predicate restore
 *   node agent-work/revred-list-export.mjs no-gate             # 摘掉明文导出的那道门
 *   node --env-file=.env agent-work/smoke-list-export.mjs      # ⇒ 必须红（⑧ / ⑩ 两条）
 *   node agent-work/revred-list-export.mjs no-gate restore
 *   node --env-file=.env agent-work/smoke-list-export.mjs      # ⇒ 必须绿
 *
 * ## 断言清单（票面逐条）
 *
 *   ① 夹具就位：三件在办案件 + 一件**已归档**案件 + 两件事项（一件未指派），都带同一个
 *      唯一关键词 —— 下面每条只量自己这一批（共享 dev 库里别人的夹具不会被算进来）；
 *   ② 建案/建事项 201（夹具自证：夹具没建起来时，后面的行数断言会以"假红"的形式骗人）；
 *   ③ **导出行数 == 同一筛选下列表的 total**（案件 · 默认在办视图）—— 本票最要紧的一条；
 *   ④ 归档视图上再算一遍（`archivedOnly=1`）：恰好 1 件归档案件，所以两边都必须是 1
 *      （漏掉归档二态就会 3 vs 1）；且在办档里没有它、归档档里只有它；
 *   ⑤ CSV 自洽：BOM 开头、中文表头、`数据行 = rows`（**rows 不含表头**）、
 *      导出的编号集合逐条对上列表那一屏；
 *   ⑥ 关键词真的进了导出（更窄的关键词下两边都是 1，不是 3）；
 *   ⑦ 排序也进了导出（`sortBy=code&sortDir=asc` ⇒ 首行是最小的那个编号）；
 *   ⑧ 两档：无 `canReadPlain` 调 `plain=1` ⇒ 403 `privilege_required`；有特权 ⇒ 200 且 `plain=true`；
 *   ⑨ **整批一条 `EXPORT`**（不是逐行）：单次导出前后审计行数差恰好 1；载荷五键
 *      `{target_type, scope, rows, count, plain}` 且 `rows` 与响应一致；日志落在
 *      **账号维度**（`target_type='app_user'`、宿主列全空）——跨宿主的导出挂到某一个案件上是说谎；
 *   ⑩ **范围谓词**（AC 第 5 条）：只参与了一件的账号（L2）导出的行数 == 它列表的 total，
 *      且导出的 CSV 里没有别人那几件的编号；归档档对它是 0；
 *   ⑪ 事项侧同形，外加 `ownerEmpty=1`（未指派）这一档；
 *   ⑫ 参数：案件侧非法 `status`/`sortBy` ⇒ 400；事项侧自定义状态（配置驱动）⇒ 200。
 *
 * 清场：本脚本自己建的案件/事项（含预设节点、活动日志、边表）全删，再删两个临时账号
 * （`dropSmokeAccount` 拒绝代删业务行 —— 夹具必须自己清干净）。
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
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

/** CSV 数据行（去掉 BOM 与表头行）。`csvCell` 把换行折成空格，所以按 `\r\n` 切是准的 */
const csvDataRows = (csv) =>
  String(csv ?? "")
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .slice(1);
const csvHeader = (csv) => String(csv ?? "").replace(/^\uFEFF/, "").split("\r\n")[0] ?? "";
/** 一行的第一格（编号列） */
const firstCell = (line) => String(line ?? "").split(",")[0] ?? "";

const stamp = Date.now();
/** 夹具的唯一关键词：共享库里只量自己这一批（别人的夹具不带这个串） */
const TAG = `MATT64${stamp}`;

const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const l1acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
/** L2：参与经办、**没有** `canReadPlain`。用来撞明文导出的 403，也用来证明导出受范围谓词 */
const l2acct = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
const matterIds = [];
const riskIds = [];

const matterBody = (tag) => ({
  name: `冒烟案件-${tag}-${TAG}`,
  cause: "买卖合同纠纷",
  caseType: "civil_commercial",
  procedure: "first_instance",
  litigationRole: "plaintiff",
  level: "mid",
});
const riskBody = (tag, ownerId) => ({
  name: `冒烟事项-${tag}-${TAG}`,
  type: "contract",
  level: "mid",
  description: `冒烟夹具描述-${TAG}`,
  ...(ownerId === null ? {} : { ownerId }),
});

async function cleanup() {
  const mids = matterIds.map(BigInt);
  const rids = riskIds.map(BigInt);
  try {
    if (mids.length) {
      await sql`delete from mn_activity_log where matter_id = any(${sql.array(mids)}::bigint[])`;
      await sql`delete from mn_matter_party where matter_id = any(${sql.array(mids)}::bigint[])`;
      await sql`delete from mn_matter_node where matter_id = any(${sql.array(mids)}::bigint[])`;
      await sql`delete from mn_matter_staff where matter_id = any(${sql.array(mids)}::bigint[])`;
      await sql`delete from mn_matter_progress where matter_id = any(${sql.array(mids)}::bigint[])`;
      await sql`delete from mn_matter where id = any(${sql.array(mids)}::bigint[])`;
    }
    if (rids.length) {
      await sql`delete from mn_activity_log where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_risk_matter_party where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_risk_matter_node where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_risk_matter_staff where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_risk_matter where id = any(${sql.array(rids)}::bigint[])`;
    }
  } catch (e) {
    noteCleanupFailure(`业务夹具（案件 ${mids.length} / 事项 ${rids.length}）`, e);
  }
}

/** 本账号在某个 scope 下写了多少条 EXPORT 审计（只数自己的，别的流不影响） */
const auditCount = async (accountId, scope) => {
  const [row] = await sql`select count(*)::int as n from mn_activity_log
    where operator_id = ${accountId} and action = 'EXPORT' and payload->>'scope' = ${scope}`;
  return row.n;
};
/** 最近一条该 scope 的导出日志 */
const lastAudit = (accountId, scope) => sql`select target_type, matter_id, risk_matter_id, payload
    from mn_activity_log
   where operator_id = ${accountId} and action = 'EXPORT' and payload->>'scope' = ${scope}
   order by created_at desc, id desc limit 1`;

try {
  const a1 = await login(l1acct.username, l1acct.password);
  ok("L1 登录（full_admin + is_admin + can_read_plain）", a1.status === 200, `status=${a1.status}`);
  const l1 = a1.cookie;
  const a2 = await login(l2acct.username, l2acct.password);
  ok("L2 登录（joined_operator，无 can_read_plain）", a2.status === 200, `status=${a2.status}`);
  const l2 = a2.cookie;

  // ── ① 夹具 ──
  const mA = await call("POST", "/api/matters", l1, matterBody("甲"));
  const mB = await call("POST", "/api/matters", l1, matterBody("乙"));
  /** 这一件由 **L2** 建：它就是 L2 唯一看得见的那一条（范围谓词那几条断言靠它做对照） */
  const mC = await call("POST", "/api/matters", l2, matterBody("丙"));
  const mD = await call("POST", "/api/matters", l1, matterBody("丁"));
  for (const m of [mA, mB, mC, mD]) if (m.body?.id) matterIds.push(m.body.id);
  ok(
    "建四件案件（丙由 L2 建、丁随后归档）→ 全部 201",
    [mA, mB, mC, mD].every((m) => m.status === 201) && matterIds.length === 4,
    `status=${[mA.status, mB.status, mC.status, mD.status].join(",")}`,
  );
  const archStep = await call("POST", `/api/matters/${mD.body?.id}/status`, l1, {
    to: "archived",
    reason: `冒烟夹具：验证列表导出的归档档（${TAG}）`,
  });
  ok("把丁归档（④ 的归档档靠它）", archStep.status === 200, `status=${archStep.status}`);

  const rD = await call("POST", "/api/risk-matters", l1, riskBody("戊", null));
  const rE = await call("POST", "/api/risk-matters", l1, riskBody("己", String(l1acct.id)));
  for (const r of [rD, rE]) if (r.body?.id) riskIds.push(r.body.id);
  ok(
    "建两件事项（戊**未指派**、己指派给 L1）→ 全部 201",
    [rD, rE].every((r) => r.status === 201) && riskIds.length === 2,
    `status=${[rD.status, rE.status].join(",")}`,
  );

  // ── ② 列表基准（下面每条都拿它做分母） ──
  const listL1 = await call("GET", `/api/matters?keyword=${TAG}`, l1);
  const codesL1 = (listL1.body?.items ?? []).map((x) => x.internalCode);
  const totalL1 = Number(listL1.body?.total ?? -1);
  ok(
    "L1 的在办列表：keyword 下 3 条（丁已归档，不在在办视图里）",
    listL1.status === 200 && totalL1 === 3,
    `total=${totalL1} codes=${codesL1.join("|")}`,
  );

  // ── ③④⑤ 本票最要紧的那几条 ──
  const exL1 = await call("GET", `/api/matters/export?keyword=${TAG}`, l1);
  ok(
    "**导出行数 == 同一筛选下列表的 total**（案件 · 在办）",
    exL1.status === 200 && Number(exL1.body?.rows) === totalL1,
    `rows=${exL1.body?.rows} total=${totalL1} status=${exL1.status}`,
  );
  ok(
    "CSV 自洽：BOM 开头、中文表头、数据行 = rows（**不含表头**）",
    typeof exL1.body?.csv === "string" &&
      exL1.body.csv.startsWith("\uFEFF") &&
      csvHeader(exL1.body.csv).startsWith("内部编号,正式案号,案件名称") &&
      csvDataRows(exL1.body.csv).length === Number(exL1.body?.rows),
    `header=${csvHeader(exL1.body?.csv)} 数据行=${csvDataRows(exL1.body?.csv).length}`,
  );
  ok(
    "导出的编号集合逐条对上列表那一屏（不是「看着差不多」）",
    codesL1.length === 3 && codesL1.every((c) => exL1.body.csv.includes(c)),
    `codes=${codesL1.join("|")}`,
  );

  const archList = await call("GET", `/api/matters?keyword=${TAG}&archivedOnly=1`, l1);
  const archExport = await call("GET", `/api/matters/export?keyword=${TAG}&archivedOnly=1`, l1);
  const archCode = (archList.body?.items?.[0]?.internalCode ?? "").toString();
  ok(
    "归档视图：列表 1 条、导出 1 行（漏掉归档二态就会 3 vs 1）",
    Number(archList.body?.total) === 1 &&
      archExport.status === 200 &&
      Number(archExport.body?.rows) === 1,
    `total=${archList.body?.total} rows=${archExport.body?.rows}`,
  );
  ok(
    "在办档里没有丁、归档档里只有丁",
    archCode !== "" && !exL1.body.csv.includes(archCode) && archExport.body.csv.includes(archCode),
    `丁=${archCode}`,
  );

  const subList = await call("GET", `/api/matters?keyword=甲-${TAG}`, l1);
  const subExport = await call("GET", `/api/matters/export?keyword=甲-${TAG}`, l1);
  ok(
    "关键词进导出：更窄的关键词下两边都是 1（不是 3）",
    Number(subList.body?.total) === 1 && Number(subExport.body?.rows) === 1,
    `total=${subList.body?.total} rows=${subExport.body?.rows}`,
  );

  const ascExport = await call(
    "GET",
    `/api/matters/export?keyword=${TAG}&sortBy=code&sortDir=asc`,
    l1,
  );
  const ascRows = csvDataRows(ascExport.body?.csv);
  const minCode = [...codesL1].sort((a, b) => String(a).localeCompare(String(b)))[0];
  ok(
    "排序进导出：`sortBy=code&sortDir=asc` 时首行是最小的编号",
    ascRows.length === 3 && firstCell(ascRows[0]) === minCode,
    `首行=${firstCell(ascRows[0])} 最小=${minCode}`,
  );

  // ── ⑥ 两档的门（AC 第 8 条） ──
  const plainDenied = await call("GET", `/api/matters/export?keyword=${TAG}&plain=1`, l2);
  ok(
    "**无 can_read_plain 调明文导出 ⇒ 403 privilege_required**",
    plainDenied.status === 403 && plainDenied.body?.error === "privilege_required",
    `status=${plainDenied.status} err=${plainDenied.body?.error}`,
  );
  const before = await auditCount(l1acct.id, "matter_list");
  const plainOk = await call("GET", `/api/matters/export?keyword=${TAG}&plain=1`, l1);
  const after = await auditCount(l1acct.id, "matter_list");
  ok(
    "有特权 ⇒ 200、plain=true、行数与脱敏档一致",
    plainOk.status === 200 && plainOk.body?.plain === true && Number(plainOk.body?.rows) === 3,
    `status=${plainOk.status} rows=${plainOk.body?.rows}`,
  );

  // ── ⑦ 整批一条 EXPORT + 载荷形状 + 落点 ──
  const [log] = await lastAudit(l1acct.id, "matter_list");
  ok("**一次导出写一条 EXPORT**（不是逐行）：前后差恰好 1", after - before === 1, `before=${before} after=${after}`);
  ok(
    "载荷五键 `{target_type, scope, rows, count, plain}`，且 rows 与响应一致",
    JSON.stringify(Object.keys(log?.payload ?? {}).sort()) ===
      JSON.stringify(["count", "plain", "rows", "scope", "target_type"]) &&
      log?.payload?.target_type === "matter" &&
      log?.payload?.scope === "matter_list" &&
      Number(log?.payload?.rows) === Number(plainOk.body?.rows) &&
      Number(log?.payload?.count) === Number(plainOk.body?.rows) &&
      log?.payload?.plain === true,
    `payload=${JSON.stringify(log?.payload)}`,
  );
  ok(
    "日志落在**账号维度**（跨宿主的导出挂到某个案件上是说谎）",
    log?.target_type === "app_user" && log?.matter_id === null && log?.risk_matter_id === null,
    `target_type=${log?.target_type} matter_id=${log?.matter_id}`,
  );

  // ── ⑧ 范围谓词（AC 第 5 条） ──
  const listL2 = await call("GET", `/api/matters?keyword=${TAG}`, l2);
  const exL2 = await call("GET", `/api/matters/export?keyword=${TAG}`, l2);
  const codesL2 = (listL2.body?.items ?? []).map((x) => x.internalCode);
  ok(
    "**L2 的导出 == L2 的列表**（范围受限的账号：1 条，不是 3 条）",
    Number(listL2.body?.total) === 1 && Number(exL2.body?.rows) === 1 && codesL2.length === 1,
    `total=${listL2.body?.total} rows=${exL2.body?.rows}`,
  );
  ok(
    "L2 导出的 CSV 里没有别人那几件的编号（导出不许比列表多给）",
    codesL1.filter((c) => c !== codesL2[0]).every((c) => !exL2.body.csv.includes(c)),
    `L2 只该看到 ${codesL2.join("|")}`,
  );
  const archL2 = await call("GET", `/api/matters/export?keyword=${TAG}&archivedOnly=1`, l2);
  ok(
    "归档档对 L2 也是 0（丁不是它的）",
    Number(archL2.body?.rows) === 0 && csvDataRows(archL2.body?.csv).length === 0,
    `rows=${archL2.body?.rows}`,
  );

  // ── ⑨ 事项侧同形 + ownerEmpty（未指派） ──
  const riskList = await call("GET", `/api/risk-matters?keyword=${TAG}`, l1);
  const riskExport = await call("GET", `/api/risk-matters/export?keyword=${TAG}`, l1);
  ok(
    "**导出行数 == 列表 total**（事项 · 默认在办）",
    riskList.status === 200 &&
      Number(riskList.body?.total) === 2 &&
      Number(riskExport.body?.rows) === Number(riskList.body?.total),
    `rows=${riskExport.body?.rows} total=${riskList.body?.total}`,
  );
  const ownerList = await call("GET", `/api/risk-matters?keyword=${TAG}&ownerEmpty=1`, l1);
  const ownerExport = await call("GET", `/api/risk-matters/export?keyword=${TAG}&ownerEmpty=1`, l1);
  const ownerCodes = (ownerList.body?.items ?? []).map((x) => x.code);
  const allRiskCodes = (riskList.body?.items ?? []).map((x) => x.code);
  ok(
    "`ownerEmpty=1`（未指派）也在导出里生效：两边都是 1，且只含那一条",
    Number(ownerList.body?.total) === 1 &&
      Number(ownerExport.body?.rows) === 1 &&
      ownerCodes.length === 1 &&
      ownerExport.body.csv.includes(ownerCodes[0]) &&
      allRiskCodes.filter((c) => c !== ownerCodes[0]).every((c) => !ownerExport.body.csv.includes(c)),
    `total=${ownerList.body?.total} rows=${ownerExport.body?.rows} code=${ownerCodes.join("|")}`,
  );
  const riskPlainDenied = await call("GET", `/api/risk-matters/export?keyword=${TAG}&plain=1`, l2);
  ok(
    "事项侧同样：无特权调明文导出 ⇒ 403",
    riskPlainDenied.status === 403 && riskPlainDenied.body?.error === "privilege_required",
    `status=${riskPlainDenied.status}`,
  );
  const beforeRisk = await auditCount(l1acct.id, "risk_matter_list");
  const riskPlainOk = await call("GET", `/api/risk-matters/export?keyword=${TAG}&plain=1`, l1);
  const afterRisk = await auditCount(l1acct.id, "risk_matter_list");
  const [riskLog] = await lastAudit(l1acct.id, "risk_matter_list");
  ok(
    "事项侧：明文档 200、整批一条 EXPORT、载荷 target_type=risk_matter",
    riskPlainOk.status === 200 &&
      riskPlainOk.body?.plain === true &&
      afterRisk - beforeRisk === 1 &&
      riskLog?.payload?.target_type === "risk_matter" &&
      riskLog?.payload?.scope === "risk_matter_list" &&
      Number(riskLog?.payload?.rows) === Number(riskPlainOk.body?.rows),
    `status=${riskPlainOk.status} payload=${JSON.stringify(riskLog?.payload)}`,
  );

  // ── ⑩ 参数边界 ──
  const badStatus = await call("GET", "/api/matters/export?status=whatever", l1);
  const badSort = await call("GET", "/api/matters/export?sortBy=updated_at%3Bdrop", l1);
  ok(
    "非法 status / sortBy ⇒ 400（白名单不是装饰）",
    badStatus.status === 400 && badSort.status === 400,
    `status=${badStatus.status} sort=${badSort.status}`,
  );
  const customStatus = await call("GET", "/api/risk-matters/export?status=a_custom_status", l1);
  ok(
    "事项状态是配置驱动的：自定义 code 不被 400 拦下（与列表、报表同一个值域）",
    customStatus.status === 200 && Number(customStatus.body?.rows) === 0,
    `status=${customStatus.status} rows=${customStatus.body?.rows}`,
  );
} finally {
  await cleanup();
  const { failed } = await dropSmokeAccountsSafely(sql, [l1acct.id, l2acct.id]);
  // 账号删不掉的两种后果（业务行没清干净 / 库出问题）都由 `_testacct` 记账进退出码
  if (failed.length) console.log(`[clean] ${failed.length} 个临时账号没删掉：${failed[0].reason}`);
  await sql.end();
  console.log(`\n列表导出（MATT-64）：通过 ${pass} 条，失败 ${fail} 条`);
  finishSmoke(fail);
}

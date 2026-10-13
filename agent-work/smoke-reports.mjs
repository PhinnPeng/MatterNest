import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

/**
 * 报表两卡真 HTTP 冒烟（MATT-46 / F8-1 + F8-2）。
 *
 * 票面七条 AC 里有五条只有真跑一遍才验得出来，脚本按这五条组织：
 *
 * ① **两张卡只算可见行**（AC 第 4 条）。三个自建账号对同一份数据读同一张报表：
 *    L1（全局）看到全部、L2（参与经办）只多看到"我是关注人"的那一条、L3（承办经办）
 *    看不到任何别人的行。**L2 看得见、L3 看不见**这条不对称是 `visibility.ts` 明文写的
 *    （L3 刻意不含 `*_staff` 的协办/关注行）——报表必须继承它。报表是最容易把范围谓词
 *    "简化成 `owner_id = 我`"的地方：那样数字只会变大、不会报错，界面上一片正常。
 * ② **临期按节点自己的 `remind_days`**（AC 第 1 条要求先定的口径）。两个期限都是"还剩 5 天"
 *    的节点，提醒档 `{7,3,1}` 的算临期、`{3,1}` 的算更远——把窗口写死成 7 天的实现过不了这条。
 *    顺带钉住**与工作台的边界**：同一个 `{3,1}` 节点，工作台 `/api/overview` 算「7 日内到期」、
 *    报表算「更远」，两条同时成立（§4.7 第 4 条）。
 * ③ **未确认时间的节点不进任何一档**（票面纪律：只走 `is_time_confirmed` 的 partial index 那一路）。
 *    已完成的、时间已确认但没填时间的同样不进。
 * ④ **归档是二态**：归档后默认视图里消失、`archivedOnly=1` 里出现；不混着看。
 * ⑤ **聚合在服务端、前端不拉明细**：响应体里不能出现任何一条案卷名（字符串层面断言）。
 *
 * 另有两条"看起来会过、其实最容易假绿"的：
 *  · `?archivedOnly=yes` 必须 400（`Boolean("false") === true` 那个坑的反面）；
 *  · 事项侧的到期节点必须出现在卡②里——两张同构节点表的 UNION 只走一条就漏一半，
 *    而漏掉的那一半**不会有任何报错**。
 *
 * ⚠ 反向红：`agent-work/revred-reports.mjs` 按本脚本的断言名注入缺陷，先红一次再还原。
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

async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return {
    status: r.status,
    // `getSetCookie()` 在 **headers** 上（Node 20+ 的 undici），不在 Response 上：
    // 写成 `r.getSetCookie?.()` 会静默拿到空 cookie，症状是"登录 200、后面全是 401"
    cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; "),
  };
}

/** 报表读数。`archivedOnly` 走的是与两张列表同一个二态参数 */
const report = (cookie, archivedOnly) =>
  call("GET", `/api/reports${archivedOnly ? "?archivedOnly=1" : ""}`, cookie);

/* 三个取格子的读数器：**格子由服务端摆好**，脚本只按 (状态, 等级, 诉讼地位) 取值，
   不做任何求和——求和正是被验的那件事，脚本自己再算一遍就等于把被测逻辑抄了一遍。 */
const cellM = (b, status, level, role) =>
  (b?.matters?.rows ?? []).find((r) => r.status === status && r.level === level)?.counts?.[role] ?? 0;
const cellR = (b, status, level) =>
  (b?.risks?.rows ?? []).find((r) => r.status === status)?.counts?.[level] ?? 0;
const cellN = (b, kind, bucket) =>
  (b?.nodes?.rows ?? []).find((r) => r.kind === kind)?.counts?.[bucket] ?? 0;

const stamp = Date.now();
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const l1 = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const l2 = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
const l3 = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });

const matterIds = [];
const riskIds = [];
const riskNodeIds = [];

async function cleanup() {
  /**
   * ⚠ 用 `try/catch` 而不是 `.catch(() => {})`：`sql.unsafe()` 对非法入参是**同步抛**的，
   * 同步抛不会被 `.catch` 接住，会一路冒出 `cleanup()` —— 那意味着**后面每条清场语句都不再执行**，
   * 夹具整批留在库里（本轮真发生过一次：隧道抖了一下，三条案件 + 一条事项 + 三个账号全留下，
   * 而屏幕上只有一句"清场完成"）。现在每条都独立成败，失败的原样打出来。
   */
  const failed = [];
  const run = async (q, tag) => {
    try {
      await sql.unsafe(q);
    } catch (e) {
      failed.push(`${tag} —— ${String(e.message).split("\n")[0]}`);
    }
  };

  for (const id of matterIds) {
    await run(`delete from mn_activity_log where matter_id=${id}`, `log ${id}`);
    await run(`delete from mn_matter_staff where matter_id=${id}`, `staff ${id}`);
    await run(`delete from mn_matter_node where matter_id=${id}`, `node ${id}`);
    await run(`delete from mn_matter_party where matter_id=${id}`, `party ${id}`);
    await run(`delete from mn_matter_progress where matter_id=${id}`, `progress ${id}`);
    await run(`delete from mn_risk_matter_case where matter_id=${id}`, `convert-link ${id}`);
    await run(`delete from mn_matter where id=${id}`, `matter ${id}`);
  }
  for (const id of riskNodeIds) {
    await run(`delete from mn_risk_matter_node where id=${id}`, `risk node ${id}`);
  }
  for (const id of riskIds) {
    await run(`delete from mn_activity_log where risk_matter_id=${id}`, `risk log ${id}`);
    await run(`delete from mn_risk_matter_node where risk_matter_id=${id}`, `risk node ${id}`);
    await run(`delete from mn_risk_matter_staff where risk_matter_id=${id}`, `risk staff ${id}`);
    await run(`delete from mn_risk_matter where id=${id}`, `risk matter ${id}`);
  }
  for (const acct of [l1, l2, l3]) {
    await run(`delete from mn_activity_log where operator_id=${acct.id}`, `acct log ${acct.username}`);
    await run(`delete from mn_auth_session where user_id=${acct.id}`, `session ${acct.username}`);
    await run(`delete from mn_app_user_role where user_id=${acct.id}`, `role ${acct.username}`);
    try {
      await dropSmokeAccount(sql, acct.id);
    } catch (e) {
      failed.push(`账号 ${acct.username} —— ${String(e.message).split("\n")[0]}`);
    }
  }
  if (failed.length) console.log(`[clean] ${failed.length} 条清场失败：\n  ${failed.join("\n  ")}`);
}

/**
 * 夹具：给案件造一个**期限精确**的节点。
 *
 * 为什么直接写库：节点时间只能从详情页改，而这里要的是确定的到期档位（还剩 5 天、
 * 提醒档 `{3,1}`），走接口就得再写一遍时间控件那套换算——夹具的精度不该由被测之外的代码决定。
 * 写的是生成列的两个来源（`start_time` / `end_time`），`deadline_time` 由库自己算出来；
 * `days: null` = 时间已确认但两列都空（那正是"算不出还剩几天"的那一类）。
 */
let nodeSeq = 0;
/** `days` 是"从现在起几天"（负 = 已过期）；在 JS 里算成绝对时刻再传，免得在 SQL 里拼字符串 */
const at = (days) => (days === null ? null : new Date(Date.now() + days * 86_400_000));

async function insertMatterNode(matterId, { days, remind, confirmed = true, status = "in_progress" }) {
  const [nt] = await sql`
    select id from mn_node_type_config where host_type = 'matter' order by sort_order limit 1`;
  const id = BigInt(Date.now()) * 1000n + BigInt(100 + nodeSeq++);
  await sql`
    insert into mn_matter_node
      (id, matter_id, node_type_id, name, time_type, start_time, end_time,
       is_time_confirmed, remind_days, status, source_kind, sort_order, created_at, updated_at, is_deleted)
    values
      (${id}, ${matterId}, ${nt.id}, ${`报表冒烟 到期节点 ${stamp}-${nodeSeq}`}, 'point',
       ${at(days)}, null, ${confirmed}, ${remind}::int[], ${status}, 'manual',
       0, now(), now(), false)`;
  return String(id);
}

/** 事项侧无预设节点（IQ-5：事项是台账），所以这一条夹具也只能自己落一行 */
async function insertRiskNode(riskMatterId, { days, remind }) {
  const [nt] = await sql`
    select id from mn_node_type_config where host_type = 'risk_matter' order by sort_order limit 1`;
  const id = BigInt(Date.now()) * 1000n + 900n + BigInt(nodeSeq++);
  await sql`
    insert into mn_risk_matter_node
      (id, risk_matter_id, node_type_id, name, time_type, start_time, end_time,
       is_time_confirmed, remind_days, status, source_kind, sort_order, created_at, updated_at, is_deleted)
    values
      (${id}, ${riskMatterId}, ${nt.id}, ${`报表冒烟 到期事项节点 ${stamp}`}, 'point',
       ${at(days)}, null, true, ${remind}::int[], 'in_progress', 'manual',
       0, now(), now(), false)`;
  riskNodeIds.push(String(id));
  return String(id);
}

try {
  /* ─────────────────────────── 0. 入口与参数 ─────────────────────────── */

  const anon = await call("GET", "/api/reports");
  ok("未登录 → 401（报表不探测任何资源是否存在）", anon.status === 401, `status=${anon.status}`);

  const s1 = await login(l1.username, l1.password);
  const s2 = await login(l2.username, l2.password);
  const s3 = await login(l3.username, l3.password);
  ok(
    "三个夹具账号都能登录（L1 全局 / L2 参与 / L3 承办）",
    s1.status === 200 && s2.status === 200 && s3.status === 200,
    `${s1.status}/${s2.status}/${s3.status}`,
  );
  // 拿不到 cookie 就当场停：后面的每条断言都会变成 401，红成一片反而看不出是哪一步坏的
  if (!s1.cookie || !s2.cookie || !s3.cookie) throw new Error("登录没拿到会话 cookie，后续断言无意义");

  const badParam = await call("GET", "/api/reports?archivedOnly=yes", s1.cookie);
  ok(
    "**`archivedOnly=yes` → 400**（手打的值不静默当成'看在办'）",
    badParam.status === 400,
    `status=${badParam.status}`,
  );
  const falseParam = await report(s1.cookie, false);
  ok(
    "`archivedOnly=false` → 200 且回显 `archivedOnly:false`（`Boolean('false')` 那个坑的反面）",
    falseParam.status === 200 && falseParam.body?.archivedOnly === false,
    `archivedOnly=${falseParam.body?.archivedOnly}`,
  );

  /* ───────────────────────── 1. 案件卡：三个维度 ───────────────────────── */

  const [mInitial] = await sql`
    select code from mn_status_config where host_type = 'matter' and is_initial_status limit 1`;
  const [mArchived] = await sql`
    select code from mn_status_config where host_type = 'matter' and semantics = 'archived' limit 1`;
  ok(
    "拿到案件初始态与归档态 code（配置驱动，不硬编码 pending/archived）",
    !!mInitial?.code && !!mArchived?.code,
    `initial=${mInitial?.code} archived=${mArchived?.code}`,
  );

  const r0 = await report(s1.cookie, false);
  const n0 = await report(s3.cookie, false);
  ok(
    "报表响应结构齐全（案件矩阵 / 事项矩阵 / 节点到期三块 + 口径回显）",
    r0.status === 200 &&
      Array.isArray(r0.body?.matters?.rows) &&
      Array.isArray(r0.body?.risks?.rows) &&
      Array.isArray(r0.body?.nodes?.rows) &&
      r0.body?.archivedOnly === false,
    `status=${r0.status} keys=${Object.keys(r0.body ?? {}).join(",")}`,
  );
  ok(
    "**L3 的报表是空的**（它只看得见自己经办或创建的，此刻一条都没有）",
    n0.status === 200 && n0.body?.matters?.total === 0 && n0.body?.nodes?.total === 0,
    `matters=${n0.body?.matters?.total} nodes=${n0.body?.nodes?.total}`,
  );

  const mkMatter = (cookie, name, level, litigationRole) =>
    call("POST", "/api/matters", cookie, {
      name,
      cause: "建设工程施工合同纠纷",
      caseType: "civil_commercial",
      procedure: "first_instance",
      litigationRole,
      level,
    });

  // L1 建一条"被告 / 高风险"的案件：三个维度各给一个可辨的值
  const a = await mkMatter(s1.cookie, `报表冒烟 案件A ${stamp}`, "high", "defendant");
  ok("建案 A（被告 / 高）→ 201", a.status === 201, `status=${a.status}`);
  matterIds.push(a.body?.id);

  const r1 = await report(s1.cookie, false);
  ok(
    "**案件卡按 (状态, 等级, 诉讼地位) 计数**：新案件落在 (初始态, 高, 被告) 这一格",
    cellM(r1.body, mInitial.code, "high", "defendant") ===
      cellM(r0.body, mInitial.code, "high", "defendant") + 1 &&
      r1.body?.matters?.total === r0.body?.matters?.total + 1,
    `格=${cellM(r1.body, mInitial.code, "high", "defendant")} 总=${r1.body?.matters?.total}`,
  );
  ok(
    "**等级是行键的一部分**：同一状态同一诉讼地位的「中」档没跟着涨",
    cellM(r1.body, mInitial.code, "mid", "defendant") ===
      cellM(r0.body, mInitial.code, "mid", "defendant"),
    `中=${cellM(r1.body, mInitial.code, "mid", "defendant")}`,
  );
  ok(
    "**诉讼地位是列键的一部分**：同一状态同一等级的「原告」列没跟着涨",
    cellM(r1.body, mInitial.code, "high", "plaintiff") ===
      cellM(r0.body, mInitial.code, "high", "plaintiff"),
    `原告=${cellM(r1.body, mInitial.code, "high", "plaintiff")}`,
  );
  ok(
    "列上出现了「被告」，且该列合计 = 该格的计数（列与格子同源）",
    (r1.body?.matters?.roles ?? []).some((c) => c.code === "defendant"),
    `列=${(r1.body?.matters?.roles ?? []).map((c) => c.code).join(",")}`,
  );

  /* ─────────────────── 2. 可见性：L1 全见 / L2 跟名单 / L3 不见 ─────────────────── */

  const r2AfterA = await report(s2.cookie, false);
  const r3AfterA = await report(s3.cookie, false);
  ok(
    "**L2 看不到别人的案件**（参与经办只多看'我参与的行'，此刻还没被加进任何名单）",
    r2AfterA.body?.matters?.total === 0,
    `total=${r2AfterA.body?.matters?.total}`,
  );
  ok(
    "**L3 看不到别人的案件**（L1 刚建的那条不在它的范围里）",
    r3AfterA.body?.matters?.total === 0,
    `total=${r3AfterA.body?.matters?.total}`,
  );

  // L1 把 L2 加成案件 A 的关注人：**L2 那条 `EXISTS (*_staff)` 分支就靠这一步才真的被走到**
  const addFollower = await call("POST", `/api/matters/${a.body.id}/staff`, s1.cookie, {
    userIds: [String(l2.id)],
    staffRole: "follower",
  });
  ok("L1 把 L2 加成案件 A 的关注人 → 200", addFollower.status === 200, `status=${addFollower.status}`);

  const r2AfterFollow = await report(s2.cookie, false);
  const r3AfterFollow = await report(s3.cookie, false);
  ok(
    "**L2 现在看得见这一条**（`participating` 分支生效：我是关注人 ⇒ 我可见）",
    r2AfterFollow.body?.matters?.total === 1 &&
      cellM(r2AfterFollow.body, mInitial.code, "high", "defendant") === 1,
    `total=${r2AfterFollow.body?.matters?.total}`,
  );
  ok(
    "**L3 仍然看不见**（L3 刻意不含 `*_staff` 的协办/关注行——这条不对称是刻意的）",
    r3AfterFollow.body?.matters?.total === 0,
    `total=${r3AfterFollow.body?.matters?.total}`,
  );

  // L3 自己建一条：它应当**只**看得见自己这条
  const r1BeforeB = await report(s1.cookie, false);
  const b = await mkMatter(s3.cookie, `报表冒烟 案件B ${stamp}`, "low", "plaintiff");
  ok("建案 B（L3 自建，原告 / 低）→ 201", b.status === 201, `status=${b.status}`);
  matterIds.push(b.body?.id);

  const r3AfterB = await report(s3.cookie, false);
  const r1AfterB = await report(s1.cookie, false);
  ok(
    "**L3 只看得见自己那条**：总数 1、且落在 (初始态, 低, 原告) 这一格",
    r3AfterB.body?.matters?.total === 1 &&
      cellM(r3AfterB.body, mInitial.code, "low", "plaintiff") === 1,
    `total=${r3AfterB.body?.matters?.total}`,
  );
  ok(
    "L1 看得见 L3 建的那条（全局范围是超集，不是另一套口径）",
    // 比的是**增量**而不是"这一格等于 1"：同一张库上还跑着别的流的冒烟，
    // 它们也会往 (初始态, 低, 原告) 这一格塞行——绝对值断言会被别人的夹具弄红
    cellM(r1AfterB.body, mInitial.code, "low", "plaintiff") ===
      cellM(r1BeforeB.body, mInitial.code, "low", "plaintiff") + 1,
    `格 ${cellM(r1BeforeB.body, mInitial.code, "low", "plaintiff")}→${cellM(r1AfterB.body, mInitial.code, "low", "plaintiff")}`,
  );

  /* ───────────────────────── 3. 事项卡：状态 × 等级 ───────────────────────── */

  const [rInitial] = await sql`
    select code from mn_status_config where host_type = 'risk_matter' and is_initial_status limit 1`;
  const rBefore = await report(s1.cookie, false);
  const risk = await call("POST", "/api/risk-matters", s1.cookie, {
    name: `报表冒烟 事项 ${stamp}`,
    type: "contract",
    level: "mid",
    description: "冒烟：事项卡按 状态 × 等级 计数",
  });
  ok("建事项 → 201", risk.status === 201, `status=${risk.status}`);
  riskIds.push(risk.body?.id);

  const rAfter = await report(s1.cookie, false);
  ok(
    "**事项卡按 (状态, 等级) 计数**：新事项落在 (初始态, 中) 这一格",
    cellR(rAfter.body, rInitial.code, "mid") === cellR(rBefore.body, rInitial.code, "mid") + 1 &&
      rAfter.body?.risks?.total === rBefore.body?.risks?.total + 1,
    `格=${cellR(rAfter.body, rInitial.code, "mid")} 总=${rAfter.body?.risks?.total}`,
  );
  ok(
    "同一状态的「高」档没跟着涨（等级是列键）",
    cellR(rAfter.body, rInitial.code, "high") === cellR(rBefore.body, rInitial.code, "high"),
    `高=${cellR(rAfter.body, rInitial.code, "high")}`,
  );
  ok(
    "**事项卡没有诉讼地位这一维**（事项侧没有那一列，维度到此为止）",
    rAfter.body?.risks?.rows?.every((row) => !("litigationRole" in row) && !("roles" in row)),
    "",
  );

  /* ─────────────────────── 4. 节点到期卡：三档 + 口径 ─────────────────────── */

  const c = await mkMatter(s1.cookie, `报表冒烟 案件C ${stamp}`, "high", "plaintiff");
  ok("建案 C（用于节点夹具）→ 201", c.status === 201, `status=${c.status}`);
  matterIds.push(c.body?.id);

  const detailC = await call("GET", `/api/matters/${c.body.id}`, s1.cookie);
  const presetNodes = detailC.body?.nodes ?? [];
  ok(
    "案件 C 带上了预设节点（P1 预设路径）——它们没有时间，**不该**出现在任何一档里",
    presetNodes.length >= 3,
    `节点=${presetNodes.length}`,
  );

  const s0 = await report(s1.cookie, false);

  // ① 已逾期：期限已过
  await insertMatterNode(c.body.id, { days: -2, remind: "{7,3,1}" });
  const s1n = await report(s1.cookie, false);
  ok(
    "**期限已过 → 已逾期 +1**，另两档不动",
    cellN(s1n.body, "matter", "overdue") === cellN(s0.body, "matter", "overdue") + 1 &&
      cellN(s1n.body, "matter", "soon") === cellN(s0.body, "matter", "soon") &&
      cellN(s1n.body, "matter", "later") === cellN(s0.body, "matter", "later"),
    `overdue=${cellN(s1n.body, "matter", "overdue")}`,
  );

  // ② 临期：还剩 5 天，提醒档 {7,3,1} → 5 < 7 ⇒ 临期
  await insertMatterNode(c.body.id, { days: 5, remind: "{7,3,1}" });
  const s2n = await report(s1.cookie, false);
  ok(
    "**还剩 5 天 + 提醒档 `{7,3,1}` → 临期 +1**",
    cellN(s2n.body, "matter", "soon") === cellN(s1n.body, "matter", "soon") + 1 &&
      cellN(s2n.body, "matter", "later") === cellN(s1n.body, "matter", "later"),
    `soon=${cellN(s2n.body, "matter", "soon")}`,
  );

  // ③ 同一距离、更窄的提醒档 → 不进临期。**这条就是"窗口不是常数"的判据**
  const ovBefore = await call("GET", "/api/overview", s1.cookie);
  await insertMatterNode(c.body.id, { days: 5, remind: "{3,1}" });
  const s3n = await report(s1.cookie, false);
  const ovAfter = await call("GET", "/api/overview", s1.cookie);
  ok(
    "**同样还剩 5 天、但提醒档是 `{3,1}` → 算更远，不算临期**（窗口随节点走，不是硬编码 7 天）",
    cellN(s3n.body, "matter", "later") === cellN(s2n.body, "matter", "later") + 1 &&
      cellN(s3n.body, "matter", "soon") === cellN(s2n.body, "matter", "soon"),
    `later=${cellN(s3n.body, "matter", "later")} soon=${cellN(s3n.body, "matter", "soon")}`,
  );
  ok(
    "**与工作台的边界**：同一个节点，工作台算「7 日内到期」、报表算「更远」（两套口径同时成立）",
    ovAfter.body?.nodes?.within7 === ovBefore.body?.nodes?.within7 + 1 &&
      cellN(s3n.body, "matter", "soon") === cellN(s2n.body, "matter", "soon"),
    `工作台 within7 ${ovBefore.body?.nodes?.within7}→${ovAfter.body?.nodes?.within7}；报表 soon 不动`,
  );

  // ④ 未确认时间：不进任何一档
  await insertMatterNode(c.body.id, { days: 1, remind: "{7,3,1}", confirmed: false });
  const s4n = await report(s1.cookie, false);
  ok(
    "**未确认时间的节点不进任何一档**（只走 `is_time_confirmed` 的 partial index 那一路）",
    cellN(s4n.body, "matter", "overdue") === cellN(s3n.body, "matter", "overdue") &&
      cellN(s4n.body, "matter", "soon") === cellN(s3n.body, "matter", "soon") &&
      cellN(s4n.body, "matter", "later") === cellN(s3n.body, "matter", "later"),
    `overdue/soon/later=${cellN(s4n.body, "matter", "overdue")}/${cellN(s4n.body, "matter", "soon")}/${cellN(s4n.body, "matter", "later")}`,
  );

  // ⑤ 已完成：不再是"到期"
  await insertMatterNode(c.body.id, { days: 1, remind: "{7,3,1}", status: "completed" });
  const s5n = await report(s1.cookie, false);
  ok(
    "**已完成的节点不再算到期**",
    cellN(s5n.body, "matter", "overdue") === cellN(s4n.body, "matter", "overdue") &&
      cellN(s5n.body, "matter", "soon") === cellN(s4n.body, "matter", "soon") &&
      cellN(s5n.body, "matter", "later") === cellN(s4n.body, "matter", "later"),
    `soon=${cellN(s5n.body, "matter", "soon")}`,
  );

  // ⑥ 时间已确认但两列都空：算不出"还剩几天"，不假装它更远
  await insertMatterNode(c.body.id, { days: null, remind: "{7,3,1}" });
  const s6n = await report(s1.cookie, false);
  ok(
    "**时间已确认但没填时间的节点不进任何一档**（算不出还剩几天，归哪一档都是编的）",
    cellN(s6n.body, "matter", "overdue") === cellN(s5n.body, "matter", "overdue") &&
      cellN(s6n.body, "matter", "soon") === cellN(s5n.body, "matter", "soon") &&
      cellN(s6n.body, "matter", "later") === cellN(s5n.body, "matter", "later"),
    `later=${cellN(s6n.body, "matter", "later")}`,
  );

  // ⑦ 跨两张节点表：事项侧的到期节点必须也进卡②
  const riskD = await call("POST", "/api/risk-matters", s1.cookie, {
    name: `报表冒烟 事项D ${stamp}`,
    type: "contract",
    level: "high",
    description: "冒烟：事项侧的到期节点要出现在卡②（UNION 只走一条就漏一半）",
  });
  riskIds.push(riskD.body?.id);
  await insertRiskNode(riskD.body.id, { days: -3, remind: "{7,3,1}" });
  const s7n = await report(s1.cookie, false);
  ok(
    "**事项侧的到期节点也进卡②**（两张同构节点表 UNION，只走一条就漏一半且不报错）",
    cellN(s7n.body, "risk_matter", "overdue") === cellN(s6n.body, "risk_matter", "overdue") + 1 &&
      cellN(s7n.body, "matter", "overdue") === cellN(s6n.body, "matter", "overdue"),
    `事项 overdue=${cellN(s7n.body, "risk_matter", "overdue")}`,
  );
  ok(
    "卡②两行恒在（案件 / 事项），合计 = 两行之和（服务端算好，界面不求和）",
    (s7n.body?.nodes?.rows ?? []).length === 2 &&
      s7n.body?.nodes?.total ===
        (s7n.body?.nodes?.rows ?? []).reduce((acc, r) => acc + r.total, 0) &&
      (s7n.body?.nodes?.buckets ?? []).length === 3,
    `rows=${(s7n.body?.nodes?.rows ?? []).length} total=${s7n.body?.nodes?.total}`,
  );
  ok(
    "**L3 的节点卡仍是空的**（它看不见别人的案卷，也就看不见别人的节点）",
    (await report(s3.cookie, false)).body?.nodes?.total === 0,
    "",
  );

  /* ───────────────────────── 5. 归档：二态，不混着看 ───────────────────────── */

  const archBefore = await report(s1.cookie, false);
  const archViewBefore = await report(s1.cookie, true);
  const archC = await call("POST", `/api/matters/${c.body.id}/status`, s1.cookie, {
    to: mArchived.code,
    reason: "冒烟：把带节点夹具的案件归档",
  });
  ok("归档案件 C → 200", archC.status === 200, `status=${archC.status}`);

  const archAfter = await report(s1.cookie, false);
  const archViewAfter = await report(s1.cookie, true);
  ok(
    "**归档后在办视图里不再有「已归档」状态的行**（二态，不混着看）",
    !(archAfter.body?.matters?.rows ?? []).some((row) => row.status === mArchived.code),
    `在办视图里的状态=${[...new Set((archAfter.body?.matters?.rows ?? []).map((r) => r.status))].join(",")}`,
  );
  /**
   * 计数用"至少 -1 / 至少 +1"而不是"恰好 -1"：同一张库上还跑着别的流的冒烟，
   * 它们随时可能新建案件——恰好断言会被别人的夹具弄红（本轮真被弄红过一次）。
   * 方向 + 幅度 ≥1 照样钉得住这条口径：谓词被摘掉时数字**根本不动**。
   */
  ok(
    "**归档后从默认（在办）视图里消失**：案件总数与三档到期各至少 -1",
    archAfter.body?.matters?.total <= archBefore.body?.matters?.total - 1 &&
      cellN(archAfter.body, "matter", "overdue") <= cellN(archBefore.body, "matter", "overdue") - 1 &&
      cellN(archAfter.body, "matter", "soon") <= cellN(archBefore.body, "matter", "soon") - 1 &&
      cellN(archAfter.body, "matter", "later") <= cellN(archBefore.body, "matter", "later") - 1,
    `total ${archBefore.body?.matters?.total}→${archAfter.body?.matters?.total}`,
  );
  ok(
    "**`archivedOnly=1` 里出现**：案件总数与三档到期各至少 +1（二态互为补集，不混着看）",
    archViewAfter.body?.archivedOnly === true &&
      archViewAfter.body?.matters?.total >= archViewBefore.body?.matters?.total + 1 &&
      cellN(archViewAfter.body, "matter", "overdue") >=
        cellN(archViewBefore.body, "matter", "overdue") + 1 &&
      cellN(archViewAfter.body, "matter", "soon") >= cellN(archViewBefore.body, "matter", "soon") + 1,
    `归档视图 total ${archViewBefore.body?.matters?.total}→${archViewAfter.body?.matters?.total}`,
  );
  ok(
    "归档视图里**只剩**归档行（在办的那几条不在里面）",
    (archViewAfter.body?.matters?.rows ?? []).every((row) => row.status === mArchived.code),
    `状态=${[...new Set((archViewAfter.body?.matters?.rows ?? []).map((r) => r.status))].join(",")}`,
  );

  /* ─────────────────── 6. 聚合在服务端：响应里没有明细 ─────────────────── */

  const raw = JSON.stringify(archAfter.body);
  ok(
    "**响应体里没有任何一条案卷名**（只给格子，不给明细——前端无从'拉明细再本地算'）",
    !raw.includes(`报表冒烟 案件A ${stamp}`) &&
      !raw.includes(`报表冒烟 事项 ${stamp}`) &&
      !raw.includes("报表冒烟 到期事项节点"),
    `长度=${raw.length}`,
  );
  ok(
    "响应里没有 `items` 这类逐行数组（两张卡都只有 rows/counts/total 这类聚合字段）",
    !raw.includes('"items"') && !raw.includes('"deadlineTime"') && !raw.includes('"ownerName"'),
    "",
  );
} catch (e) {
  fail++;
  console.log(`[FAIL] 脚本中断 —— ${e?.stack ?? e}`);
} finally {
  try {
    await cleanup();
    console.log("[clean] 清场完成");
  } catch (e) {
    console.log(`[clean] 清场失败 —— ${e?.message ?? e}`);
  }
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

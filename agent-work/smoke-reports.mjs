import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";

/**
 * 报表两卡真 HTTP 冒烟（MATT-46 / F8-1 + F8-2）。
 *
 * ## 形态：两张卡挂在两个列表页顶部，随筛选联动
 *
 * 2026-10-13 形态改判后（P0-2：不建报表页、不进菜单），本脚本多了两段：
 *   · **筛选联动**：`?status=` / `?ownerEmpty=` / `?archivedOnly=` 三个筛选必须让卡片数字跟着变，
 *     且**只认这三个**（多传一个 400，而不是被静默丢掉——"筛选点了没反应"那类缺陷的形态）；
 *   · **页面形态**：`/matters` 与 `/risk-matters` 的 HTML 里有两张卡的标题、没有「报表」菜单项、
 *     `/reports` 是 404。
 *
 * ## 计数怎么比：同一时刻自算期望值，不做"前后两次读相减"
 *
 * 旧写法（读一次 API → 建一行夹具 → 再读一次 → 相减）在**并发**下约 40% 转红：
 * 同一张库上还跑着别的流的冒烟，它们随时往同一个格子里塞行/删行。
 * 现在改成**期望值与被测读数同时成立**，靠两件事：
 *
 *   1. **私有维度**：夹具的状态与等级都写成本次运行独有的 code（`ST` / `LV`，直接写库）。
 *      于是"我的那些行"落在卡片上一个**只有我**的格子里——别人的行进不来，
 *      期望值就是我自己夹具的账（`expectNodes` / 逐格常数），可以精确比对；
 *      `stepNode` 那种"插入前后各读一次"也因此可靠（那一格只装我的行）。
 *   2. **不变式**：表尾合计、列合计、状态小计这些"服务端算出来的数"必须自洽
 *      （`assertMatrixInvariants` / `assertNodeInvariants`）。它们与并发无关，
 *      任何时刻都成立，所以既能钉住聚合、又永远不会抖。
 *
 * 期望值由**本脚本自己**按 §4.7 的文字口径算（`bucketOf` + 夹具账），不是把服务端的 SQL
 * 抄一遍——抄一遍等于把被测逻辑复制进断言里。
 *
 * ## 七条 AC 里只有真跑一遍才验得出来的那些
 *
 * ① **只算可见行**：三个自建账号对同一份数据读同一张报表。L1（全局）看到全部、L2（参与经办）
 *    只多看到"我是关注人"的那一条、L3（承办经办）看不到任何别人的行。**L2 看得见、L3 看不见**
 *    这条不对称是 `visibility.ts` 明文写的（L3 刻意不含 `*_staff` 的协办/关注行）。
 * ② **临期按节点自己的 `remind_days`**：两个期限都是"还剩 5 天"的节点，提醒档 `{7,3,1}` 的算临期、
 *    `{3,1}` 的算更远；`{}` 空数组回落 7 天（§4.7 第 2 条）。顺带钉住与工作台的边界。
 * ③ **未确认时间的节点不进任何一档**；已完成的、时间已确认但没填时间的同样不进。
 * ④ **归档是二态**：归档后默认视图里消失、`archivedOnly=1` 里出现；不混着看。
 * ⑤ **聚合在服务端、前端不拉明细**：响应体的**键集合**就是白名单（`KEYS`），多一个键就算红。
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

/**
 * 本次运行的**私有维度**。状态与等级都直接写库（不建配置行）：
 * 报表把状态/等级只当 code 用（显示名由 `/api/meta` 出），库里没有的 code 是合法输入。
 * 不往 `mn_status_config` / `mn_risk_level_config` 里插行是刻意的——那是**共享配置表**，
 * 别的冒烟正在读它（`is_initial_status` / `semantics='archived'`），插一行就是一次跨测试副作用。
 */
const stamp = Date.now();
const ST = `smoke_rpt_${stamp}`;
const LV = `smoke_rpt_lv_${stamp}`;

const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

/* ──────────────────────────── 读数器（只取值，不求和） ──────────────────────────── */

/** 报表读数。三个筛选与两张列表同名同义（`status` / `ownerEmpty` / `archivedOnly`） */
function report(cookie, q = {}) {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.ownerEmpty) p.set("ownerEmpty", "1");
  if (q.archivedOnly) p.set("archivedOnly", "1");
  const s = p.toString();
  return call("GET", `/api/reports${s ? `?${s}` : ""}`, cookie);
}
/** 手打查询串（只给"该被拒的参数"那几条断言用） */
const rawReport = (cookie, qs) => call("GET", `/api/reports?${qs}`, cookie);

const rowsM = (b) => b?.matters?.rows ?? [];
const rowsR = (b) => b?.risks?.rows ?? [];
const rowsN = (b) => b?.nodes?.rows ?? [];

const rowM = (b, status, level) => rowsM(b).find((r) => r.status === status && r.level === level);
const rowR = (b, status) => rowsR(b).find((r) => r.status === status);
const rowN = (b, kind) => rowsN(b).find((r) => r.kind === kind);
const cellM = (b, status, level, role) => rowM(b, status, level)?.counts?.[role] ?? 0;
const cellR = (b, status, level) => rowR(b, status)?.counts?.[level] ?? 0;
const cellN = (b, kind, bucket) => rowN(b, kind)?.counts?.[bucket] ?? 0;

/* ───────────────────── 结构白名单：响应体的键集合 == 白名单 ───────────────────── */

/**
 * 键集合断言（取代"没有 items 这类逐行数组"那种查三个字面量的写法）。
 *
 * 后者的问题不是太弱，而是**假**：它只证明"这三个词没出现"，而"响应里出现了别的逐行字段"
 * 照样绿。键集合是**穷尽**的：服务端多给一个字段（哪怕是 `deadlineTime`、`ownerName`，
 * 或者日后顺手带上的 `items`）当场红。
 */
const KEYS = {
  payload: ["archivedOnly", "matters", "nodes", "risks"],
  matters: ["roles", "rows", "total"],
  risks: ["levels", "rows", "total"],
  matterRow: ["counts", "level", "status", "statusTotal", "total"],
  riskRow: ["counts", "status", "total"],
  matrixColumn: ["code", "total"],
  nodes: ["bucketTotals", "buckets", "rows", "total"],
  nodeRow: ["counts", "kind", "total"],
  bucket: ["key", "label"],
};

const keySet = (o) => Object.keys(o ?? {}).sort().join(",");
const keysAre = (o, allowed) => keySet(o) === [...allowed].sort().join(",");

function assertShape(tag, b) {
  ok(`${tag} 顶层键集合 == 白名单（多一个字段就算红）`, keysAre(b, KEYS.payload), `keys=${keySet(b)}`);
  ok(`${tag} 案件矩阵键集合 == 白名单`, keysAre(b?.matters, KEYS.matters), `keys=${keySet(b?.matters)}`);
  ok(`${tag} 事项矩阵键集合 == 白名单`, keysAre(b?.risks, KEYS.risks), `keys=${keySet(b?.risks)}`);
  ok(`${tag} 节点卡键集合 == 白名单`, keysAre(b?.nodes, KEYS.nodes), `keys=${keySet(b?.nodes)}`);
  ok(
    `${tag} 案件行键集合 == 白名单（状态/等级/小计/合计/各格）`,
    rowsM(b).every((r) => keysAre(r, KEYS.matterRow)),
    `第一行 keys=${keySet(rowsM(b)[0])}`,
  );
  ok(
    `${tag} 事项行键集合 == 白名单（**没有**诉讼地位这一维）`,
    rowsR(b).every((r) => keysAre(r, KEYS.riskRow)),
    `第一行 keys=${keySet(rowsR(b)[0])}`,
  );
  ok(
    `${tag} 事项卡**顶层**没有 roles / litigationRole（诉讼地位是案件侧的维度）`,
    !("roles" in (b?.risks ?? {})) && !("litigationRole" in (b?.risks ?? {})),
    `顶层 keys=${keySet(b?.risks)}`,
  );
  ok(
    `${tag} 节点行键集合 == 白名单`,
    rowsN(b).every((r) => keysAre(r, KEYS.nodeRow)),
    `第一行 keys=${keySet(rowsN(b)[0])}`,
  );
  ok(
    `${tag} 列/档位的键集合 == 白名单（code+total / key+label）`,
    (b?.matters?.roles ?? []).every((c) => keysAre(c, KEYS.matrixColumn)) &&
      (b?.risks?.levels ?? []).every((c) => keysAre(c, KEYS.matrixColumn)) &&
      (b?.nodes?.buckets ?? []).every((x) => keysAre(x, KEYS.bucket)),
    `roles=${keySet(b?.matters?.roles?.[0])} buckets=${keySet(b?.nodes?.buckets?.[0])}`,
  );
}

/* ────────────────── 不变式：服务端算出来的合计必须自洽（并发无关） ────────────────── */

const sumCells = (r) => Object.values(r?.counts ?? {}).reduce((a, n) => a + n, 0);
const sumOf = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

function assertMatrixInvariants(tag, b) {
  const m = b?.matters ?? {};
  const r = rowsM(b);
  ok(
    `${tag} 案件：行合计 == 该行各格之和`,
    r.every((x) => x.total === sumCells(x)),
    `第一行 ${r[0]?.total} vs ${sumCells(r[0])}`,
  );
  ok(
    `${tag} 案件：总数 == 各行合计之和`,
    m.total === sumOf(r, (x) => x.total),
    `${m.total} vs ${sumOf(r, (x) => x.total)}`,
  );
  ok(
    `${tag} 案件：**列合计 == 该列各格之和**（列与格子同源，不是各算一遍）`,
    (m.roles ?? []).every((c) => c.total === sumOf(r, (x) => x.counts?.[c.code] ?? 0)),
    (m.roles ?? []).map((c) => `${c.code}:${c.total}`).join(","),
  );
  ok(
    `${tag} 案件：列合计之和 == 总数`,
    sumOf(m.roles ?? [], (c) => c.total) === m.total,
    `${sumOf(m.roles ?? [], (c) => c.total)} vs ${m.total}`,
  );
  const byStatus = new Map();
  for (const x of r) byStatus.set(x.status, (byStatus.get(x.status) ?? 0) + x.total);
  ok(
    `${tag} 案件：状态小计 == 该状态各行合计之和（界面用它画合并单元格）`,
    r.every((x) => x.statusTotal === byStatus.get(x.status)),
    `第一行 statusTotal=${r[0]?.statusTotal} vs ${byStatus.get(r[0]?.status)}`,
  );

  const k = b?.risks ?? {};
  const rr = rowsR(b);
  ok(
    `${tag} 事项：行合计 == 该行各格之和`,
    rr.every((x) => x.total === sumCells(x)),
    `第一行 ${rr[0]?.total} vs ${sumCells(rr[0])}`,
  );
  ok(
    `${tag} 事项：总数 == 各行合计之和`,
    k.total === sumOf(rr, (x) => x.total),
    `${k.total} vs ${sumOf(rr, (x) => x.total)}`,
  );
  ok(
    `${tag} 事项：**等级列合计 == 该列各格之和**`,
    (k.levels ?? []).every((c) => c.total === sumOf(rr, (x) => x.counts?.[c.code] ?? 0)),
    (k.levels ?? []).map((c) => `${c.code}:${c.total}`).join(","),
  );
  ok(
    `${tag} 事项：列合计之和 == 总数`,
    sumOf(k.levels ?? [], (c) => c.total) === k.total,
    `${sumOf(k.levels ?? [], (c) => c.total)} vs ${k.total}`,
  );
}

function assertNodeInvariants(tag, b) {
  const n = b?.nodes ?? {};
  const r = rowsN(b);
  const buckets = (n.buckets ?? []).map((x) => x.key);
  ok(
    `${tag} 节点卡两行恒在（案件 / 事项），三档恒在`,
    r.length === 2 && buckets.length === 3,
    `rows=${r.length} buckets=${buckets.join(",")}`,
  );
  ok(
    `${tag} 节点：行合计 == 该行各档之和`,
    r.every((x) => x.total === sumCells(x)),
    `第一行 ${r[0]?.total} vs ${sumCells(r[0])}`,
  );
  ok(
    `${tag} 节点：**每档合计（表尾那一行）== 该档两行之和**——表尾也是服务端算的`,
    buckets.every((k) => (n.bucketTotals?.[k] ?? 0) === sumOf(r, (x) => x.counts?.[k] ?? 0)),
    buckets.map((k) => `${k}:${n.bucketTotals?.[k] ?? 0}`).join(","),
  );
  ok(
    `${tag} 节点：总数 == 各行合计之和 == 各档合计之和`,
    n.total === sumOf(r, (x) => x.total) &&
      n.total === sumOf(buckets, (k) => n.bucketTotals?.[k] ?? 0),
    `${n.total} vs ${sumOf(r, (x) => x.total)} / ${sumOf(buckets, (k) => n.bucketTotals?.[k] ?? 0)}`,
  );
  ok(
    `${tag} 节点：档位键集合 == 服务端下发的三档（键与中文名都随响应给）`,
    buckets.join(",") === "overdue,soon,later",
    buckets.join(","),
  );
}

/* ──────────────────────────────── 夹具 ──────────────────────────────── */

const matterIds = [];
const riskIds = [];
const riskNodeIds = [];
const accounts = [];

async function cleanup() {
  /**
   * ⚠ 用 `try/catch` 而不是 `.catch(() => {})`：`sql.unsafe()` 对非法入参是**同步抛**的，
   * 同步抛不会被 `.catch` 接住，会一路冒出 `cleanup()` —— 那意味着**后面每条清场语句都不再执行**，
   * 夹具整批留在库里（本轮真发生过一次：隧道抖了一下，三条案件 + 一条事项 + 三个账号全留下，
   * 而屏幕上只有一句"清场完成"）。现在每条都独立成败，失败的原样打出来。
   */
  const run = async (q, tag) => {
    try {
      await sql.unsafe(q);
    } catch (e) {
      // 记进清场账本 ⇒ finishSmoke 决定退出码。静默 collect 过去只留一句滚动日志，
      // 而"夹具没删干净"的症状出现在**下一轮**别的脚本上。
      noteCleanupFailure(`夹具行 ${tag}`, e);
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
  for (const acct of accounts) {
    await run(`delete from mn_activity_log where operator_id=${acct.id}`, `acct log ${acct.username}`);
    await run(`delete from mn_auth_session where user_id=${acct.id}`, `session ${acct.username}`);
    await run(`delete from mn_app_user_role where user_id=${acct.id}`, `role ${acct.username}`);
    try {
      await dropSmokeAccount(sql, acct.id);
    } catch (e) {
      noteCleanupFailure(`临时账号 ${acct.username}（${acct.id}）`, e);
    }
  }
}

/**
 * 建案夹具 —— **非 201 时直接抛出，并把响应体带出来**。
 *
 * ⚠ 这个护栏是后加的，起因是一次真实的"真信息被淹没"：原先调用点写的是
 *
 *     const a = await mkMatter(...);
 *     ok("建案 A → 201", a.status === 201, `status=${a.status}`);
 *     matterIds.push(a.body?.id);      // ← 非 201 时这里是 undefined
 *     ...
 *     await tagMatter(a.body.id);      // ← 下一行抛 postgres UNDEFINED_VALUE
 *
 * 于是脚本以"脚本中断 —— UNDEFINED_VALUE: Undefined values are not allowed"收场，
 * 而**"服务端 500（响应体 0 字节）"这个真信息被完全淹没** —— 排查时会去查 ORM 用法，
 * 而真正的原因在服务端。检查子代理本轮实测撞到 3 次（建案 A / C / B 各一次）。
 *
 * 现在失败信息里直接带 `status` 与响应体，一眼能看出是"建案没成"而不是"脚本写错了"。
 */
const mkMatter = async (cookie, name, level, litigationRole) => {
  const res = await call("POST", "/api/matters", cookie, {
    name,
    cause: "建设工程施工合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    litigationRole,
    level,
  });
  if (res.status !== 201) {
    throw new Error(
      `建案失败（${name}）：HTTP ${res.status} —— 响应体 ${JSON.stringify(res.body).slice(0, 300)}\n` +
        `（这一句比 ORM 的 UNDEFINED_VALUE 有用：它说明问题在服务端，不在脚本的取值方式）`,
    );
  }
  return res;
};

/**
 * 把夹具行标成**本次运行私有**的状态/等级（直接写库）。
 *
 * 走库不走接口：状态流转会带护栏与原因校验，而这里要的只是"这些行落在只有我用的维度上"。
 * 与节点夹具同一个理由——**夹具的精度不该由被测之外的代码决定**。
 */
const tagMatter = (id, status = ST, level = LV) =>
  sql`update mn_matter set status = ${status}, level = ${level} where id = ${id}`;
const tagRisk = (id, status = ST, level = LV) =>
  sql`update mn_risk_matter set status = ${status}, level = ${level} where id = ${id}`;

/**
 * 期望档位——**本脚本自己按 §4.7 的文字口径算的第二份实现**。
 *
 * 不进任何档的三种：未确认时间、非未决状态（已完成/已取消）、算不出"还剩几天"（两列都空）。
 * 空 `remind_days` 回落 **7 天**（§4.7 第 2 条明文口径）。
 */
function bucketOf({ days, remind, confirmed = true, status = "in_progress" }) {
  if (!confirmed) return null;
  if (status !== "not_started" && status !== "in_progress") return null;
  if (days === null) return null;
  if (days < 0) return "overdue";
  return days < windowOf({ remind }) ? "soon" : "later";
}

/**
 * 节点夹具账。每条记下"它应该落在哪一档、属于哪一组宿主"，期望值就是这本账的和
 * ——不读第二遍 API，也不把服务端的 SQL 抄一遍。
 *
 * `host` 三组对应三种筛选下的可见集合：`live`（在办、有负责人）、`unassigned`（在办、未指派）、
 * `archived`（已归档）。宿主归档时这本账**跟着改**（见下面 `eNode.host = "archived"`），
 * 所以它始终是"当前该看见的那些"。
 */
const nodeFixtures = [];
const arr = (a) => `{${a.join(",")}}`;
/** `days` 是"从现在起几天"（负 = 已过期）；在 JS 里算成绝对时刻再传，免得在 SQL 里拼字符串 */
const at = (days) => (days === null ? null : new Date(Date.now() + days * 86_400_000));

let nodeSeq = 0;
async function insertMatterNode(matterId, fx) {
  const { days, remind, confirmed = true, status = "in_progress", host = "live" } = fx;
  const [nt] = await sql`
    select id from mn_node_type_config where host_type = 'matter' order by sort_order limit 1`;
  const id = BigInt(Date.now()) * 1000n + BigInt(100 + nodeSeq++);
  await sql`
    insert into mn_matter_node
      (id, matter_id, node_type_id, name, time_type, start_time, end_time,
       is_time_confirmed, remind_days, status, source_kind, sort_order, created_at, updated_at, is_deleted)
    values
      (${id}, ${matterId}, ${nt.id}, ${`报表冒烟 到期节点 ${stamp}-${nodeSeq}`}, 'point',
       ${at(days)}, null, ${confirmed}, ${arr(remind)}::int[], ${status}, 'manual',
       0, now(), now(), false)`;
  const entry = { kind: "matter", host, bucket: bucketOf(fx), days, remind };
  nodeFixtures.push(entry);
  return entry;
}

/** 事项侧无预设节点（IQ-5：事项是台账），所以这一条夹具也只能自己落一行 */
async function insertRiskNode(riskMatterId, fx) {
  const { days, remind, host = "unassigned" } = fx;
  const [nt] = await sql`
    select id from mn_node_type_config where host_type = 'risk_matter' order by sort_order limit 1`;
  const id = BigInt(Date.now()) * 1000n + BigInt(900 + nodeSeq++);
  await sql`
    insert into mn_risk_matter_node
      (id, risk_matter_id, node_type_id, name, time_type, start_time, end_time,
       is_time_confirmed, remind_days, status, source_kind, sort_order, created_at, updated_at, is_deleted)
    values
      (${id}, ${riskMatterId}, ${nt.id}, ${`报表冒烟 到期事项节点 ${stamp}`}, 'point',
       ${at(days)}, null, true, ${arr(remind)}::int[], 'in_progress', 'manual',
       0, now(), now(), false)`;
  const entry = { kind: "risk_matter", host, bucket: bucketOf(fx), days, remind };
  nodeFixtures.push(entry);
  riskNodeIds.push(String(id));
  return entry;
}

/** 夹具账 → 期望的三档计数（`hosts` 是"这次筛选下可见的那几组"） */
function expectNodes(kind, hosts) {
  const out = { overdue: 0, soon: 0, later: 0 };
  for (const f of nodeFixtures) {
    if (f.kind !== kind || !f.bucket || !hosts.includes(f.host)) continue;
    out[f.bucket]++;
  }
  return out;
}

/**
 * **夹具必须离分档边界留出余量**（2026-10-15，MATT-84）。
 *
 * ## 为什么这条断言存在
 *
 * 夹具算 deadline 用**应用时钟**（`at(days)` = `new Date(Date.now() + days*86400000)`），
 * 而服务端分档用**库时钟**（`reports.ts:194` 的 `now()`）。两个时钟有稳定偏差 ——
 * 实测 **683ms**（应用快于库）。
 *
 * 测法（不依赖任何工装，可随时复现）：连续 5 次
 * `select (extract(epoch from now()) * 1000)::bigint`，每次取应用侧往返的中点
 * 与库值之差。实测 5 次落在 **653–683ms**，即偏差稳定存在、不是偶发抖动。
 * 出处：MATT-84 的调查（同一台机器、同一个 dev 库）。
 *
 * 于是 `days` 恰好等于阈值（`max(remind)` 或默认 7）的那条夹具，
 * 它的期望档位就取决于**两个时钟的亚秒级一致**：
 *
 *   · 单独跑 ⇒ 110 通过 / 0 失败
 *   · 全组跑 ⇒ 109 通过 / 1 失败，且**两次失败的不是同一条断言**（抖动签名）
 *
 * 那种「失败断言会漂」的形态比稳定失败更贵 —— 读报错的人会以为发现了新缺陷。
 * 而且它会让 CI 不可信：会随机红的门禁很快被当成噪音，然后真红也被忽略。
 *
 * ## 判据是「离边界多远」而不是「落在哪一档」
 *
 * 这条断言不重算服务端的 SQL（那是 tautological），它只问一件事：
 * **这条夹具的 `days` 与它自己的阈值之间，有没有留出足够余量**。
 *
 * 余量取 `MIN_MARGIN_HOURS`（1 小时）：实测时钟偏差 683ms，1 小时是它的
 * 5,270 倍 —— 即使换一台时钟同步更差的机器（NTP 步进、虚拟机漂移）也仍然安全。
 * 取「一天」会过严：为了让「回落值」那条夹具保持判别力，它需要用
 * **非整数天**（见下面那处的注释），而半天余量已经远超所需。
 *
 * 逾期档（`days < 0`）不参与：它没有阈值，不存在贴边问题。
 *
 * ## canary：夹具账为空时不许假绿
 *
 * 本仓对「校验器什么都没扫到 ⇒ 看起来全绿」有真实戒心
 * （`smoke-hygiene.mjs` 的「扫到 0 处」、`enum-check` 的五道「扫描器不是空转」）。
 * 这条断言同样需要它：`nodeFixtures` 空、或每条都被 `!f.bucket` 跳掉时，
 * `tooClose` 也是空的 —— 那时它会打印「0 条夹具全部有余量」并**绿**，
 * 而真相是**一条都没验**。所以下面同时断言「真的检查过若干条」。
 *
 * ## 调用点在**最后一条夹具之后**
 *
 * 它读的是 `nodeFixtures` 这本账，所以必须在账登记完毕之后跑 ——
 * 放早了会漏掉之后新增的进档夹具。
 *
 * ⚠ 初版放在节点段开头（计数断言之前），理由是「贴边的红该出现在被它带偏的那些红
 * 之前」。那个理由本身成立，但**代价是覆盖不全**：当时它漏掉了归档段的 `b` 事项节点
 * 与 `eNode` 两条。**静默漏检比报错顺序更贵** —— 这条断言的全部价值就是不让贴边的
 * 夹具溜过去，所以取了覆盖完整。
 */
const MIN_MARGIN_HOURS = 1;
/**
 * canary 的下限：**进档**夹具的条数（逾期档与不进档的不算）。
 * 本文件当前是 6 条；取 4 是留出余量 —— 它要防的是「整个夹具账空掉、
 * 或被 `!f.bucket` 全部跳掉」那种假绿，不是防「少了一条夹具」。
 */
const MIN_FIXTURES_CHECKED = 4;

/**
 * 一条夹具的**分档窗口**：它自己的提醒档里最大的那个，空数组回落 7 天。
 *
 * 抽出来是因为 `bucketOf` 与服务端各有一份同样的口径 —— 两处各写一遍的话，
 * 改一处忘另一处时**不会报错**，只会让期望与实现对不上（而这条断言正是
 * 为了发现那种不一致而存在的，它自己不能先漂）。
 */
function windowOf(fx) {
  return fx.remind.length ? Math.max(...fx.remind) : 7;
}

function assertFixtureMargin() {
  const tooClose = [];
  let checked = 0;
  for (const f of nodeFixtures) {
    if (!f.bucket || f.bucket === "overdue") continue;
    checked++;
    const win = windowOf(f);
    const marginHours = Math.abs(f.days - win) * 24;
    if (marginHours < MIN_MARGIN_HOURS) {
      tooClose.push(
        `days=${f.days} / 阈值=${win}（余量 ${marginHours.toFixed(1)} 小时 < ${MIN_MARGIN_HOURS}）`,
      );
    }
  }
  ok(
    `**进档夹具的 \`days\` 离阈值至少 ${MIN_MARGIN_HOURS} 小时**（否则期望档位取决于应用时钟与库时钟的亚秒级一致）`,
    tooClose.length === 0 && checked >= MIN_FIXTURES_CHECKED,
    tooClose.length
      ? tooClose.join(" · ")
      : `检查了 ${checked} 条（下限 ${MIN_FIXTURES_CHECKED}）· 全部有余量`,
  );
}

const totalOf = (t) => t.overdue + t.soon + t.later;
const expLiveM = () => expectNodes("matter", ["live"]);
const expLiveR = () => expectNodes("risk_matter", ["unassigned"]);

const bucketsOf = (b, kind) => ({
  overdue: cellN(b, kind, "overdue"),
  soon: cellN(b, kind, "soon"),
  later: cellN(b, kind, "later"),
});

/**
 * 一条夹具一格：插入前后各读一次卡片，**差值必须恰好落在期望的那一档上**（`null` = 一格都不动）。
 *
 * 为什么这里的"前后相减"不会抖：`?status=ST` 是本次运行独有的状态，那一格**只装本脚本的行**
 * ——别的冒烟进不来。旧写法之所以并发下约 40% 转红，是因为它在**共享格子**上相减。
 * 另一侧（另一张节点表）也必须不动：UNION 少写一条分支时，红的会是这里。
 */
async function stepNode(cookie, label, kind, insert, expectBucket = null) {
  const before = await report(cookie, { status: ST });
  await insert();
  const after = await report(cookie, { status: ST });
  const other = kind === "matter" ? "risk_matter" : "matter";
  const b4 = bucketsOf(before.body, kind);
  const af = bucketsOf(after.body, kind);
  const moved = ["overdue", "soon", "later"].filter((k) => af[k] !== b4[k]);
  const otherStill =
    JSON.stringify(bucketsOf(before.body, other)) === JSON.stringify(bucketsOf(after.body, other));
  const want = expectBucket === null ? "一格不动" : `${expectBucket} +1`;
  ok(
    label,
    otherStill &&
      (expectBucket === null
        ? moved.length === 0
        : moved.length === 1 &&
          moved[0] === expectBucket &&
          af[expectBucket] === b4[expectBucket] + 1),
    `${JSON.stringify(b4)} → ${JSON.stringify(af)}（期望 ${want}；另一张表${otherStill ? "不动" : "**动了**"}）`,
  );
}

try {
  /* ─────────────────────────── 0. 入口与参数 ─────────────────────────── */

  const anon = await call("GET", "/api/reports");
  ok("未登录 → 401（报表不探测任何资源是否存在）", anon.status === 401, `status=${anon.status}`);

  const l1 = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
  const l2 = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
  const l3 = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
  accounts.push(l1, l2, l3);

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

  const badParam = await rawReport(s1.cookie, "archivedOnly=yes");
  ok(
    "**`archivedOnly=yes` → 400**（手打的值不静默当成'看在办'）",
    badParam.status === 400,
    `status=${badParam.status}`,
  );
  const falseParam = await rawReport(s1.cookie, "archivedOnly=false");
  ok(
    "`archivedOnly=false` → 200 且回显 `archivedOnly:false`（`Boolean('false')` 那个坑的反面）",
    falseParam.status === 200 && falseParam.body?.archivedOnly === false,
    `archivedOnly=${falseParam.body?.archivedOnly}`,
  );

  /* 报表**只认三个筛选**：多传一个 400，而不是被 zod 静默剥掉（那正是"筛选点了没反应"的形态） */
  for (const qs of ["keyword=x", "page=1", "pageSize=20", "sortBy=name", "missingMaterials=1"]) {
    const r = await rawReport(s1.cookie, qs);
    ok(
      `**\`${qs}\` → 400**（报表不吃关键词/分页/排序/缺材料：多传一个要被拒，不许静默丢掉）`,
      r.status === 400,
      `status=${r.status}`,
    );
  }
  const unknownCode = await report(s1.cookie, { status: "no_such_status_code" });
  ok(
    "库里没有的状态 code → 200 且三块都是空读数（`= code` 的谓词，不是 400）",
    unknownCode.status === 200 &&
      unknownCode.body?.matters?.total === 0 &&
      unknownCode.body?.risks?.total === 0 &&
      unknownCode.body?.nodes?.total === 0,
    `status=${unknownCode.status} totals=${unknownCode.body?.matters?.total}/${unknownCode.body?.risks?.total}/${unknownCode.body?.nodes?.total}`,
  );

  const r0 = await report(s1.cookie);
  const n0 = await report(s3.cookie);
  ok(
    "报表响应结构齐全（案件矩阵 / 事项矩阵 / 节点到期三块 + 口径回显）",
    r0.status === 200 &&
      Array.isArray(r0.body?.matters?.rows) &&
      Array.isArray(r0.body?.risks?.rows) &&
      Array.isArray(r0.body?.nodes?.rows) &&
      r0.body?.archivedOnly === false,
    `status=${r0.status} keys=${Object.keys(r0.body ?? {}).join(",")}`,
  );
  assertShape("默认视图", r0.body);
  assertMatrixInvariants("默认视图", r0.body);
  assertNodeInvariants("默认视图", r0.body);
  ok(
    "**L3 的报表是空的**（它只看得见自己经办或创建的，此刻一条都没有）",
    n0.status === 200 && n0.body?.matters?.total === 0 && n0.body?.nodes?.total === 0,
    `matters=${n0.body?.matters?.total} nodes=${n0.body?.nodes?.total}`,
  );

  /* ─────────────────── 1. 夹具：三个案件 + 两个事项（都打上私有维度） ─────────────────── */

  const [mInitial] = await sql`
    select code from mn_status_config where host_type = 'matter' and is_initial_status limit 1`;
  const [mArchived] = await sql`
    select code from mn_status_config where host_type = 'matter' and semantics = 'archived' limit 1`;
  ok(
    "拿到案件初始态与归档态 code（配置驱动，不硬编码 pending/archived）",
    !!mInitial?.code && !!mArchived?.code,
    `initial=${mInitial?.code} archived=${mArchived?.code}`,
  );

  // A：被告 / 高（L1 建）
  const a = await mkMatter(s1.cookie, `报表冒烟 案件A ${stamp}`, "high", "defendant");
  ok("建案 A（被告 / 高）→ 201", a.status === 201, `status=${a.status}`);
  matterIds.push(a.body?.id);
  await tagMatter(a.body.id);

  // B：原告 / 低（L3 自建 —— 它应当只看得见自己这条）
  const b = await mkMatter(s3.cookie, `报表冒烟 案件B ${stamp}`, "low", "plaintiff");
  ok("建案 B（L3 自建，原告 / 低）→ 201", b.status === 201, `status=${b.status}`);
  matterIds.push(b.body?.id);
  await tagMatter(b.body.id);

  // C：原告 / 高（L1 建，承载全部案件节点夹具）
  const c = await mkMatter(s1.cookie, `报表冒烟 案件C ${stamp}`, "high", "plaintiff");
  ok("建案 C（承载节点夹具）→ 201", c.status === 201, `status=${c.status}`);
  matterIds.push(c.body?.id);
  await tagMatter(c.body.id);

  // D1：未指派的事项（不带 ownerId 建 → owner_id IS NULL）；D2：有负责人的事项
  const d1 = await call("POST", "/api/risk-matters", s1.cookie, {
    name: `报表冒烟 事项D1 ${stamp}`,
    type: "contract",
    level: "mid",
    description: "冒烟：未指派的事项（ownerEmpty 筛选的隔离夹具）",
  });
  ok("建事项 D1（不带 ownerId → 未指派）→ 201", d1.status === 201, `status=${d1.status}`);
  riskIds.push(d1.body?.id);
  await tagRisk(d1.body.id);

  const d2 = await call("POST", "/api/risk-matters", s1.cookie, {
    name: `报表冒烟 事项D2 ${stamp}`,
    type: "contract",
    level: "high",
    // ⚠ 必须显式给 ownerId：不带就是 `owner_id IS NULL`（事项侧经办人可空，IQ-5），
    // 那样 D2 也会落进「未指派」——第一版就漏了这一条，于是 ownerEmpty 的断言红在夹具上
    ownerId: String(l1.id),
    description: "冒烟：有负责人的事项（与 D1 配对，验 ownerEmpty 只留未指派那条）",
  });
  ok("建事项 D2（有负责人）→ 201", d2.status === 201, `status=${d2.status}`);
  riskIds.push(d2.body?.id);
  await tagRisk(d2.body.id);

  const [d1Owner] = await sql`select owner_id from mn_risk_matter where id = ${d1.body.id}`;
  const [d2Owner] = await sql`select owner_id from mn_risk_matter where id = ${d2.body.id}`;
  ok(
    "D1 的 `owner_id` 是 NULL、D2 的不是（「未指派」判的是 `IS NULL`，不是空串）",
    d1Owner?.owner_id === null && d2Owner?.owner_id !== null,
    `D1=${d1Owner?.owner_id} D2=${d2Owner?.owner_id}`,
  );

  /* ───────────── 2. 案件卡：格子只装我的行（私有状态 × 私有等级） ───────────── */

  const rMine = await report(s1.cookie, { status: ST });
  ok(
    "**`status=` 让卡片只算那些行**：案件卡只剩我这一行，格子逐格等于夹具账",
    rMine.status === 200 &&
      rowsM(rMine.body).length === 1 &&
      cellM(rMine.body, ST, LV, "defendant") === 1 &&
      cellM(rMine.body, ST, LV, "plaintiff") === 2 &&
      rMine.body?.matters?.total === 3,
    `rows=${rowsM(rMine.body).length} 被告=${cellM(rMine.body, ST, LV, "defendant")} 原告=${cellM(rMine.body, ST, LV, "plaintiff")} total=${rMine.body?.matters?.total}`,
  );
  ok(
    "**等级是行键的一部分**：我的三行全落在私有等级上，状态小计 = 三行之和",
    rowsM(rMine.body).every((r) => r.level === LV) &&
      rowM(rMine.body, ST, LV)?.statusTotal === 3 &&
      rowM(rMine.body, ST, LV)?.total === 3,
    `行=${rowsM(rMine.body).map((r) => `${r.level}:${r.total}`).join(",")}`,
  );
  ok(
    "**诉讼地位是列键的一部分**：被告/原告两列各是各的计数（不是一行合计抄两遍）",
    cellM(rMine.body, ST, LV, "defendant") === 1 && cellM(rMine.body, ST, LV, "plaintiff") === 2,
    `被告=${cellM(rMine.body, ST, LV, "defendant")} 原告=${cellM(rMine.body, ST, LV, "plaintiff")}`,
  );
  ok(
    "列上出现了「被告」与「原告」，且**列合计 == 该列各格之和**",
    ["defendant", "plaintiff"].every((code) =>
      (rMine.body?.matters?.roles ?? []).some((c) => c.code === code),
    ) &&
      (rMine.body?.matters?.roles ?? []).every(
        (c) => c.total === sumOf(rowsM(rMine.body), (r) => r.counts?.[c.code] ?? 0),
      ),
    `列=${(rMine.body?.matters?.roles ?? []).map((c) => `${c.code}:${c.total}`).join(",")}`,
  );
  ok(
    "**带筛选时只出这个筛选下的状态行**（不是把别的状态也画上、只是数字为 0）",
    rowsM(rMine.body).every((r) => r.status === ST) &&
      rowsR(rMine.body).every((r) => r.status === ST),
    `案件行状态=${[...new Set(rowsM(rMine.body).map((r) => r.status))].join(",")}`,
  );
  const rInitial = await report(s1.cookie, { status: mInitial.code });
  ok(
    "**用配置里真实存在的状态 code 也一样收窄**（不是只认私有 code）：行都只有那个状态，我的行一个不在",
    rowsM(rInitial.body).every((r) => r.status === mInitial.code) &&
      rowsR(rInitial.body).every((r) => r.status === mInitial.code) &&
      !rowsM(rInitial.body).some((r) => r.status === ST) &&
      !rowsR(rInitial.body).some((r) => r.status === ST),
    `案件行状态=${[...new Set(rowsM(rInitial.body).map((r) => r.status))].join(",")}`,
  );

  /* ─────────────────────── 3. 可见性：L1 全见 / L2 跟名单 / L3 不见 ─────────────────────── */

  const r2Before = await report(s2.cookie);
  const r3Mine = await report(s3.cookie, { status: ST });
  ok(
    "**L2 看不到别人的案件**（参与经办只多看'我参与的行'，此刻还没被加进任何名单）",
    r2Before.body?.matters?.total === 0,
    `total=${r2Before.body?.matters?.total}`,
  );
  ok(
    "**L3 只看得见自己那条**（L1 建的 A / C 不在它的范围里）：总数 1、且落在 (私有状态, 私有等级) 的原告格",
    r3Mine.body?.matters?.total === 1 && cellM(r3Mine.body, ST, LV, "plaintiff") === 1,
    `total=${r3Mine.body?.matters?.total} 原告=${cellM(r3Mine.body, ST, LV, "plaintiff")}`,
  );

  // L1 把 L2 加成案件 A 的关注人：**L2 那条 `EXISTS (*_staff)` 分支就靠这一步才真的被走到**
  const addFollower = await call("POST", `/api/matters/${a.body.id}/staff`, s1.cookie, {
    userIds: [String(l2.id)],
    staffRole: "follower",
  });
  ok("L1 把 L2 加成案件 A 的关注人 → 200", addFollower.status === 200, `status=${addFollower.status}`);

  const r2Mine = await report(s2.cookie, { status: ST });
  const r3AfterFollow = await report(s3.cookie, { status: ST });
  const r1Mine = await report(s1.cookie, { status: ST });
  ok(
    "**L2 现在看得见这一条**（`participating` 分支生效：我是关注人 ⇒ 我可见），且只看得见它",
    r2Mine.body?.matters?.total === 1 && cellM(r2Mine.body, ST, LV, "defendant") === 1,
    `total=${r2Mine.body?.matters?.total} 被告=${cellM(r2Mine.body, ST, LV, "defendant")}`,
  );
  ok(
    "**L3 仍然看不见 A**（L3 刻意不含 `*_staff` 的协办/关注行——这条不对称是刻意的）",
    r3AfterFollow.body?.matters?.total === 1,
    `total=${r3AfterFollow.body?.matters?.total}`,
  );
  ok(
    "L1（全局）看得见三条（超集，不是另一套口径）",
    r1Mine.body?.matters?.total === 3,
    `total=${r1Mine.body?.matters?.total}`,
  );

  /* ─────────────────────── 4. 事项卡：状态 × 等级（+ ownerEmpty 联动） ─────────────────────── */

  const rRisk = await report(s1.cookie, { status: ST });
  ok(
    "**事项卡按 (状态, 等级) 计数**：两条事项都落在私有等级这一格",
    rRisk.body?.risks?.total === 2 && cellR(rRisk.body, ST, LV) === 2,
    `total=${rRisk.body?.risks?.total} 格=${cellR(rRisk.body, ST, LV)}`,
  );
  ok(
    "**等级是列键的一部分**：`status=ST` 下事项卡只有私有等级那一列（别的等级没跟着涨）",
    (rRisk.body?.risks?.levels ?? []).length === 1 &&
      (rRisk.body?.risks?.levels ?? []).every((col) => col.code === LV),
    `列=${(rRisk.body?.risks?.levels ?? []).map((col) => col.code).join(",")}`,
  );
  ok(
    "**事项卡没有诉讼地位这一维**（顶层与行级都没有那个键，见 `assertShape` 的键集合白名单）",
    !("roles" in (rRisk.body?.risks ?? {})) &&
      rowsR(rRisk.body).every((r) => !("litigationRole" in r)),
    `顶层 keys=${keySet(rRisk.body?.risks)}`,
  );

  const rUnowned = await report(s1.cookie, { status: ST, ownerEmpty: true });
  ok(
    "**`ownerEmpty=1` 让事项卡只剩未指派那条**（D1 留着、D2 走掉）",
    rUnowned.body?.risks?.total === 1 && cellR(rUnowned.body, ST, LV) === 1,
    `total=${rUnowned.body?.risks?.total}`,
  );
  ok(
    "**未指派下案件卡是空读数**：`matter.owner_id` NOT NULL（IQ-6），所以「未指派的案件」是空集",
    rUnowned.body?.matters?.total === 0 && rowsM(rUnowned.body).length === 0,
    `total=${rUnowned.body?.matters?.total}`,
  );

  /* ─────────────────── 5. 节点到期卡：三档 + 口径 + 跨两张表 ─────────────────── */

  const detailC = await call("GET", `/api/matters/${c.body.id}`, s1.cookie);
  const presetNodes = detailC.body?.nodes ?? [];
  ok(
    "案件 C 带上了预设节点（P1 预设路径）——它们没有时间，**不该**出现在任何一档里",
    presetNodes.length >= 3,
    `节点=${presetNodes.length}`,
  );

  const rBeforeNodes = await report(s1.cookie, { status: ST });
  ok(
    "**节点夹具之前：私有状态下的节点卡是空的**（预设节点没有期限，不进任何一档）",
    rBeforeNodes.body?.nodes?.total === 0 &&
      cellN(rBeforeNodes.body, "matter", "overdue") === 0 &&
      cellN(rBeforeNodes.body, "matter", "soon") === 0 &&
      cellN(rBeforeNodes.body, "matter", "later") === 0,
    `total=${rBeforeNodes.body?.nodes?.total}`,
  );

  // ① 已逾期：期限已过
  await stepNode(
    s1.cookie,
    "**期限已过 → 已逾期 +1**，另两档不动",
    "matter",
    () => insertMatterNode(c.body.id, { days: -2, remind: [7, 3, 1] }),
    "overdue",
  );
  // ② 临期：还剩 5 天，提醒档 {7,3,1} → 5 < 7 ⇒ 临期
  await stepNode(
    s1.cookie,
    "**还剩 5 天 + 提醒档 `{7,3,1}` → 临期 +1**",
    "matter",
    () => insertMatterNode(c.body.id, { days: 5, remind: [7, 3, 1] }),
    "soon",
  );
  // ③ 同一距离、更窄的提醒档 {3,1} → 5 > 3 ⇒ 更远。**这条就是"窗口不是常数"的判据**
  await stepNode(
    s1.cookie,
    "**同样还剩 5 天、但提醒档是 `{3,1}` → 算更远，不算临期**（窗口随节点走，不是硬编码 7 天）",
    "matter",
    () => insertMatterNode(c.body.id, { days: 5, remind: [3, 1] }),
    "later",
  );
  // ④⑤ 空 remind_days → 回落 7 天：还剩 5 天算临期、还剩 9 天算更远（§4.7 第 2 条明文口径）
  await stepNode(
    s1.cookie,
    "**空数组 `remind_days` 回落 7 天：还剩 5 天 → 临期 +1**（`max({})` 是 NULL，coalesce 到 7）",
    "matter",
    () => insertMatterNode(c.body.id, { days: 5, remind: [] }),
    "soon",
  );
  await stepNode(
    s1.cookie,
    "**空数组 `remind_days` 回落 7 天：还剩 9 天 → 更远 +1**（同一条回落口径的另一半）",
    "matter",
    () => insertMatterNode(c.body.id, { days: 9, remind: [] }),
    "later",
  );
  /*
   * ⚠ 下面两条是**后补的**，它们把回落值**从上下两侧**钉死。
   *
   * 上面那两条原先只钉住了"回落值 > 5"（5 天算临期 ⇒ 回落值必须大于 5），
   * 而 7 和 30 都满足它 —— 检查子代理实测：把回落值从 7 改成 30（F8-2 原稿那个数），
   * **"还剩 5 天 → 临期"那条全程保持 GREEN**，只有"还剩 9 天"那条红。
   * 也就是说实现者自评的"两条新断言都被变异证明过"**有一半是夸大的**。
   *
   * ## 判别力：把回落值夹成**唯一**的 7
   *
   *   还剩 6 天 → 临期   ⇔ `6 < v` 成立   ⇔ **v ≥ 7**
   *   还剩 7.5 天 → 更远 ⇔ `7.5 < v` 不成立 ⇔ **v ≤ 7**
   *   ⇒ v = 7（v 是 `coalesce(max(remind_days), 7)`，整数）
   *
   * ⚠ 原文只写了「还剩 7 天」一条，注释里称"唯一解 7"——**那是不对的**：
   * 单侧约束只能得到 `5 < v ≤ 7`，整数解有两个（6 和 7）。
   * 加上「还剩 6 天」这一侧，v 才真的被夹住。
   *
   * ## ⚠ 为什么是 **7.5 天**而不是 7 天（2026-10-15，MATT-84）
   *
   * 原本这一条写的是 `days: 7` —— **正好压在分档边界上**，于是它的期望档位
   * 取决于应用时钟与库时钟的亚秒级一致（完整论证与实测数字见
   * `assertFixtureMargin()` 的文档注释，不在这里重抄一遍）。
   *
   * **贴边的夹具本质上不可能稳定**：插入与比较发生在不同时刻，
   * 换成库时钟也一样（只是把「应用 vs 库」换成「插入事务 vs 报表事务」）。
   * 所以必须移开；而移开之后要保住判别力，就得用**非整数天**：
   * 阈值是整数 7，任何落在 `(7, 8]` 的 days 与 7 的判别力完全相同，
   * 而 7.5 离边界有 **12 小时**（远超那条断言要求的 1 小时下限）。
   *
   * **怎么复现这条断言的红**（AC 第 4 条，实测过一次）：把本行的 `days: 7.5`
   * 改回 `7`（或把 `MIN_MARGIN_HOURS` 改大到 24），跑
   * `node --env-file=.env agent-work/smoke-reports.mjs`，会得到：
   *
   *   [FAIL] **进档夹具的 `days` 离阈值至少 1 小时**… — days=7 / 阈值=7（余量 0.0 小时 < 1）
   *
   * 它是**断言红**（不是编译红），且不会连带弄挂别的断言 —— 除了那条
   * 「逐格对上夹具账」会跟着漂，而那正是本票要消灭的现象本身。
   */
  await stepNode(
    s1.cookie,
    "**空数组 `remind_days` 回落 7 天：还剩 6 天 → 临期 +1**（把回落值从**下方**钉死）",
    "matter",
    () => insertMatterNode(c.body.id, { days: 6, remind: [] }),
    "soon",
  );
  await stepNode(
    s1.cookie,
    "**空数组 `remind_days` 回落 7 天：还剩 7.5 天 → 更远 +1**（从**上方**钉死；非整数天是为了离边界 12 小时，见本处注释）",
    "matter",
    () => insertMatterNode(c.body.id, { days: 7.5, remind: [] }),
    "later",
  );
  // ⑥ 未确认时间：不进任何一档
  await stepNode(
    s1.cookie,
    "**未确认时间的节点不进任何一档**（只走 `is_time_confirmed` 的 partial index 那一路）",
    "matter",
    () => insertMatterNode(c.body.id, { days: 1, remind: [7, 3, 1], confirmed: false }),
  );
  // ⑦ 已完成：不再是"到期"
  await stepNode(
    s1.cookie,
    "**已完成的节点不再算到期**",
    "matter",
    () => insertMatterNode(c.body.id, { days: 1, remind: [7, 3, 1], status: "completed" }),
  );
  // ⑧ 时间已确认但两列都空：算不出"还剩几天"，不假装它更远
  await stepNode(
    s1.cookie,
    "**时间已确认但没填时间的节点不进任何一档**（算不出还剩几天，归哪一档都是编的）",
    "matter",
    () => insertMatterNode(c.body.id, { days: null, remind: [7, 3, 1] }),
  );
  // ⑨ 跨两张节点表：事项侧的到期节点必须也进卡②（挂在未指派的事项 D1 上）
  await stepNode(
    s1.cookie,
    "**事项侧的到期节点也进卡②**（两张同构节点表 UNION，只走一条就漏一半且不报错）",
    "risk_matter",
    () => insertRiskNode(d1.body.id, { days: -3, remind: [7, 3, 1] }),
    "overdue",
  );

  const rNodes = await report(s1.cookie, { status: ST });
  const expM = expLiveM();
  const expR = expLiveR();
  ok(
    "**每条夹具逐格对上夹具账**（三档各自的和，不是只看总数）",
    cellN(rNodes.body, "matter", "overdue") === expM.overdue &&
      cellN(rNodes.body, "matter", "soon") === expM.soon &&
      cellN(rNodes.body, "matter", "later") === expM.later &&
      cellN(rNodes.body, "risk_matter", "overdue") === expR.overdue &&
      rNodes.body?.nodes?.total === totalOf(expM) + totalOf(expR),
    `实际 ${cellN(rNodes.body, "matter", "overdue")}/${cellN(rNodes.body, "matter", "soon")}/${cellN(rNodes.body, "matter", "later")}+${cellN(rNodes.body, "risk_matter", "overdue")} vs 期望 ${expM.overdue}/${expM.soon}/${expM.later}+${expR.overdue}`,
  );
  assertNodeInvariants("带夹具", rNodes.body);

  const rNodesUnowned = await report(s1.cookie, { status: ST, ownerEmpty: true });
  ok(
    "**`ownerEmpty` 也作用到节点卡**：未指派下只剩事项那一行（案件行全 0）",
    rNodesUnowned.body?.nodes?.total === totalOf(expR) &&
      cellN(rNodesUnowned.body, "matter", "overdue") === 0 &&
      cellN(rNodesUnowned.body, "matter", "soon") === 0 &&
      cellN(rNodesUnowned.body, "matter", "later") === 0,
    `合计=${rNodesUnowned.body?.nodes?.total} 案件行=${cellN(rNodesUnowned.body, "matter", "overdue")}/${cellN(rNodesUnowned.body, "matter", "soon")}/${cellN(rNodesUnowned.body, "matter", "later")}`,
  );

  /**
   * 与工作台的边界：同一个节点，工作台算「7 日内到期」、报表算「更远」（两套口径同时成立）。
   *
   * 用 **L3 自己的账**比而不是 L1：L3 只看得见自己那条案卷，所以工作台的 `within7`
   * **精确 +1**，不存在"别人的夹具同时进来"的抖动（L1 是全局账号，它的读数会被并发冒烟影响）。
   */
  const ovBefore = await call("GET", "/api/overview", s3.cookie);
  await insertMatterNode(b.body.id, { days: 5, remind: [3, 1] });
  const ovAfter = await call("GET", "/api/overview", s3.cookie);
  const rBoundary = await report(s3.cookie, { status: ST });
  ok(
    "**与工作台的边界**：同一个 `{3,1}` 的 5 天节点，工作台算「7 日内到期」、报表算「更远」",
    ovAfter.body?.nodes?.within7 === (ovBefore.body?.nodes?.within7 ?? 0) + 1 &&
      cellN(rBoundary.body, "matter", "later") === 1 &&
      cellN(rBoundary.body, "matter", "soon") === 0,
    `工作台 within7 ${ovBefore.body?.nodes?.within7}→${ovAfter.body?.nodes?.within7}；报表 later=${cellN(rBoundary.body, "matter", "later")} soon=${cellN(rBoundary.body, "matter", "soon")}`,
  );
  ok(
    "**L3 的节点卡只装自己那条**（它看不见别人的案卷，也就看不见别人的节点）",
    rBoundary.body?.nodes?.total === 1,
    `total=${rBoundary.body?.nodes?.total}`,
  );

  /* ───────────────────────── 6. 归档：二态，不混着看 ───────────────────────── */

  // E：带一个节点的案件，走**真归档路径**（状态流转 + is_archived），用来验归档谓词
  const e = await mkMatter(s1.cookie, `报表冒烟 案件E ${stamp}`, "high", "defendant");
  matterIds.push(e.body?.id);
  await tagMatter(e.body.id);
  const eNode = await insertMatterNode(e.body.id, { days: -1, remind: [7, 3, 1] });

  // 夹具账到此才算登记完（这一行是最后一条 `insertMatterNode` / `insertRiskNode`），
  // 所以夹具质量的自检放这里 —— 放早了会漏掉之后新增的进档夹具（MATT-84 的评审
  // 抓到过这一处：初版放在节点段开头，漏了本行与上面 `b` 事项那条）。
  assertFixtureMargin();

  const liveBefore = await report(s1.cookie, { status: ST });
  ok(
    "归档之前：E 与它的节点都算在在办视图里",
    liveBefore.body?.matters?.total === 4 &&
      cellN(liveBefore.body, "matter", "overdue") === expLiveM().overdue,
    `total=${liveBefore.body?.matters?.total} overdue=${cellN(liveBefore.body, "matter", "overdue")}（期望 ${expLiveM().overdue}）`,
  );

  const archE = await call("POST", `/api/matters/${e.body.id}/status`, s1.cookie, {
    to: mArchived.code,
    reason: "冒烟：验归档谓词（归档后只该出现在 archivedOnly=1 里）",
  });
  ok("归档案件 E → 200", archE.status === 200, `status=${archE.status}`);
  // E 归档了：夹具账跟着改，期望值始终是"当前该看见的那些"
  eNode.host = "archived";

  const liveAfter = await report(s1.cookie, { status: ST });
  const archView = await report(s1.cookie, { archivedOnly: true });
  ok(
    "**归档后从默认（在办）视图里消失**：私有状态下的案件总数 4→3、那个节点也不再算",
    liveAfter.body?.matters?.total === 3 &&
      cellN(liveAfter.body, "matter", "overdue") === expLiveM().overdue &&
      liveAfter.body?.nodes?.total === totalOf(expLiveM()) + totalOf(expLiveR()),
    `total=${liveAfter.body?.matters?.total} overdue=${cellN(liveAfter.body, "matter", "overdue")}（期望 ${expLiveM().overdue}）节点=${liveAfter.body?.nodes?.total}`,
  );
  ok(
    "**`archivedOnly=1` 里出现**：私有等级那一格恰好是归档的 E（等级不随归档变，所以它仍是私有维度）",
    archView.body?.archivedOnly === true &&
      cellM(archView.body, mArchived.code, LV, "defendant") === 1,
    `格=${cellM(archView.body, mArchived.code, LV, "defendant")}`,
  );
  ok(
    "**归档视图里没有在办的行**：我那条私有状态的在办夹具不在里面（归档的 E 在里面，见上一条）",
    // ⚠ 只断言**我的行**（私有等级）：归档视图是共享的，别的流的冒烟会往里塞夹具
    // ——本轮实测 `smoke-expenses` 直接用 SQL 把 `is_archived=true` 而**不动 status**，
    // 于是"归档视图里只剩归档态的行"这条更宽的断言会被它弄红（那是它的问题，不是报表的）
    !rowsM(archView.body).some((r) => r.level === LV && r.status === ST),
    `归档视图里我的行=${rowsM(archView.body)
      .filter((r) => r.level === LV)
      .map((r) => r.status)
      .join(",")}`,
  );
  const liveArchStatus = await report(s1.cookie, { status: mArchived.code });
  ok(
    "**在办视图 + 归档态筛选 ⇒ 一律 0**（归档谓词真的在起作用：摘掉它，归档行会混进在办视图）",
    liveArchStatus.body?.matters?.total === 0 && liveArchStatus.body?.nodes?.total === 0,
    `案件=${liveArchStatus.body?.matters?.total} 节点=${liveArchStatus.body?.nodes?.total}`,
  );
  ok(
    "**归档视图里节点卡算得上归档宿主的节点**（方向断言：至少含 E 那一条；精确值会被并发归档影响）",
    cellN(archView.body, "matter", "overdue") >= expectNodes("matter", ["archived"]).overdue &&
      cellN(archView.body, "matter", "overdue") >= 1,
    `overdue=${cellN(archView.body, "matter", "overdue")}（期望至少 1）`,
  );
  const archWithSt = await report(s1.cookie, { status: ST, archivedOnly: true });
  ok(
    "**私有状态在归档视图里是空的**（E 归档后状态已改成归档态；这条同时钉住「归档是状态与归档位一起动」）",
    archWithSt.body?.matters?.total === 0,
    `total=${archWithSt.body?.matters?.total}`,
  );

  /* ─────────────── 7. 聚合在服务端：响应里没有明细（键集合已穷尽） ─────────────── */

  const raw = JSON.stringify(liveAfter.body);
  ok(
    "**响应体里没有任何一条案卷名**（只给格子，不给明细——前端无从'拉明细再本地算'）",
    !raw.includes(`报表冒烟 案件A ${stamp}`) &&
      !raw.includes(`报表冒烟 事项D1 ${stamp}`) &&
      !raw.includes("报表冒烟 到期节点") &&
      !raw.includes("报表冒烟 到期事项节点"),
    `长度=${raw.length}`,
  );
  assertShape("归档后的在办视图", liveAfter.body);
  assertMatrixInvariants("归档后的在办视图", liveAfter.body);

  /* ─────────────────── 8. 页面形态：卡片在列表页顶部、没有报表页 ─────────────────── */

  const pageM = await call("GET", "/matters", s1.cookie);
  const pageR = await call("GET", "/risk-matters", s1.cookie);
  const pageGone = await call("GET", "/reports", s1.cookie);
  ok(
    "**两张卡挂在列表页顶部**：`/matters` 与 `/risk-matters` 的 HTML 里有「总览」与「节点到期」",
    pageM.status === 200 &&
      pageR.status === 200 &&
      pageM.body.includes("总览") &&
      pageM.body.includes("节点到期") &&
      pageR.body.includes("总览") &&
      pageR.body.includes("节点到期"),
    `matters=${pageM.status} risk-matters=${pageR.status}`,
  );
  ok(
    "**没有报表页**：`/reports` 是 404（P0-2：不建报表页；页面节点仍是 18）",
    pageGone.status === 404,
    `status=${pageGone.status}`,
  );
  ok(
    "**没有报表菜单项**：列表页 HTML 里不出现「报表」",
    !pageM.body.includes("报表") && !pageR.body.includes("报表"),
    `matters 命中=${(pageM.body.match(/报表/g) ?? []).length} risk-matters 命中=${(pageR.body.match(/报表/g) ?? []).length}`,
  );
} catch (e) {
  fail++;
  console.log(`[FAIL] 脚本中断 —— ${e?.stack ?? e}`);
} finally {
  try {
    await cleanup();
    console.log("[clean] 清场完成");
  } catch (e) {
    noteCleanupFailure("夹具清场", e);
  }
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);

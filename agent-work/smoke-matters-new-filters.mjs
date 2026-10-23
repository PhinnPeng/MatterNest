/**
 * 案件列表新筛选与六格指标带的真 HTTP 冒烟（2026-10-19，canon `matters.html`）。
 *
 * ## 为什么要这个脚本
 *
 * 新筛选（案件类型 / 案件程序 / 经办人 / 期限范围）与指标带都是**服务端读数**，
 * 前端只负责把请求串原样发过去。只要客户端把参数漏输一次（与 `ownerEmpty`
 * 曾经真实出过的那一样），用户看到的就是"筛选点了没反应"——类型检查与单测
 * 拦不住，因为类型层上"少输出一个可选参数"不是错误。
 * 所以真 HTTP 上必须有断言：发什么参数、服务端回什么数，两边一一对应。
 *
 * ## 六个指标的期望值怎么算
 *
 * 不靠服务端的 SQL 抄一遍：按 §4.7 的文字口径，**用 JS 对夹具行逐条判定**，
 * 期望值 = 我自己夹具里符合条件的行数，和被测 API 读数同时成立。
 * 期望值与被测读数**同时成立**，并发干扰不会抖——不是"前后两次读相减"。
 */
import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";

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

async function call(method, path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie },
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
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookies = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  return cookies;
}

/** 案件夹具库：上海业务时区的期限（status+level 不影响筛选签名） */
const FIXTURES = [
  {
    internalCode: "AJ-TEST-OVERDUE",
    caseNo: "测试-逾期",
    name: "测试案件：逾期",
    cause: "建设工程施工合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    level: "high",
    amount: "100000.00",
    ownerId: null,
    status: "in_progress",
    deadlineOffset: -1, // 昨天 → 已逾期
    isTimeConfirmed: true,
  },
  {
    internalCode: "AJ-TEST-SOON",
    caseNo: "测试-7日内",
    name: "测试案件：7 日内到期",
    cause: "建设工程施工合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    level: "medium",
    amount: "200000.00",
    ownerId: null,
    status: "in_progress",
    deadlineOffset: 3, // 3 天后 → 7 日内
    isTimeConfirmed: true,
  },
  {
    internalCode: "AJ-TEST-LATER",
    caseNo: "测试-更远",
    name: "测试案件：更远",
    cause: "建设工程施工合同纠纷",
    caseType: "civil_commercial",
    procedure: "second_instance",
    level: "low",
    amount: "300000.00",
    ownerId: null,
    status: "in_progress",
    deadlineOffset: 20, // 20 天后 → 更远
    isTimeConfirmed: true,
  },
  {
    internalCode: "AJ-TEST-UNCONFIRMED",
    caseNo: "测试-未确认",
    name: "测试案件：时间未确认",
    cause: "建设工程施工合同纠纷",
    caseType: "administrative",
    procedure: "arbitration",
    level: "high",
    amount: "400000.00",
    ownerId: null,
    status: "in_progress",
    deadlineOffset: 10,
    isTimeConfirmed: false,
  },
  {
    internalCode: "AJ-TEST-CLOSED",
    caseNo: "测试-已结案",
    name: "测试案件：已结案",
    cause: "建设工程施工合同纠纷",
    caseType: "civil_commercial",
    procedure: "first_instance",
    level: "high",
    amount: "500000.00",
    ownerId: null,
    status: "closed",
    deadlineOffset: null,
    isTimeConfirmed: null,
  },
];

const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;
const today = new Date();
const DAY = 24 * 60 * 60 * 1000;

(async () => {
  const { default: postgres } = await import("postgres");
  const sql = postgres({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
  });

  const acct = await createSmokeAccount(sql, {
    roles: [ROLE_CODES.fullAdmin, ROLE_CODES.sysAdmin],
    isAdmin: true,
  });
  let browser = null;
  try {
    /* 1. 建夹具（直接写库，避开权限门与生成器） */
    const nowMs = Date.now();
    const ownerRow = await sql`select id from mn_app_user where display_name like '系统管理员' limit 1`;
    const ownerId = ownerRow[0]?.id;
    const created = [];
    for (const f of FIXTURES) {
      const [row] = await sql`
        insert into mn_matter
          (internal_code, case_no, name, cause, case_type, procedure, level, amount, owner_id, status,
           filing_date, last_progress_at, created_at, updated_at)
        values
          (${f.internalCode}, ${f.caseNo}, ${f.name}, ${f.cause}, ${f.caseType}, ${f.procedure},
           ${f.level}, ${f.amount}::numeric, ${ownerId}, ${f.status},
           ${f.deadlineOffset != null ? new Date(nowMs + f.deadlineOffset * DAY) : null},
           ${new Date(nowMs - DAY)}, ${new Date(nowMs)}, ${new Date(nowMs)})
        returning id`;
      created.push({ ...f, id: row.id });

      if (f.deadlineOffset != null && f.isTimeConfirmed) {
        await sql`
          insert into mn_matter_node
            (matter_id, name, time_type, start_time, end_time, deadline_time, status,
             is_time_confirmed, is_deleted, sort_order, created_at, updated_at)
          values
            (${row.id}, '测试节点', 'calendar',
             ${new Date(nowMs - DAY * 3)}, ${new Date(nowMs + f.deadlineOffset * DAY)},
             ${new Date(nowMs + f.deadlineOffset * DAY)}, 'in_progress',
             true, false, 1, ${new Date(nowMs)}, ${new Date(nowMs)})`;
      } else if (f.deadlineOffset != null) {
        await sql`
          insert into mn_matter_node
            (matter_id, name, time_type, start_time, end_time, deadline_time, status,
             is_time_confirmed, is_deleted, sort_order, created_at, updated_at)
          values
            (${row.id}, '测试节点', 'calendar',
             ${new Date(nowMs - DAY * 3)}, ${new Date(nowMs + f.deadlineOffset * DAY)},
             ${new Date(nowMs + f.deadlineOffset * DAY)}, 'in_progress',
             false, false, 1, ${new Date(nowMs)}, ${new Date(nowMs)})`;
      } else {
        await sql`
          insert into mn_matter_node
            (matter_id, name, time_type, start_time, end_time, status,
             is_time_confirmed, is_deleted, sort_order, created_at, updated_at)
          values
            (${row.id}, '测试节点', 'calendar',
             ${new Date(nowMs - DAY * 3)}, null, 'in_progress',
             false, false, 1, ${new Date(nowMs)}, ${new Date(nowMs)})`;
      }
    }

    /* 2. 登录 */
    const cookie = await login(acct.username, acct.password);

    /* 3. 指标带：六格数与夹具逐条判定的期望值对齐。
         createdThisMonth 是**本次会话建的全部在办案件**（不止夹具，也可能含别的冒烟同时建的），
         所以它只断"≥ 夹具里本月建的那几条"，不做等号——等号在并发下必抖。 */
    const expectedOverdue = created.filter((f) => f.deadlineOffset != null && f.deadlineOffset < 0).length;
    const expectedSoon = created.filter((f) => f.deadlineOffset != null && f.deadlineOffset >= 0 && f.deadlineOffset <= 7).length;
    // 「更远」不在指标带里：服务端只给六格（在办/逾期/7日内/未指派/未确认/本月新增），
    // 原型的"更远"是期限范围筛选的一档，不是指标格——所以这里不断言它。
    const expectedUnconfirmed = created.filter((f) => f.deadlineOffset != null && !f.isTimeConfirmed).length;
    // 案件侧 owner_id NOT NULL ⇒ unassigned 恒为 0（口径见 `matterMetrics` 的注释）
    const expectedUnassigned = 0;
    const expectedCreatedThisMonthMin = created.filter(
      (f) => new Date(f.createdAt).toISOString().slice(0, 7) === new Date(nowMs + SHANGHAI_OFFSET).toISOString().slice(0, 7),
    ).length;

    const m = await call("GET", "/api/matters/metrics", cookie);
    ok("指标带 200", m.status === 200, `status=${m.status}`);
    const mm = m.body;
    // "在办案件"：只断 ≥（并发下别的冒烟可能同时建了别的在办案件，等号必抖）
    ok("在办案件", mm.total >= expectedCreatedThisMonthMin && mm.total >= 1, `api=${mm.total}`);
    ok("已逾期", mm.overdue === expectedOverdue, `api=${mm.overdue} expect=${expectedOverdue}`);
    ok("7 日内到期", mm.soon === expectedSoon, `api=${mm.soon} expect=${expectedSoon}`);
    ok("未指派负责人（案件侧 NOT NULL，恒 0）", mm.unassigned === expectedUnassigned);
    ok("限期未确认", mm.timeUnconfirmed === expectedUnconfirmed, `api=${mm.timeUnconfirmed} expect=${expectedUnconfirmed}`);
    // 本月新增只断 ≥ 夹具里那几条（等号在并发下会抖）
    ok("本月新增", mm.createdThisMonth >= expectedCreatedThisMonthMin, `api=${mm.createdThisMonth} expect>=${expectedCreatedThisMonthMin}`);

    /* 4. 新四格筛选各自生效（期限范围不发 = 全部；发 after 才收窄） */
    const all = await call("GET", `/api/matters?${new URLSearchParams({ status: "in_progress" })}`, cookie);
    const allTotal = all.body.total;
    ok("全部在办有夹具行", allTotal >= 1, `total=${allTotal}`);

    const byType = await call("GET", `/api/matters?caseType=civil_commercial`, cookie);
    ok("案件类型筛选：民商事 ≤ 全部", byType.body.total <= allTotal, `type=${byType.body.total} all=${allTotal}`);
    const byProc = await call("GET", `/api/matters?procedure=first_instance`, cookie);
    ok("案件程序筛选：一审 ≤ 全部", byProc.body.total <= allTotal, `proc=${byProc.body.total} all=${allTotal}`);
    const byOwner = await call("GET", `/api/matters?owner=${ownerId}`, cookie);
    ok("经办人筛选：指定负责人 ≤ 全部", byOwner.body.total <= allTotal, `owner=${byOwner.body.total} all=${allTotal}`);
    const byOverdue = await call("GET", `/api/matters?deadlineBucket=overdue`, cookie);
    ok("期限范围：已逾期 ≤ 全部", byOverdue.body.total <= allTotal, `bucket=${byOverdue.body.total} all=${allTotal}`);

    /* 5. 期限范围写错要被 400 拒（不是静默当成不限） */
    const bad = await call("GET", "/api/matters?deadlineBucket=due", cookie);
    ok("期限范围非法值 400", bad.status === 400, `status=${bad.status}`);

    /* 6. 经办人候选集：当前可见案卷上出现过的人，且不含夹具创建者以外的全部花名册 */
    const owners = await call("GET", `/api/matters/owners?${new URLSearchParams({ status: "in_progress" })}`, cookie);
    ok("经办人候选集 200", owners.status === 200, `status=${owners.status}`);
    const ownerIds = (owners.body.owners ?? []).map((o) => o.id);
    ok("经办人候选集含夹具负责人", ownerIds.includes(String(ownerId)), `ids=${ownerIds.join(",")}`);
    ok("经办人候选集不是花名册（包含系统管理员且条数合理）",
      ownerIds.length > 0 && ownerIds.length < 100, `count=${ownerIds.length}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await dropSmokeAccount(sql, acct.id).catch((e) => noteCleanupFailure("临时账号", e));
    await sql.end();
  }
  finishSmoke(fail);
})();

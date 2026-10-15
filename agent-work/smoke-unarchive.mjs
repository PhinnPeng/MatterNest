import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";
/**
 * 撤销归档的审计链真 HTTP 冒烟（MATT-60 / T4d）。
 *
 * ## 这条链路要钉住什么
 *
 * `UNARCHIVED` 是**声明了、有中文标签、被列进「原因恒必填」四条**里，但**全仓没有任何
 * 地方写它**的审计动作：写入侧只写 `action: archiving ? "ARCHIVED" : "STATUS_CHANGED"`
 * （`matters.ts` / `risks.ts`），于是撤销归档在审计里长得和普通状态流转一模一样。
 * 而"按动作名把撤销归档筛出来"这件事在排障时是**不可回答**的 —— 只能对着
 * `diffs.status` 人工推断。
 *
 * ## 三组断言，缺一组就会漏掉一类失败
 *
 * ① **正向**：撤销归档 → 落一条 `UNARCHIVED`，且带着原因（不是 200 就算完）。
 * ② **恒必填**：不填原因 ⇒ 422。这一条**不是**"偏离推荐路径"能兜住的 ——
 *    撤销归档恰好顺着推荐路径走时，那条判定一个原因都不要。所以单独断。
 * ③ **负向**：普通状态变更不得落 `UNARCHIVED`（否则筛选失去意义）。
 *    负向断言**先钉住响应成功**（200 + 库里真的改了状态），否则"没落 UNARCHIVED"
 *    会以"整步就失败了"的形式假绿。
 *
 * ## 两侧都要断
 *
 * 案件与事项的 `changeStatus` 是同一条链上的两处镜像（`matters.ts` / `risks.ts`），
 * 只改一处是这条链路历史上反复出现的形态，所以下面各跑一遍。
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
    cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; "),
  };
}

/** 从 `/api/meta` 取某个语义的状态 code（配置驱动，不硬编码 code 字面量） */
async function statusCodeOf(cookie, host, semantics) {
  const r = await call("GET", `/api/meta?host=${host}`, cookie);
  const row = (r.body?.statuses ?? []).find((s) => s.semantics === semantics);
  return row?.code ?? null;
}

const stamp = Date.now();
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const boss = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const matterIds = [];
const riskIds = [];

async function cleanup() {
  for (const id of matterIds) {
    for (const q of [
      `delete from mn_activity_log where matter_id=${id}`,
      `delete from mn_matter_progress where matter_id=${id}`,
      `delete from mn_matter_staff where matter_id=${id}`,
      `delete from mn_matter_node where matter_id=${id}`,
      `delete from mn_matter_party where matter_id=${id}`,
      `delete from mn_matter where id=${id}`,
    ]) {
      await sql.unsafe(q).catch((e) => noteCleanupFailure(`夹具行 ${q}`, e));
    }
  }
  for (const id of riskIds) {
    for (const q of [
      `delete from mn_activity_log where risk_matter_id=${id}`,
      `delete from mn_risk_matter_staff where risk_matter_id=${id}`,
      `delete from mn_risk_matter where id=${id}`,
    ]) {
      await sql.unsafe(q).catch((e) => noteCleanupFailure(`夹具行 ${q}`, e));
    }
  }
  for (const acc of [boss]) {
    if (!acc?.id) continue;
    await sql`delete from mn_activity_log where operator_id = ${acc.id}`.catch((e) =>
      noteCleanupFailure(`活动日志 ${acc.id}`, e),
    );
    await sql`delete from mn_auth_session where user_id = ${acc.id}`.catch((e) =>
      noteCleanupFailure(`会话 ${acc.id}`, e),
    );
    await sql`delete from mn_app_user_role where user_id = ${acc.id}`.catch((e) =>
      noteCleanupFailure(`角色 ${acc.id}`, e),
    );
    try {
      await dropSmokeAccount(sql, acc.id);
    } catch (e) {
      noteCleanupFailure(`临时账号 ${acc.username}（${acc.id}）`, e);
    }
  }
}

try {
  const c = (await login(boss.username, boss.password)).cookie;
  const archivedCode = await statusCodeOf(c, "matter", "archived");
  const closedCode = await statusCodeOf(c, "matter", "closed");
  const inProgressCode = await statusCodeOf(c, "matter", "in_progress");
  ok(
    "拿到 archived / closed / in_progress 三个语义的状态 code",
    !!archivedCode && !!closedCode && !!inProgressCode,
    `archived=${archivedCode} closed=${closedCode} in_progress=${inProgressCode}`,
  );

  const mk = () =>
    call("POST", "/api/matters", c, {
      name: `撤归档冒烟 ${stamp}`,
      cause: "建设工程施工合同纠纷",
      caseType: "civil_commercial",
      procedure: "first_instance",
      litigationRole: "defendant",
      level: "high",
    });

  // ── A. 正向：撤销归档落 `UNARCHIVED`，且带着原因 ──
  const a = await mk();
  ok("建案 A → 201", a.status === 201, `status=${a.status}`);
  matterIds.push(a.body?.id);
  const archA = await call("POST", `/api/matters/${a.body.id}/status`, c, {
    to: archivedCode,
    reason: "冒烟：先归档",
  });
  ok("A 归档 → 200", archA.status === 200, `status=${archA.status}`);

  const noReason = await call("POST", `/api/matters/${a.body.id}/status`, c, { to: inProgressCode });
  ok(
    "**撤销归档不填原因 → 422 reason_required**（§3.2 恒必填，不是只靠偏离判定）",
    noReason.status === 422 && noReason.body?.error === "reason_required",
    `status=${noReason.status} err=${noReason.body?.error}`,
  );
  const [afterRefuse] = await sql`
    select status from mn_matter where id = ${a.body.id}`;
  ok("被拒之后状态没动（还停在归档态）", afterRefuse?.status === archivedCode, `status=${afterRefuse?.status}`);

  const unA = await call("POST", `/api/matters/${a.body.id}/status`, c, {
    to: inProgressCode,
    reason: "冒烟：材料又补齐了，撤销归档继续办",
  });
  ok("撤销归档（带原因）→ 200", unA.status === 200, `status=${unA.status}`);
  const [logA] = await sql`
    select action, reason, payload from mn_activity_log
     where matter_id = ${a.body.id} and action = 'UNARCHIVED'
     order by created_at desc limit 1`;
  ok(
    "**撤销归档按动作名筛得出 `UNARCHIVED`**（这一条本仓此前不可能成立）",
    logA?.action === "UNARCHIVED",
    `action=${logA?.action}`,
  );
  ok(
    "`UNARCHIVED` 带着原因（§3.2 的四条之一，原因随动作落库）",
    String(logA?.reason ?? "").includes("补齐"),
    `reason=${String(logA?.reason ?? "").slice(0, 40)}`,
  );
  const [rowA] = await sql`
    select is_archived, archived_at from mn_matter where id = ${a.body.id}`;
  ok("撤销归档真的把 `is_archived` 翻回来", rowA?.is_archived === false, `is_archived=${rowA?.is_archived}`);

  // ── B. 负向：普通状态变更不得落 `UNARCHIVED` ──
  // ⚠ 先钉住这一步**成功了**（200 + 库里状态真的换了），否则下面那条负向断言
  //   会以"整步就失败了"的形式假绿。
  const plainB = await call("POST", `/api/matters/${a.body.id}/status`, c, { to: inProgressCode === null ? "in_progress" : closedCode });
  const plainOk = plainB.status === 200;
  const [rowB] = await sql`select status from mn_matter where id = ${a.body.id}`;
  ok(
    "普通状态变更 → 200 且状态真的换了（负向断言的前提，不是装饰）",
    plainOk && rowB?.status !== archivedCode && rowB?.status !== inProgressCode,
    `status=${plainB.status} 库里=${rowB?.status}`,
  );
  const [logB] = await sql`
    select count(*)::int as n from mn_activity_log
     where matter_id = ${a.body.id} and action = 'UNARCHIVED'`;
  ok(
    "**普通状态变更不得落 `UNARCHIVED`**（否则筛选失去意义）",
    (logB?.n ?? 0) === 1,
    `UNARCHIVED 共 ${logB?.n} 条（A 案那一条）`,
  );

  // ── C. 事项侧同一条链路（两处镜像，只改一处是这个坑的历史形态）──
  const r = await call("POST", "/api/risk-matters", c, {
    name: `撤归档冒烟 事项 ${stamp}`,
    type: "contract",
    level: "high",
    description: "事项侧也要落 UNARCHIVED",
  });
  ok("建事项 → 201", r.status === 201, `status=${r.status}`);
  riskIds.push(r.body?.id);
  const rArchived = await statusCodeOf(c, "risk_matter", "archived");
  const rInProgress = await statusCodeOf(c, "risk_matter", "in_progress");
  ok(
    "事项侧也拿到 archived / in_progress 语义",
    !!rArchived && !!rInProgress,
    `archived=${rArchived} in_progress=${rInProgress}`,
  );
  const archR = await call("POST", `/api/risk-matters/${r.body.id}/status`, c, {
    to: rArchived,
    reason: "冒烟：先归档",
  });
  ok("事项归档 → 200", archR.status === 200, `status=${archR.status}`);
  const unR = await call("POST", `/api/risk-matters/${r.body.id}/status`, c, {
    to: rInProgress,
    reason: "冒烟：撤销事项归档",
  });
  ok("撤销事项归档（带原因）→ 200", unR.status === 200, `status=${unR.status}`);
  const [logR] = await sql`
    select action, reason from mn_activity_log
     where risk_matter_id = ${r.body.id} and action = 'UNARCHIVED'
     order by created_at desc limit 1`;
  ok(
    "**事项侧同样落 `UNARCHIVED`**（`risks.ts` 那一处同改）",
    logR?.action === "UNARCHIVED",
    `action=${logR?.action}`,
  );
  const unR2 = await call("POST", `/api/risk-matters/${r.body.id}/status`, c, { to: rArchived });
  ok(
    "事项侧撤销归档**不填原因同样 422**（恒必填两侧都生效）",
    unR2.status === 422 && unR2.body?.error === "reason_required",
    `status=${unR2.status} err=${unR2.body?.error}`,
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

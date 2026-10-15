import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";
/**
 * 删除案件的真 HTTP 冒烟（MATT-62 / F2-5）。
 *
 * ## 这批断言的核心是一条**成对**判据
 *
 * 「删后列表与详情都 404」**和**「库里那行还在（`is_deleted=true`）」必须同时断。
 * 只断前者的话，**硬删也能过** —— 而那正是修订稿 §12.4 要防的
 * （业务表只软删、FK 一律 RESTRICT；节点/参与人/当事人/进展都还指着这一行）。
 * 只断后者则更糟：软删落了库但接口还看得见，等于"删了但没删"。
 *
 * ## 另外三条容易糊过去的
 *
 * ① **不可见一律 404**，不是 403：403 等于向探测者确认"这个 id 存在"（元规则 3）。
 * ② **软删不刷新任何业务时钟**：本函数不写 `last_progress_at` —— 删一条案件不是
 *    「有人处理过它」（与进展的"软删不算投入"同一条口径，MATT-59 定的）。
 * ③ **归档态允许删除**（裁定写在 `deleteMatter` 的注释里）：删完同样 404、库里同样在。
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

async function statusCodeOf(cookie, host, semantics) {
  const r = await call("GET", `/api/meta?host=${host}`, cookie);
  return (r.body?.statuses ?? []).find((s) => s.semantics === semantics)?.code ?? null;
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
const outsider = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const matterIds = [];

const rowOf = (id) =>
  sql`select status, is_archived, is_deleted, deleted_at, last_progress_at from mn_matter where id = ${id}`;

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
  for (const acc of [boss, outsider]) {
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
  const oC = (await login(outsider.username, outsider.password)).cookie;

  const mk = (name) =>
    call("POST", "/api/matters", c, {
      name,
      cause: "建设工程施工合同纠纷",
      caseType: "civil_commercial",
      procedure: "first_instance",
      litigationRole: "defendant",
      level: "high",
    });

  // ── 1. 建案 + 一条子行（证明关联行不跟着消失）──
  const m = await mk(`删除冒烟 ${stamp}`);
  ok("建案 → 201", m.status === 201, `status=${m.status}`);
  const mid = m.body?.id;
  matterIds.push(mid);
  const [before] = await rowOf(mid);
  const nodesBefore = await sql`
    select count(*)::int n from mn_matter_node where matter_id = ${mid}`;

  // ── 2. 删除 ──
  const del = await call("DELETE", `/api/matters/${mid}`, c);
  ok("**DELETE /api/matters/{id} → 200**", del.status === 200, `status=${del.status} ${JSON.stringify(del.body)}`);

  // ── 3. 成对判据之一：接口两面都 404 ──
  const detailAfter = await call("GET", `/api/matters/${mid}`, c);
  ok("**删后详情 → 404**", detailAfter.status === 404, `status=${detailAfter.status}`);
  const listAfter = await call("GET", `/api/matters?page=1&pageSize=100`, c);
  ok("列表 → 200（否则下面那条负向断言会空过）", listAfter.status === 200, `status=${listAfter.status}`);
  ok(
    "**删后列表里找不到它**",
    !(listAfter.body?.items ?? []).some((r) => String(r.id) === String(mid)),
    `命中 ${(listAfter.body?.items ?? []).filter((r) => String(r.id) === String(mid)).length} 条`,
  );

  // ── 4. 成对判据之二：库里那行还在，且是软删形态 ──
  const [after] = await rowOf(mid);
  ok(
    "**库里那行还在（is_deleted=true，不是硬删）**",
    after !== undefined && after.is_deleted === true,
    `is_deleted=${after?.is_deleted}`,
  );
  ok(
    "`deleted_at` 落了值（软删的时间戳，不是只翻布尔）",
    !!after?.deleted_at,
    `deleted_at=${after?.deleted_at}`,
  );
  ok(
    "状态没被顺手改掉（删除不是状态迁移，不写 `STATUS_CHANGED`）",
    after?.status === before?.status,
    `status=${after?.status}（原 ${before?.status}）`,
  );
  const nodesAfter = await sql`
    select count(*)::int n from mn_matter_node where matter_id = ${mid}`;
  ok(
    "**关联行原样留着**（FK 一律 RESTRICT，业务表只软删 —— §12.4）",
    nodesAfter[0]?.n === nodesBefore[0]?.n && nodesBefore[0]?.n > 0,
    `节点 ${nodesBefore[0]?.n} → ${nodesAfter[0]?.n}`,
  );

  // ── 5. 审计 ──
  const [audit] = await sql`
    select action, target_type from mn_activity_log
     where matter_id = ${mid} and action = 'MATTER_DELETED'
     order by created_at desc limit 1`;
  ok(
    "**落了 `MATTER_DELETED` 审计**（与 `RISK_DELETED` 同形）",
    audit?.action === "MATTER_DELETED" && audit?.target_type === "matter",
    `action=${audit?.action} target=${audit?.target_type}`,
  );

  // ── 6. 软删不刷新业务时钟 ──
  ok(
    "**删除不刷新 `last_progress_at`**（删一条案件不是「有人处理过它」）",
    String(after?.last_progress_at) === String(before?.last_progress_at),
    `before=${before?.last_progress_at} after=${after?.last_progress_at}`,
  );

  // ── 7. 不可见一律 404（不是 403）──
  const denied = await call("DELETE", `/api/matters/${mid}`, oC);
  ok(
    "**看不见 ⇒ 404**（不是 403 —— 403 等于确认这个 id 存在）",
    denied.status === 404,
    `status=${denied.status} err=${denied.body?.error}`,
  );
  const gone = await call("DELETE", `/api/matters/999999999999`, c);
  ok("不存在的 id ⇒ 404（与不可见同形）", gone.status === 404, `status=${gone.status}`);
  const badId = await call("DELETE", `/api/matters/abc`, c);
  ok("路径 id 不是数字 ⇒ 400 bad_id", badId.status === 400 && badId.body?.error === "bad_id", `status=${badId.status}`);

  // ── 8. 归档态允许删除（裁定见 deleteMatter 注释）──
  const archivedCode = await statusCodeOf(c, "matter", "archived");
  const m2 = await mk(`删除冒烟 归档 ${stamp}`);
  matterIds.push(m2.body?.id);
  const arch = await call("POST", `/api/matters/${m2.body.id}/status`, c, {
    to: archivedCode,
    reason: "冒烟：先归档再删",
  });
  ok("建第二条并归档 → 200", arch.status === 200, `status=${arch.status}`);
  const del2 = await call("DELETE", `/api/matters/${m2.body.id}`, c);
  ok("**已归档的案件也能删 → 200**（材料缺项已由 ARCHIVED 结清；删除要的是归属）", del2.status === 200, `status=${del2.status}`);
  const [after2] = await rowOf(m2.body.id);
  ok(
    "删完同样：接口 404 + 库里 is_deleted=true",
    (await call("GET", `/api/matters/${m2.body.id}`, c)).status === 404 && after2?.is_deleted === true,
    `detail=404 库内 is_deleted=${after2?.is_deleted}`,
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

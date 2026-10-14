import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  noteCleanupFailure,
  ROLE_CODES,
} from "./_testacct.mjs";
/**
 * 关注组（MATT-56 / ADR-0003）的端点级冒烟——只走 HTTP，不碰库写。
 *
 * 票面点名的四条断言：自我关注 / 取消 / 看不见的记录关注必被拒 / 计数与名单一致。
 * 外加两道门的设计（ADR-0003 的核心）：
 *   · 自我关注只受「现在能看见这条记录」约束（L2 协办也能关注自己）；
 *   · 给别人加/摘要名单管理权（经办人/L1/创建人）——协办、关注提交他人 id 必须 403。
 * 以及归档只读、幂等跳过、STAFF_CHANGED 审计。
 *
 * 三个账号的真实对撞（照 selectable-users 门禁的形状）：
 *   smoke  = full_admin + is_admin（L1，看全部、能管名单）
 *   smoke2 = joined（L2，能看见自己参与的，但无名单管理权）
 *   smoke3 = self（L3，看不见 smoke 建的那条 → 关注它必被拒）
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

const stamp = Date.now();
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const smoke = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const smoke2 = await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] });
const smoke3 = await createSmokeAccount(sql, { roles: [ROLE_CODES.self] });
const riskIds = [];

async function cleanup() {
  const rids = riskIds.map(BigInt);
  if (rids.length) {
    await sql`delete from mn_activity_log where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter_staff where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
    await sql`delete from mn_risk_matter where id = any(${sql.array(rids)}::bigint[])`;
  }
}

try {
  const l1 = await login(smoke.username, smoke.password);
  ok("L1 登录（管名单的人）", l1.status === 200, `status=${l1.status}`);
  const cookie = l1.cookie;
  const l2 = await login(smoke2.username, smoke2.password);
  const l3 = await login(smoke3.username, smoke3.password);
  ok("L2 登录（无名单管理权）", l2.status === 200, `status=${l2.status}`);
  ok("L3 登录（看不见目标记录）", l3.status === 200, `status=${l3.status}`);

  // smoke 建一条事项（不填经办人 → owner 空；creator = smoke）
  const created = await call("POST", "/api/risk-matters", cookie, {
    name: `关注组冒烟 ${stamp}`,
    type: "contract",
    level: "high",
    description: "冒烟：关注组两道门",
  });
  ok("建事项 → 201", created.status === 201, `status=${created.status}`);
  const riskId = created.body?.id;
  riskIds.push(riskId);

  // ── 断言①：自我关注（L1 关注自己）──
  const self1 = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, cookie, {
    userIds: [String(smoke.id)],
  });
  ok("自我关注 → 200 且 added=1", self1.status === 200 && self1.body?.added === 1, `status=${self1.status} ${JSON.stringify(self1.body)?.slice(0, 60)}`);

  // ── 断言④：计数与名单一致 ──
  const fol1 = await call("GET", `/api/risk-matters/${riskId}/staff/followers`, cookie);
  ok("名单查询 → 200 且含我自己", fol1.status === 200 && fol1.body.some((f) => f.userId === String(smoke.id)), `n=${fol1.body?.length}`);
  const detail1 = await call("GET", `/api/risk-matters/${riskId}`, cookie);
  const followerInDetail = (detail1.body?.staff ?? []).filter((s) => s.staffRole === "follower");
  ok("**计数与名单一致**（详情 staff 里的 follower 数 = 名单接口数）", followerInDetail.length === fol1.body.length, `详情=${followerInDetail.length} 名单=${fol1.body?.length}`);

  // ── 幂等：重复关注自己不报错，added=0 ──
  const selfDup = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, cookie, {
    userIds: [String(smoke.id)],
  });
  ok("重复自我关注 → 200 且 added=0（幂等跳过）", selfDup.status === 200 && selfDup.body?.added === 0, `added=${selfDup.body?.added}`);

  // ── 断言③：看不见的记录关注必被拒（L3 关注这条它没参与的事项 → 404）──
  const invisible = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, l3.cookie, {
    userIds: [String(smoke3.id)],
  });
  ok("**看不见的记录，自我关注 → 404**（ADR-0003 那道可见性门）", invisible.status === 404, `status=${invisible.status}`);
  const [noRow] = await sql`select count(*)::int as n from mn_risk_matter_staff where risk_matter_id=${riskId} and user_id=${String(smoke3.id)}`;
  ok("被拒后没有偷偷写进名单", noRow.n === 0, `n=${noRow.n}`);

  // ── 两道门：L2 也看不见这条（没参与、非 owner/creator）→ 关注自己 404 ──
  const l2self = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, l2.cookie, {
    userIds: [String(smoke2.id)],
  });
  ok("L2 未参与时关注自己 → 404（先过可见性门）", l2self.status === 404, `status=${l2self.status}`);

  // L1 把 smoke2 加为关注人（有管理权 + smoke2 在 L1 可见用户集内）→ 成功
  const addOther = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, cookie, {
    userIds: [String(smoke2.id)],
  });
  ok("L1 添加他人为关注人 → 200 added=1", addOther.status === 200 && addOther.body?.added === 1, `status=${addOther.status} ${JSON.stringify(addOther.body)?.slice(0, 60)}`);

  // 现在 smoke2 是 follower（进 L2 可见性），能看见这条了 → 但**没有名单管理权**
  const l2now = await login(smoke2.username, smoke2.password);
  const l2addOther = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, l2now.cookie, {
    userIds: [String(smoke3.id)],
  });
  ok("**关注人加别人 → 403**（看得见但无管理权，§6）", l2addOther.status === 403, `status=${l2addOther.status}`);
  // 但 smoke2 关注自己（已在名单，幂等）仍允许——自我关注不受管理权约束
  const l2selfAgain = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, l2now.cookie, {
    userIds: [String(smoke2.id)],
  });
  ok("关注人**关注自己** → 200（自我关注不受管理权约束）", l2selfAgain.status === 200, `status=${l2selfAgain.status}`);

  // ── STAFF_CHANGED 审计 ──
  const [audit] = await sql`select count(*)::int as n from mn_activity_log where action='STAFF_CHANGED' and risk_matter_id=${riskId}`;
  ok("参与人变更写 STAFF_CHANGED 审计", audit.n >= 2, `n=${audit.n}`);

  // ── 断言②：取消关注（摘自己）──
  const unfollow = await call(
    "DELETE",
    `/api/risk-matters/${riskId}/staff/followers/${smoke.id}`,
    cookie,
  );
  ok("取消关注（摘自己）→ 200", unfollow.status === 200, `status=${unfollow.status}`);
  const fol2 = await call("GET", `/api/risk-matters/${riskId}/staff/followers`, cookie);
  ok("摘自己后名单里不再有自己", !fol2.body.some((f) => f.userId === String(smoke.id)), `n=${fol2.body?.length}`);
  // smoke2 摘 smoke（非自己、无管理权）→ 403
  const l2removeOther = await call(
    "DELETE",
    `/api/risk-matters/${riskId}/staff/followers/${smoke.id}`,
    l2now.cookie,
  );
  ok("关注人摘**别人** → 403", l2removeOther.status === 403, `status=${l2removeOther.status}`);
  // 摘一个不在名单里的人（幂等成功）
  const removeGhost = await call(
    "DELETE",
    `/api/risk-matters/${riskId}/staff/followers/${smoke3.id}`,
    cookie,
  );
  ok("摘不在名单里的人 → 200（幂等，已是目标态）", removeGhost.status === 200, `status=${removeGhost.status}`);

  // ── 归档只读：归档后关注写一律 403 ──
  const arch = await call("POST", `/api/risk-matters/${riskId}/status`, cookie, {
    to: "archived",
    reason: "冒烟：归档后关注只读",
  });
  ok("归档 → 200", arch.status === 200, `status=${arch.status}`);
  const archFollow = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, cookie, {
    userIds: [String(smoke.id)],
  });
  ok("归档态自我关注 → 403 archived", archFollow.status === 403 && archFollow.body?.error === "archived", `status=${archFollow.status} err=${archFollow.body?.error}`);
  // 但名单**仍可读**（只读终态 ≠ 看不见谁在关注）
  const archRead = await call("GET", `/api/risk-matters/${riskId}/staff/followers`, cookie);
  ok("归档态名单仍可读 → 200", archRead.status === 200, `status=${archRead.status} n=${archRead.body?.length}`);

  // ── 非法输入 ──
  const badBody = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, cookie, {
    userIds: [],
  });
  ok("空 userIds → 400（min 1）", badBody.status === 400, `status=${badBody.status}`);
  const badId = await call("POST", `/api/risk-matters/${riskId}/staff/followers`, cookie, {
    userIds: ["not-a-number"],
  });
  ok("非数字 userId → 400", badId.status === 400, `status=${badId.status}`);
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
  // 逐个独立记：一个账号删不掉不该挡住其余账号（连坐会把整场冒烟变成污染源）
  for (const a of [smoke, smoke2, smoke3]) {
    try {
      await dropSmokeAccount(sql, a.id);
    } catch (e) {
      noteCleanupFailure(`临时账号 ${a.username}（${a.id}）`, e);
    }
  }
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);

import { createSmokeAccount, dropSmokeAccount, finishSmoke, noteCleanupFailure, ROLE_CODES } from "./_testacct.mjs";

/**
 * 投递侧往返成本探针（MATT-76 的**前后对比**用量具）。
 *
 * ## 为什么用"发 K 条评论 → 量一次读"这条路
 *
 * `GET /api/notifications` 会先跑一次完整 pump（`pumpAll` → `consumeOutbox`），
 * 所以"攒 K 条待投递的 outbox，再读一次"就是一次真实的批量消费——
 * 走的是生产那条路（不是复制一份 SQL 来量），因此量到的就是用户要付的代价。
 *
 * ## 为什么量两个收件人档位
 *
 * 本票的论点是"**耗时不该随收件人个数增长**"（原来 6+2N）。
 * 所以固定 K，量 F=1 与 F=5 两档：**若两档接近 ⇒ N+1 已消**；
 * 若 F=5 明显更慢 ⇒ 还有 O(N) 的东西在（比如又回退了逐收件人的查询/插入）。
 *
 * ## 只读约束
 *
 * 它**写**自己的夹具（账号 / 事项 / 评论 / outbox），跑完清场 ——
 * 与其它 smoke 同一姿态。共享 dev 库上**不要与别的冒烟并行跑**。
 *
 * 用法：node --env-file=.env agent-work/probe-outbox-n1.mjs [K] [F]
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const K = Number(process.argv[2] ?? 10);
const F = Number(process.argv[3] ?? 1);

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
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, ms };
}

const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const stamp = Date.now();
const accounts = [];
const riskIds = [];
let admin;

try {
  admin = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
  accounts.push(admin);
  for (let i = 0; i < F; i++) {
    accounts.push(await createSmokeAccount(sql, { roles: [ROLE_CODES.joined] }));
  }

  const l1 = await login(admin.username, admin.password);
  if (l1.status !== 200) throw new Error(`登录失败 status=${l1.status}`);

  const created = await call("POST", "/api/risk-matters", l1.cookie, {
    name: `outbox 成本探针 ${stamp}`,
    type: "contract",
    level: "high",
    description: `F=${F} K=${K}`,
  });
  if (created.status !== 201) throw new Error(`建事项失败 status=${created.status}`);
  const riskId = created.body.id;
  riskIds.push(riskId);

  // 关注人：他们决定每条事件的收件人个数（N）
  for (const acc of accounts.slice(1)) {
    await call("POST", `/api/risk-matters/${riskId}/staff/followers`, l1.cookie, {
      userIds: [String(acc.id)],
    });
  }

  // 先把库里积压清空（否则量到的是别人的盘子）
  await call("GET", "/api/notifications", l1.cookie);

  // 攒 K 条待投递：发 K 条不带 @ 的评论 ⇒ 每条落一行 outbox
  for (let i = 0; i < K; i++) {
    const r = await call("POST", `/api/risk-matters/${riskId}/comments`, l1.cookie, {
      body: `成本探针 ${stamp}-${i}`,
    });
    if (r.status !== 201) throw new Error(`发评论失败 status=${r.status}`);
  }

  const [pending] = await sql`
    select count(*)::int as n from mn_event_outbox o
    where o.published_at is null
      and (o.payload->>'host_type') = 'risk_matter' and (o.payload->>'host_id') = ${riskId}`;

  // 量"一次读消费掉这批"的墙钟
  const read = await call("GET", "/api/notifications", l1.cookie);
  if (read.status !== 200) throw new Error(`读通知中心失败 status=${read.status}`);

  const [after] = await sql`
    select count(*)::int as n from mn_event_outbox o
    where o.published_at is null
      and (o.payload->>'host_type') = 'risk_matter' and (o.payload->>'host_id') = ${riskId}`;

  console.log(
    JSON.stringify(
      {
        K,
        F,
        pendingBefore: pending.n,
        pendingAfter: after.n,
        consumed: pending.n - after.n,
        readMs: Math.round(read.ms),
        msPerRow: Number((read.ms / Math.max(pending.n, 1)).toFixed(1)),
      },
      null,
      2,
    ),
  );
} finally {
  try {
    const rids = riskIds.map(BigInt);
    if (rids.length) {
      await sql`delete from mn_comment where target_type='risk_matter' and target_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_notification_delivery where event_id in (select id from mn_notification_event where host_id = any(${sql.array(rids)}::bigint[]))`;
      await sql`delete from mn_notification_event where host_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_event_outbox where (payload->>'host_type') = 'risk_matter' and (payload->>'host_id') = any(${sql.array(riskIds)}::text[])`;
      await sql`delete from mn_user_watch where target_type='risk_matter' and target_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_activity_log where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_risk_matter_staff where risk_matter_id = any(${sql.array(rids)}::bigint[])`;
      await sql`delete from mn_risk_matter where id = any(${sql.array(rids)}::bigint[])`;
    }
  } catch (e) {
    noteCleanupFailure("outbox 成本探针", e);
  }
  for (const a of accounts) {
    try {
      await dropSmokeAccount(sql, a.id);
    } catch (e) {
      noteCleanupFailure(`探针账号 ${a.id}`, e?.message ?? String(e));
    }
  }
  await sql.end({ timeout: 5 });
}

finishSmoke(0);

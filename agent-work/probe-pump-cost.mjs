/**
 * 调度成本探针（一次性，**只读**）：量 `pumpNotifications()` + `scanArchiveIncomplete()`
 * 在库里实际要付多少代价——为 Q4「定时任务形态」的性能评估拿真数。
 *
 * 为什么值得单独量：读驱动把这两个函数放在 `GET /api/notifications` 的**同步路径**上
 * （`api/notifications/route.ts:54-55`），所以它的成本直接变成用户的等待时间；
 * 而 cron / worker 方案把它挪出请求路径，成本仍在但用户无感。三个方案的性能差异
 * 全在这个数上，猜没有意义。
 *
 * 量的三条查询与服务层**逐字对应**（改一处要改三处）：
 *   1. outbox 待投递扫描   ← services/notifications.ts:782-792（`consumeOutbox`）
 *   2. 节点到期扫描 ×2 宿主 ← services/notifications.ts:907-931（`scanHost`）
 *   3. 规则 9 粗筛          ← services/archive-reminder.ts:170-188
 *
 * 只读：不 INSERT / UPDATE / DELETE。第二条用 EXPLAIN ANALYZE 看执行计划，
 * 以便在"当前数据量很小"时也能判断它随规模怎么长。
 *
 * 用法：node --env-file=.env agent-work/probe-pump-cost.mjs [重复次数]
 */
import { default as postgres } from "postgres";

const REPEAT = Number(process.argv[2] ?? 20);
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

/** 取耗时分布：最小 / 中位 / P95 / 最大（毫秒） */
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    min: +s[0].toFixed(2),
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
  };
}

async function timed(label, query, params = []) {
  // 先跑一次暖连接（不计入），避免首次往返把数拉高
  await sql.unsafe(query, params);
  const samples = [];
  let rows = 0;
  for (let i = 0; i < REPEAT; i++) {
    const t0 = performance.now();
    const r = await sql.unsafe(query, params);
    samples.push(performance.now() - t0);
    rows = r.length;
  }
  return { label, rows, ...stats(samples) };
}

const out = {};

// ── 1. outbox 待投递扫描（consumeOutbox，LIMIT 50）──────────────────────
out.outbox = await timed(
  "outbox 待投递扫描 (LIMIT 50)",
  `select id, event_type, batch_id, payload
     from mn_event_outbox
    where published_at is null
    order by id
    limit 50`,
);

// ── 2. 节点到期扫描 ×2 宿主（scanHost，365 天窗口，LIMIT 500）────────────
// WHERE 与服务层逐字相同：is_time_confirmed + status IN (...) + deadline_time 窗口 + 未删
const NODE_SCAN = (table, fkCol) => `
  select id, ${fkCol}, name, time_type, deadline_time, remind_days, status, is_time_confirmed
    from ${table}
   where is_time_confirmed = true
     and status in ('not_started','in_progress')
     and deadline_time is not null
     and not is_deleted
     and deadline_time >= now()
     and deadline_time <  now() + interval '366 days'
   limit 500`;
out.matterNodes = await timed("节点扫描 · 案件 (mn_matter_node)", NODE_SCAN("mn_matter_node", "matter_id"));
out.riskNodes = await timed("节点扫描 · 事项 (mn_risk_matter_node)", NODE_SCAN("mn_risk_matter_node", "risk_matter_id"));

// ── 3. 规则 9 粗筛（scanArchiveIncomplete，LIMIT 200）───────────────────
out.archiveCandidates = await timed(
  "规则 9 粗筛 (mn_matter, LIMIT 200)",
  `select id, internal_code, name, status, is_archived, is_deleted, closing_date, last_progress_at, updated_at
     from mn_matter
    where status = 'closed' and is_archived = false and not is_deleted
    limit 200`,
);

// ── 4. 数据量现状（解释"上面的数为什么大/为什么小"）────────────────────
const counts = await sql`
  select 'mn_event_outbox' t, count(*)::int n from mn_event_outbox
  union all select 'mn_event_outbox 未投递', count(*)::int from mn_event_outbox where published_at is null
  union all select 'mn_matter_node', count(*)::int from mn_matter_node
  union all select 'mn_matter_node 可扫', count(*)::int from mn_matter_node
    where is_time_confirmed and status in ('not_started','in_progress') and deadline_time is not null and not is_deleted
  union all select 'mn_risk_matter_node', count(*)::int from mn_risk_matter_node
  union all select 'mn_risk_matter_node 可扫', count(*)::int from mn_risk_matter_node
    where is_time_confirmed and status in ('not_started','in_progress') and deadline_time is not null and not is_deleted
  union all select 'mn_matter', count(*)::int from mn_matter
  union all select 'mn_matter closed未归档', count(*)::int from mn_matter where status='closed' and not is_archived and not is_deleted
`;
out.volumes = counts.map((r) => `${r.t} = ${r.n}`);

// ── 5. 执行计划（判断它随规模怎么长，而不是只看当前这一瞬间）────────────
// EXPLAIN 是 utility 语句，不能出现在 union 的子查询里——只能逐条跑。
// 刻意不加 `analyze`：那条查询真的跑一遍会把 EXPLAIN 自身的开销算进来，
// 而我们要看的是"扫了多少页/用了哪个索引"，estimate 那一段就够。
const planOf = async (label, query) => {
  const r = await sql.unsafe(`explain (buffers, format text) ${query}`);
  const txt = r.map((x) => x["QUERY PLAN"]).join("\n");
  return `── ${label} ──\n${txt}`;
};
out.plans = [
  await planOf(
    "节点扫描 mn_matter_node",
    NODE_SCAN("mn_matter_node", "matter_id"),
  ),
  await planOf(
    "outbox 待投递",
    `select id from mn_event_outbox where published_at is null order by id limit 50`,
  ),
];

await sql.end();

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n=== 调度成本探针（每条查询 ${REPEAT} 次，单位 ms）===\n`);
const rows = [out.outbox, out.matterNodes, out.riskNodes, out.archiveCandidates];
console.log(pad("查询", 34) + pad("行数", 7) + pad("min", 9) + pad("p50", 9) + pad("p95", 9) + "max");
console.log("─".repeat(78));
for (const r of rows) {
  console.log(
    pad(r.label, 34) + pad(r.rows, 7) + pad(r.min, 9) + pad(r.p50, 9) + pad(r.p95, 9) + r.max,
  );
}
const sum = rows.reduce((a, r) => a + r.p50, 0);
console.log("─".repeat(78));
console.log(`p50 合计（一次 pump 的 SQL 侧成本）≈ ${sum.toFixed(2)} ms\n`);

console.log("=== 数据量现状 ===");
for (const v of out.volumes) console.log("  " + v);

console.log("\n=== 执行计划 ===");
for (const p of out.plans) console.log(p + "\n");

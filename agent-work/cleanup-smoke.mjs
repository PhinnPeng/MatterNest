/**
 * 清掉历次崩溃/中断的 smoke 留下的残骸。
 *
 * 只按**冒烟命名特征**删，不碰真实数据。删除顺序按外键拓扑：
 * 活动日志/outbox → 关联表 → 从属表 → 宿主 → 当事人。顺序错了就清不掉。
 *
 * 为什么需要这个脚本：smoke 的清场在 `finally` 里，但**进程被杀掉**时 finally 不跑。
 * 残骸会撑大列表、让分页断言假红（本次就撞到过）。
 *
 * 拼接方式：`postgres.js` 的 fragment 没有 `join`，所以拼成一段带 `$n` 占位符的
 * SQL 文本 + 参数数组。被拼进文本的只有**列名**（`clause` 的实参写死），
 * 所有值走占位符，没有注入面。
 */
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST, port: Number(process.env.PGPORT),
  user: process.env.PGUSER, database: process.env.PGDATABASE, password: process.env.PGPASSWORD,
});

const names = ["%冒烟%", "%T1 %", "%转案件冒烟%", "%建时%", "%探针%"];
const clause = (col) => names.map((_, i) => `${col} like $${i + 1}`).join(" or ");

const risks = (await sql.unsafe(`select id from mn_risk_matter where ${clause("name")}`, names)).map((r) => r.id);
const matters = (await sql.unsafe(`select id from mn_matter where ${clause("name")}`, names)).map((r) => r.id);

if (risks.length) {
  const a = risks;
  await sql`delete from mn_activity_log where risk_matter_id = any(${sql.array(a)}::bigint[])`;
  await sql`delete from mn_event_outbox where payload->>'risk_matter_id' = any(${sql.array(a.map(String))}::text[])`;
  await sql`delete from mn_comment where target_type='risk_matter' and target_id = any(${sql.array(a)}::bigint[])`;
  await sql`delete from mn_risk_matter_node where risk_matter_id = any(${sql.array(a)}::bigint[])`;
  await sql`delete from mn_risk_matter_staff where risk_matter_id = any(${sql.array(a)}::bigint[])`;
  await sql`delete from mn_risk_matter_party where risk_matter_id = any(${sql.array(a)}::bigint[])`;
  await sql`delete from mn_risk_matter_case where risk_matter_id = any(${sql.array(a)}::bigint[])`;
  const n = (await sql`delete from mn_risk_matter where id = any(${sql.array(a)}::bigint[]) returning id`).length;
  console.log(`  删事项 ${n} 条`);
}

if (matters.length) {
  const a = matters;
  await sql`delete from mn_activity_log where matter_id = any(${sql.array(a)}::bigint[])`;
  await sql`delete from mn_comment where target_type='matter' and target_id = any(${sql.array(a)}::bigint[])`;
  await sql`delete from mn_risk_matter_case where matter_id = any(${sql.array(a)}::bigint[])`;
  await sql`delete from mn_matter_progress where matter_id = any(${sql.array(a)}::bigint[])`;
  await sql`delete from mn_matter_node where matter_id = any(${sql.array(a)}::bigint[])`;
  await sql`delete from mn_matter_staff where matter_id = any(${sql.array(a)}::bigint[])`;
  await sql`delete from mn_matter_party where matter_id = any(${sql.array(a)}::bigint[])`;
  const n = (await sql`delete from mn_matter where id = any(${sql.array(a)}::bigint[]) returning id`).length;
  console.log(`  删案件 ${n} 条`);
}

// 当事人：只删冒烟命名且**已无任何宿主引用**的，否则会拆掉真实案件的当事人
const np = (
  await sql.unsafe(
    `delete from mn_party p
     where ${names.map((_, i) => `p.name like $${i + 1}`).join(" or ")}
       and not exists (select 1 from mn_matter_party mp where mp.party_id = p.id)
       and not exists (select 1 from mn_risk_matter_party rp where rp.party_id = p.id)
     returning id`,
    names,
  )
).length;
console.log(`  删当事人 ${np} 条`);

const left = (
  await sql`select
    (select count(*)::int from mn_matter where not is_deleted) as m,
    (select count(*)::int from mn_risk_matter where not is_deleted) as r,
    (select count(*)::int from mn_party) as p,
    (select count(*)::int from mn_event_outbox) as o`
)[0];
console.log(`  剩余：案件 ${left.m} · 事项 ${left.r} · 当事人 ${left.p} · outbox ${left.o}`);
await sql.end();
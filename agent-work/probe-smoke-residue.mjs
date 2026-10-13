/**
 * 冒烟残留探针（MATT-58 / T4b 的 ③ 带来的工具）。
 *
 * 回答一个**症状会出现在别处**的问题：「上一次冒烟崩了之后，库里留下了什么？」
 *
 * 为什么值得单独一个脚本：残留的形态是"4 个 `mn_smoke_*` 账号（其中一个是 `is_admin`）
 * 躺在 `mn_app_user` 里"，而**症状出现在 `db:check` 的 C14**（残留账号检查）——
 * 排查的人会先去查 C14 那条检查项，而根因在他根本没跑过的冒烟脚本上。
 * 一个能直接问"库里还有没有残留"的命令，比"再跑一遍 db:check 看红不红"快得多。
 *
 * 跑法：node --env-file=.env agent-work/_probe-smoke-residue.mjs
 * （只读，不删任何东西——清场是冒烟脚本自己的职责，见 `smoke-notifications.mjs` 的 cleanup）
 */
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const [accounts] = await sql`
  select count(*)::int as total,
         count(*) filter (where is_admin)::int as admins,
         min(created_at) as oldest
  from mn_app_user where username like 'mn_smoke_%'`;
const [orphanEvents] = await sql`
  select count(*)::int as n from mn_notification_event e
  where not exists (select 1 from mn_matter m where m.id = e.host_id)
    and not exists (select 1 from mn_risk_matter r where r.id = e.host_id)`;
const [orphanOutbox] = await sql`
  select count(*)::int as n from mn_event_outbox o
  where o.published_at is null
    and (o.payload->>'risk_matter_id' is not null or o.payload->>'host_id' is not null)`;

console.log(`临时账号 mn_smoke_*：${accounts.total}（其中 is_admin=${accounts.admins}）`);
if (accounts.total > 0) console.log(`  最早一个建于 ${accounts.oldest}`);
console.log(`孤儿通知事件（宿主已不存在）：${orphanEvents.n}`);
console.log(`未投递的 outbox 行：${orphanOutbox.n}`);
console.log(
  accounts.total === 0 && orphanEvents.n === 0
    ? "→ 干净：上一次冒烟清场跑到了（或压根没跑过）"
    : "→ **有残留**：上一次冒烟中途崩了而清场没跑，先看 db:check 的 C14",
);

await sql.end();

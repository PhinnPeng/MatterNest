/**
 * 规模探针（一次性）：**1000 行**（schema 上限）时这条链路要多久、计数对不对。
 *
 * 为什么单独跑：`smoke-import.mjs` 的夹具是十来行，验的是口径不是规模。
 * 而这一票的风险恰恰是"批量"—— 三年历史账一次导入，如果 1000 行要跑十分钟，
 * 那这条链路在真实使用里是坏的（用户的 HTTP 请求早就断了，批次会停在 `running`）。
 * 所以这里量一个真数：**上限行数下的墙钟时间**，以及结束后计数是否仍然自洽。
 *
 * 用法：node --env-file=.env agent-work/probe-import-scale.mjs [行数]
 */
import { createSmokeAccount, dropSmokeAccount, ROLE_CODES } from "./_testacct.mjs";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const ROWS = Number(process.argv[2] ?? 1000);
const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

const admin = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], isAdmin: true });
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: admin.username, password: admin.password }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

const tplRes = await fetch(`${BASE}/api/import/templates?hostType=party`, { headers: { cookie } });
const tpl = (await tplRes.json()).csv;
const header = tpl.replace(/^\uFEFF/, "").split("\r\n")[0].split(",");
const stamp = Date.now();
const P = `规模探针${stamp}`;

// 一半规规矩矩、一半故意带错（33% 的坏行），让"逐行跳过"也在规模下被走到
const lines = [];
for (let i = 1; i <= ROWS; i++) {
  const bad = i % 3 === 0;
  lines.push(
    [
      bad ? "短" : `${P}-${i}`,
      bad ? "法人" : "法人",
      "统一社会信用代码",
      `91${stamp}${String(i).padStart(4, "0")}`,
      "",
      "",
    ].join(","),
  );
}
const csv = `${tpl}\r\n${lines.join("\r\n")}`;
console.log(`文件 ${ROWS} 行，字符数 ${csv.length}（上限 2000000）`);

const t0 = Date.now();
const res = await fetch(`${BASE}/api/import`, {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ hostType: "party", fileName: `${P}.csv`, csv }),
});
const t1 = Date.now();
const body = await res.json();
const wall = ((t1 - t0) / 1000).toFixed(1);

console.log(`HTTP ${res.status} · 墙钟 ${wall}s`);
console.log(
  `total=${body.totalRows} imported=${body.importedRows} error=${body.errorRows} ` +
    `恒等式=${body.totalRows === body.importedRows + body.errorRows} issues返回=${body.issues?.length}/${body.issueTotal}`,
);
const [db] = await sql`select count(*)::int as n from mn_party where name like ${`${P}%`}`;
console.log(`库里实际新增 ${db.n} 行（应等于 imported）`);
const [batch] = await sql`
  select status, total_rows, imported_rows, error_rows from mn_import_batch where id = ${body.batchId}`;
console.log(`批次 ${JSON.stringify(batch)}`);
const [rows] = await sql`
  select count(*)::int as n from mn_import_row where batch_id = ${body.batchId}`;
console.log(`逐行记录 ${rows.n} 条（应等于 total）`);
console.log(`每行平均 ${(Number(wall) * 1000 / ROWS).toFixed(0)} ms`);

// 清场
const ids = (await sql`select id from mn_party where name like ${`${P}%`}`).map((r) => r.id);
if (ids.length) await sql`delete from mn_party where id in ${sql(ids)}`;
await sql`delete from mn_import_batch where id = ${body.batchId}`;
await dropSmokeAccount(sql, admin.id);
await sql.end();

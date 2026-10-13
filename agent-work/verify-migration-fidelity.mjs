/**
 * 核实：库里那 7 张新表的**真实结构**与迁移文件声明的是否一致。
 *
 * 起因：两个实现子代理**绕过了 `pnpm db:migrate`** 手工建表（`agent-work/_apply_0010.mjs`、
 * `_apply-0011.mjs`），所以表在库里、但 `drizzle.__drizzle_migrations` 没有它们的账。
 * 直接把账记上去有个前提：**库里的表必须真的等于文件声明的**——
 * 否则账本是假的，而账本一假，以后没人知道库里到底是什么结构。
 *
 * 这里不猜：从迁移文件里把每张表的列名抠出来，与 `information_schema.columns` 逐张比对。
 * 一致 ⇒ 记 ledger 是诚实的；不一致 ⇒ 必须删表重建。
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const FILES = [
  "src/app/lib/server/db/migrations/0010_notification_pipeline.sql",
  "src/app/lib/server/db/migrations/0011_expenses_and_expense_items.sql",
];

/** 从 `CREATE TABLE [IF NOT EXISTS] "x" ( ... );` 里抠列名（跳过约束行与注释行） */
function parseTables(sqlText) {
  const out = new Map();
  const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"([a-z_]+)"\s*\(([\s\S]*?)\n\);/gi;
  for (const m of sqlText.matchAll(re)) {
    const [, table, body] = m;
    const cols = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("--")) continue;
      const col = line.match(/^"([a-z_]+)"\s/);
      // 约束行（CONSTRAINT / PRIMARY KEY / UNIQUE / FOREIGN / CHECK）不算列
      if (col && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(line)) cols.push(col[1]);
    }
    out.set(table, cols);
  }
  return out;
}

const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

let bad = 0;
for (const f of FILES) {
  const declared = parseTables(readFileSync(f, "utf8"));
  console.log(`\n=== ${f}（声明 ${declared.size} 张表）===`);
  for (const [table, cols] of declared) {
    const rows = await sql`
      select column_name from information_schema.columns
       where table_name = ${table} order by ordinal_position`;
    const actual = rows.map((r) => r.column_name);
    if (actual.length === 0) {
      console.log(`  [FAIL] ${table}：库里**不存在**`);
      bad += 1;
      continue;
    }
    const missing = cols.filter((c) => !actual.includes(c));
    const extra = actual.filter((c) => !cols.includes(c));
    if (missing.length || extra.length) {
      console.log(
        `  [FAIL] ${table}：声明 ${cols.length} 列 / 实有 ${actual.length} 列` +
          (missing.length ? ` · 库里缺 ${missing.join(",")}` : "") +
          (extra.length ? ` · 库里多 ${extra.join(",")}` : ""),
      );
      bad += 1;
    } else {
      console.log(`  [ ok ] ${table}：${cols.length} 列逐一对上`);
    }
  }
}

// 顺带把约束也数一遍（列对上但约束缺了同样是"账本不诚实"）
const cons = await sql`
  select conrelid::regclass::text as t, count(*)::int as n
    from pg_constraint
   where conrelid::regclass::text in
     ('mn_notification_template','mn_notification_event','mn_notification_delivery','mn_user_watch',
      'mn_expense_item_config','mn_matter_expense','mn_risk_matter_expense')
   group by 1 order by 1`;
console.log("\n=== 约束数 ===");
for (const c of cons) console.log(`  ${c.t}: ${c.n}`);

await sql.end();
console.log(`\n${bad === 0 ? "一致 ⇒ 记 ledger 是诚实的" : `${bad} 张表对不上 ⇒ 必须删表重建`}`);
process.exit(bad === 0 ? 0 : 1);

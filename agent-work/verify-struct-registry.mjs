/**
 * 结构注册表审计：`IN_DB_CHECKS` 里登记的每一条 `[表, 列, 约束]`，**在库里真的存在吗**？
 *
 * ## 为什么要有它
 *
 * 本仓把"值域"登记在 `src/shared/enums/index.ts` 的 `IN_DB_CHECKS` 里（一条 id →
 * 若干 `[table, column, constraint]` 三元组），再由 `enum-check.spec.ts` 双向核对
 * "注册表 ↔ 迁移文件里的 CHECK"。
 *
 * 但那套核对是**静态的**：它比的是"迁移文件里写的"与"注册表里登记的"，
 * **两边可以一起漂移而没人发现**——最典型的形态就是 MATT-43 迁移头注里记的那句：
 *
 *   > `STRUCT_REGISTRY` 从 T0 起就登记着 `automation_rule.trigger_type` / `action_type`，
 *   > 一直是"**值域在代码里、表还没建**"的状态。
 *
 * 也就是说：**登记表说"这个值域在库里由某约束守着"，而那张表根本不存在** ——
 * 从 T0 到 MATT-43 之间一直如此，没有任何门禁会红。
 *
 * 本脚本把这条补上：把注册表里的每个三元组拿到**真库**里去问一次。
 *
 * ## 判据
 *
 *   · 表不存在 → 记 `缺表`（最严重：整条登记是空头支票）
 *   · 表在、列不在 → 记 `缺列`
 *   · 表列都在、约束不在 → 记 `缺约束`
 *
 * 用法：`node --env-file=.env agent-work/verify-struct-registry.mjs`
 */
import { readFileSync } from "node:fs";

const { default: postgres } = await import("postgres");

const src = readFileSync("src/shared/enums/index.ts", "utf8");
/**
 * ⚠ 别用 `indexOf("IN_DB_CHECKS")` —— 文件**开头那段注释里**也提到这个名字，
 * 而注释在声明之前，`indexOf` 会命中注释、块提取当场落空（实测解析出 0 条，
 * 脚本还"PASS"了 —— **一个静默空转的门禁**，正是本仓最怕的形状）。
 * 所以按**声明形态**定位，并要求真的找到。
 */
const decl = /export const IN_DB_CHECKS[^=]*=\s*\{/.exec(src);
if (!decl) {
  console.error("找不到 IN_DB_CHECKS 的声明 —— 脚本要跟着文件结构调整");
  process.exit(2);
}
const start = decl.index + decl[0].length - 1; // 指向 `{`
// 从 `{` 起做花括号配对，找到对象真正的结尾（比找 "\n};" 稳）
let depth = 0;
let end = -1;
for (let i = start; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") {
    depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
}
if (end < 0) {
  console.error("IN_DB_CHECKS 的花括号没有配对 —— 文件结构异常");
  process.exit(2);
}
const block = src.slice(start, end + 1);

/**
 * `E02: [["t","c","k"], ...]` 或 `"some.id": [...]` —— **键可能带引号也可能不带**
 * （文件里两种都有）。第一版只写了带引号的那种，于是解析出 0 条而脚本照样 PASS。
 */
const triples = [];
for (const m of block.matchAll(/(?:^|[\s,])(?:"([^"]+)"|([A-Za-z_][\w.]*)):\s*\[([\s\S]*?)\n?\s*\](?=,|\s*\n\s*(?:"|[A-Za-z_]|$))/gm)) {
  const id = m[1] ?? m[2];
  for (const t of m[3].matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g)) {
    triples.push({ id, table: t[1], column: t[2], constraint: t[3] });
  }
}

/**
 * ⚠ **自查：解析出 0 条不算通过。**
 *
 * 这条是后加的 —— 第一版的正则没匹配上（键不带引号），脚本打印了
 * "注册表里登记了 0 条结构落点 / PASS：0 条登记"，**一个静默空转的门禁**。
 * 这正是本仓反复在抓的那一类（假红与假绿是同一个病）：门禁看起来绿了，
 * 但它什么也没检查。任何"从源码里抠出清单"的脚本都该有这一条。
 */
if (triples.length === 0) {
  console.error(
    "🔴 解析出 0 条结构落点 —— **这不是通过，是脚本没读懂文件**。\n" +
      "   请对照 src/shared/enums/index.ts 的 IN_DB_CHECKS 调整正则，别让这条门禁空转。",
  );
  process.exit(2);
}

const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
});

console.log(`注册表里登记了 ${triples.length} 条结构落点\n`);

const missingTable = [];
const missingColumn = [];
const missingConstraint = [];

for (const t of triples) {
  const [tab] = await sql`
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = ${t.table} limit 1`;
  if (!tab) {
    missingTable.push(t);
    continue;
  }
  const [col] = await sql`
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = ${t.table} and column_name = ${t.column} limit 1`;
  if (!col) {
    missingColumn.push(t);
    continue;
  }
  const [con] = await sql`
    select 1 from pg_constraint where conname = ${t.constraint} limit 1`;
  if (!con) missingConstraint.push(t);
}

const report = (title, rows) => {
  console.log(`${title}：${rows.length} 条`);
  for (const r of rows) console.log(`  ${r.id} → ${r.table}.${r.column} / ${r.constraint}`);
};

const okOnes = triples.filter(
  (t) =>
    !missingTable.includes(t) && !missingColumn.includes(t) && !missingConstraint.includes(t),
);
report("✅ 三条齐全", okOnes);
report("🔴 缺表（整条登记是空头支票）", missingTable);
report("🟡 缺列", missingColumn);
report("🟠 缺约束", missingConstraint);

const ok = missingTable.length === 0 && missingColumn.length === 0 && missingConstraint.length === 0;
console.log(
  `\n${ok ? "PASS" : "FAIL"}：${triples.length} 条登记，` +
    `${triples.length - missingTable.length - missingColumn.length - missingConstraint.length} 条在库里成立`,
);
await sql.end();
process.exit(ok ? 0 : 1);

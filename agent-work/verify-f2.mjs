/**
 * F2 的行为验证（真改真回滚）：
 *   1. 把 `wangkf` 的口令改成一个临时新值
 *   2. 重放 seed
 *   3. 断言库里现值**没被 seed 打回**成演示口令 —— 这正是修复前的行为
 *   4. 还原成原值
 *
 * 为什么要真改真回滚而不是只比对前后哈希：
 * 只比"没变"的话，修好与根本没动过这个列**看起来一样**。改一个已知不同的值再重放，
 * 才真的能区分「不再写入」与「写的是同一个值」。
 *
 * 全程不打印哈希值本身，只打印相等/不等。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { default: postgres } = await import("postgres");
const sql = postgres({
  host: process.env.PGHOST, port: Number(process.env.PGPORT),
  user: process.env.PGUSER, database: process.env.PGDATABASE, password: process.env.PGPASSWORD,
});

// 原值从 seed 文件里取（它就在仓库里，本来就是公开的演示凭据）
const seed = readFileSync("src/app/lib/server/db/seed/0001_identity.sql", "utf8");
const m = seed.match(/\(101,\s*'wangkf',\s*'[^']*',\s*'([0-9a-f]+)'/);
if (!m) { console.error("未能从 seed 解析出 wangkf 的演示摘要"); process.exit(2); }
const demoHash = m[1];

const TEMP_HASH = "f".repeat(128); // 一个与演示值一定不同的占位（列只存字符串，不校验）
const U = "wangkf";

const readHash = async () =>
  (await sql`select password_hash as h from mn_app_user where username=${U}`)[0]?.h;

let fail = 0;
const ok = (n, c, d = "") => {
  if (c) console.log(`[ ok ] ${n}${d ? " — " + d : ""}`);
  else { fail++; console.log(`[FAIL] ${n}${d ? " — " + d : ""}`); }
};

const before = await readHash();
ok("能读到基线值", typeof before === "string" && before.length > 0, `长度 ${before?.length}`);

try {
  // 1. 改成一个临时值（模拟"生产改过口令"）
  await sql`update mn_app_user set password_hash=${TEMP_HASH} where username=${U}`;
  ok("已把口令改成临时值", (await readHash()) === TEMP_HASH);

  // 2. 重放 seed
  execSync("node tools/migrate.mjs --seed-only", {
    env: { ...process.env, MN_DB_CONFIRM: process.env.PGDATABASE },
    stdio: "pipe",
  });

  // 3. 关键断言：seed 不该碰它
  const after = await readHash();
  ok("重放 seed 后口令**没有被改写**（F2 的核心断言）", after === TEMP_HASH,
     after === TEMP_HASH ? "仍是临时值 ✓" : `被改成了别的值（长度 ${after?.length}）`);
  ok("也没有被打回演示口令", after !== demoHash, after === demoHash ? "⚠ 被打回了" : "未被打回 ✓");
} finally {
  // 4. 还原（不留临时值在库里）
  await sql`update mn_app_user set password_hash=${demoHash} where username=${U}`;
  const restored = await readHash();
  ok("已还原成 seed 里的演示摘要", restored === demoHash);
  await sql.end();
}

console.log(`\n${fail ? "FAIL" : "PASS"}：${fail ? "F2 未修好" : "F2 修复已验证"}`);
process.exit(fail ? 1 : 0);
/**
 * 迁移执行器（W0-4）。部署期由 compose 的 migrator 一次性服务调用（技术选型 §3.2c），
 * 应用副本本身不跑迁移 —— 多副本抢跑迁移的问题因此结构性消失。
 *
 * 三层保护，都不是"保险起见"：
 *   1. **库名确认**：`MN_DB_CONFIRM` 必须与 `current_database()` 逐字相等，否则拒跑。
 *      共享实例上同时挂着别的项目的库（本机实测：`dev_sy_identity` 与 `dev_matternest` 同端口），
 *      连错库跑迁移是这里唯一不可逆的事故。
 *   2. **advisory lock**：入口先 `pg_advisory_lock(hashtext('matternest:migrator'))`（阻塞式），
 *      两个人同时 `db:migrate` 也只会有一个真在改表。
 *   3. **事务**：drizzle 的 migrate 把整个批次包在一个事务里（`pg-core/dialect.js` 的
 *      `session.transaction`），而 `pnpm db:check` 的 C8 已实测这台库支持事务内 DDL 回滚。
 *
 * seed 是数据迁移（修订稿 §2.3）：只允许幂等语句，所以每次全量重放、不记账本 ——
 * 记账本会让"改了 seed 没生效"变成静默失败，而重放会当场报错。
 *
 * 用法：`pnpm db:migrate`（只跑迁移）· `pnpm db:seed`（只放 seed）· 二者都带 `MN_DB_CONFIRM=<库名>`
 */
import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const LOCK_KEY = "matternest:migrator";
const MIGRATIONS = "src/app/lib/server/db/migrations";
const SEEDS = "src/app/lib/server/db/seed";

process.loadEnvFile();
const mode = process.argv.includes("--seed-only")
  ? "seed"
  : process.argv.includes("--migrate-only")
    ? "migrate"
    : "both";

const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 1,
  connect_timeout: 8,
  onnotice: () => {},
});

function die(msg) {
  console.error(`migrator 中止：${msg}`);
  process.exitCode = 1;
}

try {
  const [who] = await sql`select current_database() as db`;
  const confirm = process.env.MN_DB_CONFIRM ?? "";
  if (!confirm) {
    die(
      `必须显式给 MN_DB_CONFIRM=<目标库名>（当前会连的是 ${who.db}）。这是防止在共享实例上连错库跑迁移的闸门。`,
    );
    throw new Error("no-confirm");
  }
  if (confirm !== who.db) {
    die(`MN_DB_CONFIRM=${confirm} 与实际连接的 ${who.db} 不一致`);
    throw new Error("db-mismatch");
  }
  console.log(`migrator → 目标库 ${who.db}（已确认）mode=${mode}`);

  // 阻塞式锁：拿不到就一直等，等到的那个才改表
  const [lock] =
    await sql`select hashtext(${LOCK_KEY}) as k, pg_advisory_lock(hashtext(${LOCK_KEY})) as ok`;
  console.log(`advisory lock 已取得：${LOCK_KEY}（key=${lock.k}）`);

  if (mode !== "seed") {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
    const [row] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    console.log(`迁移完成：ledger drizzle.__drizzle_migrations 现有 ${row.n} 条`);
  }

  if (mode !== "migrate") {
    const files = readdirSync(SEEDS)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      const text = readFileSync(`${SEEDS}/${f}`, "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
      });
      console.log(`seed 已重放：${f}`);
    }
    if (files.length === 0) die("seed 目录为空——这不正常，检查落点");
  }

  await sql`select pg_advisory_unlock(hashtext(${LOCK_KEY}))`;
  console.log("migrator 通过");
} catch (e) {
  if (e?.message !== "no-confirm" && e?.message !== "db-mismatch") die(e?.message ?? String(e));
  try {
    await sql`select pg_advisory_unlock(hashtext(${LOCK_KEY}))`;
  } catch {
    /* 连接可能已断 */
  }
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(process.exitCode ?? 0);

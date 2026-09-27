/**
 * 数据库连通性与口径自检（W0-5 前置，2026-09-27）。
 *
 * 为什么需要：`.env.example` 里那组 PG* 参数是"照抄同级项目的写法"，没人证明过
 * **这台机、这个角色、这个库**真的能连上、且口径符合规格件。凭据走共享 dev 机的
 * GameViewer 端口映射，映射一断、或角色默认时区被人改回去，都要等到写迁移时才炸。
 * 所以这里不只测"能不能连"，还把三条纸面规矩变成可重复运行的断言。
 *
 * 用法：`pnpm db:check`（**故意不进 `pnpm verify`** —— verify 必须离线可跑）
 * 退出码：0 全部通过；1 有断言失败或连不上。
 *
 * 只读 + 回滚：唯一的写操作是 C8 的 `CREATE TEMP TABLE`，跑在会抛错回滚的事务里，
 * 会话结束也会自行消失；跑完库里不会留下任何对象。全程不打印密码。
 *
 * 断言（任一失败即 exit 1）：
 *   C1 能连上（失败时给出映射口/凭据的排查方向）
 *   C2 服务端版本 ≥ 15（技术选型 §4「数据库」行：PostgreSQL 15+）
 *   C3 连的是预期库、角色是自己、且**不是超级用户**
 *   C4 会话时区 = UTC（修订稿 §12.3 靠 role 级 `ALTER ROLE … SET timezone` 落地）
 *   C5 client_encoding = UTF8（中文文案与全文检索的前提）
 *   C6 日界口径：`::date` 与 `AT TIME ZONE 'Asia/Shanghai'` 结果不同 → 证明禁用 `now()::date`
 *   C7 bigint 服务端往返精确；C7b 回报驱动把 int8 解析成了什么（P1-19 的由来）
 *   C8 事务内 DDL 可回滚（W0-4 迁移的执行姿势）
 */

const MIN_MAJOR = 15;
const TARGET_TZ = "UTC";
const ID_SAMPLE = "1798234567890123456"; // 2^60 量级，JS number 存不下

const results = [];
/** 记录一条断言：ok=通过 fail=失败 info=只回报不断言 */
function record(kind, id, msg) {
  results.push({ kind, id });
  const mark = kind === "ok" ? "[ ok ]" : kind === "info" ? "[info ]" : "[FAIL]";
  console.log(`${mark} ${id} ${msg}`);
}

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

// ---- 读 .env（不引入 dotenv：Node 22 自带 loadEnvFile，见 engines 钉版本）----
try {
  process.loadEnvFile();
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  console.error("找不到 .env。先执行：cp .env.example .env 并填入 PGPASSWORD。");
  console.error("（.env 已在 .gitignore 内，禁止提交；本脚本不落盘、不打印密码）");
  process.exit(1);
}

const pg = {
  host: env("PGHOST", "127.0.0.1"),
  port: Number(env("PGPORT", "30432")),
  database: env("PGDATABASE"),
  username: env("PGUSER"),
  password: env("PGPASSWORD"),
};

if (!pg.database || !pg.username) {
  console.error("PGDATABASE / PGUSER 为空，无法自检。检查 .env。");
  process.exit(1);
}
if (!/^dev_/.test(pg.database)) {
  console.error(
    `拒绝对非 dev 库自检：PGDATABASE=${pg.database}（C8 会跑 DDL 探针，只允许 dev_* 库）`,
  );
  process.exit(1);
}

console.log(`db:check → ${pg.host}:${pg.port} db=${pg.database} user=${pg.username}`);

let postgres;
try {
  postgres = (await import("postgres")).default;
} catch {
  console.error("缺依赖 postgres（postgres.js）：pnpm add postgres");
  process.exit(1);
}

/** C8 的哨兵异常：抛出来让 sql.begin 自动回滚，好与真失败区分 */
class Rollback extends Error {}

const sql = postgres({
  hostname: pg.host,
  port: pg.port,
  database: pg.database,
  username: pg.username,
  password: pg.password,
  max: 1,
  connect_timeout: 5,
  ssl: false,
  onnotice: () => {},
});

let aborted = null;
try {
  // ---- C1 连通性 ----
  try {
    await sql`select 1`;
    record("ok", "C1", `连上 ${pg.host}:${pg.port} db=${pg.database}`);
  } catch (e) {
    throw new Error(
      `C1 连不上：${e.message}\n` +
        "     排查：① GameViewer 共享机客户端是否在跑（映射只监听 127.0.0.1，别连 172.16.70.100）；" +
        "② PGPASSWORD 是否正确；③ 角色/库是否存在（开通步骤见 spec/backend/database-guidelines.md）",
      { cause: e },
    );
  }

  // ---- C2 版本 ----
  const ver = (
    await sql`select current_setting('server_version') as v,
                    split_part(current_setting('server_version'), '.', 1)::int as major`
  )[0];
  record(
    Number(ver.major) >= MIN_MAJOR ? "ok" : "fail",
    "C2",
    `server_version = ${ver.v}（要求 ≥ ${MIN_MAJOR}，技术选型 §4「数据库」行）`,
  );

  // ---- C3 库 / 角色 / 非超级用户 ----
  const who = (
    await sql`select current_database() as db, current_user as usr,
                    (select rolsuper from pg_roles where rolname = current_user) as super`
  )[0];
  record(
    who.db === pg.database && who.usr === pg.username && who.super !== true ? "ok" : "fail",
    "C3",
    `current_database=${who.db} current_user=${who.usr} rolsuper=${who.super}` +
      (who.super === true ? " ← 应用角色不该是超级用户，改用专用 role" : ""),
  );

  // ---- C4 会话时区 ----
  const tz = (await sql`select current_setting('timezone') as tz`)[0].tz;
  record(
    tz.toUpperCase() === TARGET_TZ ? "ok" : "fail",
    "C4",
    `SHOW timezone = ${tz}` +
      (tz.toUpperCase() === TARGET_TZ
        ? "（role 级默认值生效 ⇒ 隐式转换与文本往返确定）"
        : ` ← 未钉 ${TARGET_TZ}：ALTER ROLE ${pg.username} SET timezone='${TARGET_TZ}'; 后重连`),
  );

  // ---- C5 编码 ----
  const enc = (await sql`select current_setting('client_encoding') as enc`)[0].enc;
  record(enc.toUpperCase() === "UTF8" ? "ok" : "fail", "C5", `client_encoding = ${enc}`);

  // ---- C6 日界口径（修订稿 §12.3 新增硬口径的实机证据）----
  // 2026-09-27 02:00+08 == 2026-09-26 18:00 UTC：::date 落到前一天，AT TIME ZONE 落到当天。
  const day = (
    await sql`select (timestamp with time zone '2026-09-27 02:00:00+08')::date::text as naive,
                    (timestamp with time zone '2026-09-27 02:00:00+08'
                       at time zone 'Asia/Shanghai')::date::text as sh`
  )[0];
  record(
    day.naive === "2026-09-26" && day.sh === "2026-09-27" ? "ok" : "fail",
    "C6",
    `同一跨零点时刻：now()::date → ${day.naive}，AT TIME ZONE 'Asia/Shanghai' → ${day.sh}` +
      (day.naive !== day.sh
        ? "（两者不同 ⇒ day_key 必须显式 AT TIME ZONE，禁 current_date / now()::date）"
        : " ← 与本会话时区假设不符，先查 C4"),
  );

  // ---- C7 bigint 往返 + 驱动的 int8 解析行为（P1-19）----
  const big = (
    await sql`select (${ID_SAMPLE}::bigint)::text as as_text, ${ID_SAMPLE}::bigint as raw`
  )[0];
  record(big.as_text === ID_SAMPLE ? "ok" : "fail", "C7", `服务端 bigint 往返 = ${big.as_text}`);
  const rawText = typeof big.raw === "bigint" ? big.raw.toString() : String(big.raw);
  record(
    rawText === ID_SAMPLE ? "ok" : "info",
    "C7b",
    `驱动把 int8 解析为 ${typeof big.raw}（${rawText}）` +
      (rawText === ID_SAMPLE
        ? " —— 无损，DTO 仍建议出 string"
        : " —— **精度已丢**，印证 P1-19：bigint id 必须在 DTO 里转 string（查询时用 ::text）"),
  );

  // ---- C8 事务内 DDL 可回滚 ----
  // 表名写死在 SQL 文本里：postgres.js 里 `${}` 是**参数**，不能拿来传标识符。
  let c8 = "temp DDL 随事务回滚消失";
  try {
    await sql.begin(async (tx) => {
      await tx`create temp table __dbcheck_probe (id bigint primary key)`;
      const rows = await tx`insert into __dbcheck_probe (id) values (${ID_SAMPLE}) returning id`;
      if (rows.length !== 1) throw new Error("temp 表写入未生效");
      throw new Rollback("回滚探针");
    });
    c8 = "事务未回滚（begin 正常提交了）";
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    const stillThere = (await sql`select to_regclass('pg_temp.__dbcheck_probe') as r`)[0].r;
    if (stillThere !== null && stillThere !== undefined) c8 = "temp 表回滚后仍存在";
  }
  record(
    c8.startsWith("temp DDL") ? "ok" : "fail",
    "C8",
    `${c8}（W0-4 迁移可用 DDL-in-transaction 姿势）`,
  );

  // ---- 环境概况（不判定）----
  record("info", "ENV", (await sql`select version() as v`)[0].v);
} catch (e) {
  aborted = (e?.message ?? String(e)).split("\n")[0];
  console.error(e?.message ?? String(e));
} finally {
  try {
    await sql.end({ timeout: 5 });
  } catch {
    /* 压根没连上时无需关闭 */
  }
}

const failed = results.filter((r) => r.kind === "fail");
const passed = results.filter((r) => r.kind === "ok").length;
if (failed.length === 0 && !aborted) {
  console.log(`db:check 通过（${passed} 项）`);
  process.exit(0);
}
console.error(
  `db:check 失败：${failed.map((f) => f.id).join(", ") || "aborted"}` +
    (aborted ? ` —— ${aborted}` : ""),
);
process.exit(1);

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
 *   C4 会话时区 = UTC（修订稿 §12.3；role 级默认由 `tools/ci-provision-role.mjs` 在建角色时下发，MATT-91）
 *   C5 client_encoding = UTF8（中文文案与全文检索的前提）
 *   C6 日界口径：`::date` 与 `AT TIME ZONE 'Asia/Shanghai'` 结果不同 → 证明禁用 `now()::date`
 *   C7 bigint 服务端往返精确；C7b 回报驱动把 int8 解析成了什么（P1-19 的由来）
 *   C8 事务内 DDL 可回滚（W0-4 迁移的执行姿势）
 *   C9 迁移已落地（`mn_status_config` 在库里）；C10 约束实撞（partial unique / 表级 CHECK / 生成列）
 *   C11 seed 八状态齐（每宿主 4 态、恰好一个初始态与一个归档态）
 *   C12 `next_status_codes` 在库里真是 `text[]`（0001 那条手写补丁生效了才算）
 *   C13 推荐后继已落库（6/8 行非空 —— 空数组在服务层等于"不限制"，偏离判定就永不为真）
 *   C14 `mn_app_user.is_admin` 已建列且持有者 1–2 人（草案 §3 的逃生口，人手都有等于没有）
 *   C15 规则 seed 9 条系统规则 + 触发域唯一索引在且是 partial（MATT-43；表未建时**只回报**，见该处注释）
 *   C16 批量导入两张表 + 幂等键 `uk_mn_import_row_content` 在且**真的是 partial**（MATT-44；同上，表未建只回报）
 *   C18 定时器心跳（MATT-83）：单行钉 + 三种状态，**两种红分开报**
 *       ——「从未运行」（空时间戳 ⇒ 查 instrumentation.ts 有没有起）
 *       与「已停摆」（超 3 个周期 ⇒ 查日志与进程存活）排障方向不同，合并会送人去错的那半。
 *       （编号落在 C18：`schema/timer-heartbeat.ts` 的注释已按 C18 登记这条探针，两处一致；
 *       C17 保持空白不占用，免得与在途的另一条探针撞号。）
 *       ⚠ 写入方 `src/instrumentation.ts` 还不存在时**只回报**：那时 created_at 恒为 NULL
 *       是「MATT-74 还没落地」，与「定时器坏了」在库里同形 —— 探针分辨不出，所以不能断言
 *       （否则从 0015 应用那一刻起它永远红，而永远红的门禁等于没有门禁）
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
  // ⚠ 没有 `.env` **不是**错误（2026-10-15，与 migrate / wait-heartbeat 统一口径）：
  // CI 与容器的值由环境注入、不经文件。只有「既无文件、环境变量里也没有库配置」
  // 才是真的没配 —— 那时才给本地指引，不该让 CI 死在一条开发指引上。
  if (!process.env.PGHOST || !process.env.PGDATABASE) {
    console.error("找不到 .env，且环境变量里也没有 PGHOST / PGDATABASE。");
    console.error("本地开发请先：cp .env.example .env 并填入 PGPASSWORD。");
    console.error("（.env 已在 .gitignore 内，禁止提交；本脚本不落盘、不打印密码）");
    process.exit(1);
  }
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

// C18 用它判断「心跳的写入方落地了没有」—— 文件在不在是**这一侧唯一能拿到**的
// 「MATT-74 交付了没有」的证据（库里分辨不出「还没建」与「坏了」）。
const { existsSync } = await import("node:fs");

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
        : ` ← 未钉 ${TARGET_TZ}：role 级默认没下发 —— 代码拥有的路径是 ` +
          `node tools/ci-provision-role.mjs（建角色时一并设）；手工等价操作：` +
          `ALTER ROLE ${pg.username} SET timezone='${TARGET_TZ}'; 后重连`),
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

  // ---- 迁移落地自检：库里的结构是否与迁移真相一致（跑在回滚事务里，不留痕）----
  const hasTable = (await sql`select to_regclass('public.mn_status_config') as r`)[0].r;
  record(
    hasTable !== null && hasTable !== undefined ? "ok" : "fail",
    "C9",
    hasTable
      ? "mn_status_config 已在库中（0000 迁移已应用）"
      : "mn_status_config 缺失 —— 跑 MN_DB_CONFIRM=<库名> pnpm db:migrate",
  );

  if (hasTable) {
    // 三个条件唯一索引 + 表级 CHECK：都在回滚事务里真撞一次，确认它们不是"建了但没生效"。
    // 关键细节：PG 里语句一旦报错，整个事务进入 aborted 态，后面的语句全废 ——
    // 所以每个"预期失败"必须单独包在 SAVEPOINT 里，否则第一个探针之后什么都测不到。
    const seen = [];
    try {
      await sql.begin(async (tx) => {
        // 先把 matter 这一档清空再探针：partial unique 撞不撞取决于"同 host_type 已有几行"，
        // 而 seed 跑没跑是另一件事 —— 探针不能依赖它。整个事务最后回滚，删掉的行会回来。
        await tx`delete from mn_status_config where host_type = 'matter'`;
        await tx`insert into mn_status_config (id, code, name, color, host_type, semantics, is_system, is_initial_status, sort_order)
                 values (900001, 'probe_a', '探针A', 'slate', 'matter', 'custom', false, true, 901)`;
        seen.push("初始态第一条 OK");
        try {
          await tx.savepoint(async (sp) => {
            await sp`insert into mn_status_config (id, code, name, color, host_type, semantics, is_initial_status, sort_order)
                     values (900002, 'probe_b', '探针B', 'slate', 'matter', 'custom', true, 902)`;
          });
          seen.push("PARTIAL-UNIQUE-FAILED");
        } catch {
          seen.push("partial unique 生效");
        }
        try {
          await tx.savepoint(async (sp) => {
            await sp`insert into mn_status_config (id, code, name, color, host_type, semantics, sort_order)
                     values (900003, 'probe_c', '探针C', 'slate', 'matter', 'converted', 903)`;
          });
          seen.push("CHECK-FAILED");
        } catch {
          seen.push("表级 CHECK 生效");
        }
        const gen = await tx`select is_archive_status from mn_status_config where id=900001`;
        seen.push(`生成列实算=${String(gen[0]?.is_archive_status)}`);
        throw new Rollback("探针回滚");
      });
    } catch (e) {
      if (!(e instanceof Rollback)) seen.push(`EXC:${e.message.split("\n")[0].slice(0, 40)}`);
    }
    const good =
      seen.includes("partial unique 生效") &&
      seen.includes("表级 CHECK 生效") &&
      seen.includes("生成列实算=false");
    record(good ? "ok" : "fail", "C10", `约束实撞：${seen.join(" · ")}`);

    const seeded = (
      await sql`select host_type, count(*)::int as n,
                       count(*) filter (where semantics='archived')::int as archived,
                       count(*) filter (where is_initial_status)::int as initial
                from mn_status_config where id < 100 group by host_type order by host_type`
    ).map((r) => `${r.host_type}:${r.n}(init=${r.initial},arch=${r.archived})`);
    const seedOk = seeded.length === 2 && seeded.every((s) => /:(\d+)\(init=1,arch=1\)/.test(s));
    record(
      seedOk ? "ok" : "fail",
      "C11",
      `seed 八状态（修订稿 §3.2）：${seeded.join(" ") || "空表 —— 跑 pnpm db:seed"}`,
    );
  }

  // ---- 这一轮改进落到库里的三条结构事实（纸面说了不算，全只读）----
  // C12 `next_status_codes` 必须真是 `text[]`：0000 基线建成了 `text`，而 schema 与两侧快照都是
  //     `text[]` ⇒ `db:generate` 不再给任何 diff，只有查 information_schema 能发现。
  //     失败形态不是"读出来是字符串"，而是 seed 一句 `42804: …不能赋给类型 text 的列`。
  const arrType = (
    await sql`select data_type from information_schema.columns
               where table_name = 'mn_status_config' and column_name = 'next_status_codes'`
  )[0]?.data_type;
  record(
    arrType === "ARRAY" ? "ok" : "fail",
    "C12",
    `next_status_codes 实际类型 = ${arrType ?? "(无此列)"}（要求 ARRAY，见 0001 迁移的手写补丁）`,
  );

  // C13 推荐后继真的落库了：八个内置态里 6 行有后继（每宿主的归档态是终态，留空）
  const nextFilled = (
    await sql`select count(*)::int as n from mn_status_config where next_status_codes <> '{}'::text[]`
  )[0]?.n;
  record(
    nextFilled === 6 ? "ok" : "fail",
    "C13",
    `已配推荐后继的状态行 = ${nextFilled ?? 0}（要求 6：空数组在服务层等于"不限制"，偏离判定就永不为真）`,
  );

  // ---- C14 `is_admin` 列存在且恰好一人：它是"绕过范围的最后开关"，人手都有就等于没有 ----
  const adminCol = (
    await sql`select count(*)::int as n from information_schema.columns
               where table_name = 'mn_app_user' and column_name = 'is_admin'`
  )[0]?.n;
  const adminUsers = (await sql`select count(*)::int as n from mn_app_user where is_admin`)[0]?.n;
  record(
    adminCol === 1 && adminUsers >= 1 && adminUsers <= 2 ? "ok" : "fail",
    "C14",
    `mn_app_user.is_admin 建列=${adminCol === 1 ? "是" : "否"} · 持有者 ${adminUsers ?? 0} 人（草案 §3：仅 1–2 人）`,
  );

  // ---- C15 规则表的 seed 与触发域唯一约束（MATT-43 / T5b）----
  // 票面 AC 第一条是「规则 9 进 seed，触发域唯一性由 **DB 约束**保证」——
  // 而"约束建了但没生效"与"seed 少了一条"都不会报错，只会让同域同动作的规则能并存。
  // 所以这里把两件事都读一遍：**9 条系统规则**，以及那条 partial unique index 真的在。
  //
  // 表不存在时**只回报不断言**（与 C9 的分工不同：C9 守的是基线，基线缺了整条链路都不成立；
  // 本表是后续迁移，跳过必须留痕——`record` 会把这句打出来，不会静默消失）。
  const ruleTable = (await sql`select to_regclass('public.mn_automation_rule') as r`)[0]?.r;
  if (ruleTable === null || ruleTable === undefined) {
    record(
      "info",
      "C15",
      "mn_automation_rule 未建（迁移 0012 未应用）—— 规则 seed 与触发域唯一约束这项跳过",
    );
  } else {
    const [r15] = await sql`
      select count(*)::int as total,
             count(*) filter (where is_system)::int as system,
             count(*) filter (where is_enabled)::int as enabled
        from mn_automation_rule`;
    const [i15] = await sql`
      select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'ux_mn_automation_rule_enabled_action'`;
    const partial = typeof i15?.indexdef === "string" && /where\s+is_enabled/i.test(i15.indexdef);
    const ok15 = r15.total === 9 && r15.system === 9 && partial;
    record(
      ok15 ? "ok" : "fail",
      "C15",
      `预置规则 ${r15.total} 条（系统 ${r15.system} · 启用 ${r15.enabled}，规则 1 默认禁用故启用应为 8）· ` +
        `触发域唯一索引 ${i15 ? (partial ? "在且是 partial（WHERE is_enabled）" : "在但**不是** partial") : "**缺失**"}`,
    );
  }

  // ---- C16 批量导入的两张表 + 幂等键**真的是 partial**（MATT-44 / T6 / F7-4）----
  // 「同文件重导不再产生重复行」靠的是 **DB 级**唯一性（服务层的"先查后插"有窗口，双击提交
  // 就能穿过去），也就是这条 `uk_mn_import_row_content`。它**必须带 `WHERE status='imported'`**：
  // 全表唯一会让"把错行改对再传一次"撞上自己上一轮的错误记录 —— 而**索引在但不是 partial
  // 不会报任何错**，只会让重传永远失败。所以这里不只看它在不在，还要看 `pg_get_indexdef`
  // 里有没有那个 WHERE（这是本条的主要价值，也是正向反向两次都实测过的）。
  //
  // 表不存在时只回报不断言（与 C15 同款：0012/0013 都是后续迁移，跳过必须留痕）。
  const importTables = (
    await sql`select to_regclass('public.mn_import_batch') as b,
                     to_regclass('public.mn_import_row') as r`
  )[0];
  if (importTables.b === null || importTables.r === null) {
    record(
      "info",
      "C16",
      "mn_import_batch / mn_import_row 未建（迁移 0013 未应用）—— 幂等键 partial 这项跳过",
    );
  } else {
    const [r16] = await sql`
      select count(*)::int as total,
             count(*) filter (where status = 'imported')::int as imported,
             count(*) filter (where status = 'skipped')::int as skipped
        from mn_import_row`;
    const [i16] = await sql`
      select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'uk_mn_import_row_content'`;
    const partial = typeof i16?.indexdef === "string" && /where\s+\(?\(?status/i.test(i16.indexdef);
    // 三条值域 CHECK 是"值域写在库里"的那一半（`enum-check` 认领的就是它们）
    const wantChecks = [
      "ck_mn_import_batch_host",
      "ck_mn_import_batch_status",
      "ck_mn_import_row_status",
    ];
    const haveChecks = (
      await sql`select conname from pg_constraint
                 where conrelid in ('mn_import_batch'::regclass, 'mn_import_row'::regclass)
                   and contype = 'c'`
    ).map((r) => r.conname);
    const missingChecks = wantChecks.filter((c) => !haveChecks.includes(c));
    record(
      partial && missingChecks.length === 0 ? "ok" : "fail",
      "C16",
      `导入行 ${r16.total} 条（imported ${r16.imported} · skipped ${r16.skipped}）· ` +
        `幂等键 ${
          i16
            ? partial
              ? "在且是 partial（WHERE status = 'imported'）"
              : "在但**不是** partial ← 重传会撞上自己上一轮的错误记录"
            : "**缺失**"
        } · ` +
        (missingChecks.length
          ? `缺 CHECK：${missingChecks.join("、")}`
          : `三条值域 CHECK 齐（${wantChecks.length}/${wantChecks.length}）`),
    );
  }

  // ---- C18 定时器心跳（MATT-83 / T4e 前置件）----
  // 「应用内定时器还活着吗」**在进程内无解**：croner@10.0.1 的状态全是内存字段，
  // 进程一死归零；`previousRun()` 抛异常照样前进（它记「跑完了」不记「跑成了」）。
  // 所以判据只能落在库里这一行 —— 详见 `docs/research-croner-status-heartbeat.md` §8。
  //
  // 这条探针的价值全在**两种红的说法不同**：
  //   · 从未运行（行在、`created_at IS NULL`）⇒ 定时器**没起来** ⇒ 看 `src/instrumentation.ts`
  //   · 已停摆（有戳但超 3 个周期）        ⇒ 定时器**起过后不动了** ⇒ 看日志与进程存活
  // 合并成一句「心跳异常」会把人送去错的那一半排查 —— 那正是这行存在的意义。
  //
  // 表不存在时只回报不断言（与 C15/C16 同款：0015 是后续迁移，跳过必须留痕）。
  //
  // ⚠ **写入方没落地之前，这条只能回报不能断言**（2026-10-14）。
  //   表与探针是 MATT-83 交付的，而往表里写心跳的是 MATT-74 的
  //   `src/instrumentation.ts`。两者之间那段窗口里，`created_at` 必然为 NULL ——
  //   那是**「还没建」而不是「坏了」**，而探针在库里分辨不出这两者。
  //   所以判据是「写入方在不在文件系统里」而不是「戳新不新」：
  //   文件不在 ⇒ info（与 C15/C16 的表未建同款），文件在 ⇒ 转硬断言。
  //   不这么做的话，`pnpm db:check` 从 0015 应用那一刻起永远红，
  //   直到 MATT-74 落地 —— 一条永远红的门禁等于没有门禁。
  const hbTable = (await sql`select to_regclass('public.mn_timer_heartbeat') as r`)[0]?.r;
  const hbWriter = existsSync("src/instrumentation.ts");
  if (hbTable === null || hbTable === undefined) {
    record(
      "info",
      "C18",
      "mn_timer_heartbeat 未建（迁移 0015 未应用）—— 定时器心跳这项跳过；" +
        "跑 MN_DB_CONFIRM=<库名> pnpm db:migrate",
    );
  } else if (!hbWriter) {
    record(
      "info",
      "C18",
      "表已建、但写入方 `src/instrumentation.ts` 还不存在（MATT-74 未落地）—— " +
        "此刻 created_at 恒为 NULL 是**预期**，不是「从未运行」。MATT-74 交付后" +
        "这条自动转为硬断言（从未运行 / 已停摆两种红）",
    );
  } else {
    // 泵每 5 分钟一次（MATT-74）；3 个周期 = 15 分钟（票面阈值）
    const HB_CYCLE_S = 5 * 60;
    const HB_MAX_AGE_S = 3 * HB_CYCLE_S;
    const hbRows = await sql`
      select id, created_at, pump_count,
             extract(epoch from (now() - created_at))::int as age_s
        from mn_timer_heartbeat
       order by id`;
    const [hbCk] = await sql`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
       where c.conrelid = 'mn_timer_heartbeat'::regclass
         and c.conname = 'ck_mn_timer_heartbeat_id'`;
    // 单行钉是"读到较新那行、掩盖停摆那条"的唯一屏障，所以连**定义**一起查：
    // 「约束在」不等于「约束是 id = 1」（改名/换表达式都不会报错，只会静默失去钉力）。
    const pinned = typeof hbCk?.def === "string" && /id\s*=\s*1/i.test(hbCk.def);
    const shape =
      `行数 ${hbRows.length} · 单行钉 ` +
      (pinned ? "在且是 id = 1" : `**不在或不是 id = 1**（${hbCk?.def ?? "查不到该约束"}）`);
    const row = hbRows[0];

    if (!pinned || hbRows.length !== 1) {
      // 三种破坏各自的处置不同，所以提示不能只有一句 —— 尤其"单行钉没了但此刻恰好只有一行"
      // 那种：**它是绿的假象**，下一次心跳就能写进第二行。
      const why =
        hbRows.length === 0
          ? "表在但没有任何行：seed 0007 没跑过、或那行被删了。此时探针答不出定时器的状态"
          : hbRows.length > 1
            ? "表里有多行 = 多心跳 = 探针读到较新那行，会掩盖真正停摆的那条"
            : "单行钉被摘掉/改掉了，而此刻恰好只有一行是**巧合** —— 下一条心跳就能写进第二行";
      record(
        "fail",
        "C18",
        `心跳表**结构**坏了：${shape} ← ${why}。跑 MN_DB_CONFIRM=<库名> pnpm db:seed / 人审迁移 0015`,
      );
    } else if (row.created_at === null || row.created_at === undefined) {
      record(
        "fail",
        "C18",
        `定时器**从未运行**：行的 created_at IS NULL（${shape}）` +
          " ⇒ 看 src/instrumentation.ts：它有没有被打包/加载、register() 里那个定时器有没有起来。" +
          "（起 register() 外层 try/catch 会把「配置写错」降级成一行日志 + 定时器压根没起，" +
          "与「没人该收」在库里同形。⚠ 这一态**不是**停摆，别去查日志与进程存活）",
      );
    } else if (row.age_s >= HB_MAX_AGE_S) {
      record(
        "fail",
        "C18",
        `定时器**已停摆**：上次成功 pump 距今 ${row.age_s}s（≈ ${Math.floor(row.age_s / HB_CYCLE_S)} 个周期，` +
          `阈值 ${HB_MAX_AGE_S}s = 3 个周期；累计成功 ${row.pump_count} 次）` +
          " ⇒ 它**起过、后来不动了**：看进程日志与进程存活（崩溃循环 / 被 kill / 事件循环被堵）。" +
          "⚠ 这一态**不是**「没起来」，别去查 instrumentation.ts 的加载",
      );
    } else {
      record(
        "ok",
        "C18",
        `定时器心跳新鲜：上次成功 pump 距今 ${row.age_s}s（< ${HB_MAX_AGE_S}s = 3 个周期）· ` +
          `累计成功 ${row.pump_count} 次 · ${shape}`,
      );
    }
  }

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

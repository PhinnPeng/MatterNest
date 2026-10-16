/**
 * 一次性容器的角色分权（MATT-87）。
 *
 * ## 它解决什么
 *
 * CI 的 postgres service 用 `POSTGRES_USER: dev_matternest` 建库，而 `postgres:*` 镜像
 * 把 `POSTGRES_USER` 建为 **SUPERUSER**。于是整条流水线——迁移、seed、dev server、
 * `db:check`、全组冒烟——都在超级用户下跑，而 `db:check` 的 **C3 恰好是禁止这件事的探针**
 * （「应用角色不该是超级用户」）。本地那条同名角色不是超级用户，所以本地全绿、CI 必红。
 *
 * ## 姿态：与本地**逐字一致**
 *
 * 调研（`docs/research-ci-role-privileges.md`）测出本地跑通的那条非超级用户角色的画像是
 * 「**自有库 + 自有 `public` schema**」，不是「被逐条授权的普通角色」。所以这里照抄那个姿态，
 * 而不是去维护一套 GRANT 清单——后者漏一条就会在 CI 上表现为一条与真因无关的权限错。
 *
 * ⚠ `public` 的属主**显式**改，不依赖 PG15+ 的 `pg_database_owner` 伪角色默认：
 *   本地那个库的 `public` 属主是**真角色**（oid 535384），说明被人显式改过，
 *   所以「改库属主 ⇒ CREATE 自动跟着走」那条默认语义在这个项目上不成立，不能假设。
 *
 * ## 超级用户还用不用
 *
 * 用，而且必须用 —— 镜像的 `POSTGRES_USER` 得是超级用户，否则它自己起不来，
 * 而它是**唯一**能 `CREATE ROLE` 的入口。所以纪律是：**超级用户只出现在本工具这一次调用里**，
 * 本工具交出去之后，流水线剩下的每一步都用非超级用户角色。
 *
 * 它交接出去的东西写在 `$GITHUB_ENV`（`PGUSER` / `PGPASSWORD`），
 * 而那两步在 workflow 里**故意不放 job 级 `env`** —— job 级 env 会在 `$GITHUB_ENV` 之后
 * 生效，把刚写进去的值盖掉，于是后面每一步又会悄悄用回超级用户。
 *
 * ## 口令怎么来的
 *
 * `MN_CI_APP_PASSWORD` 由调用方现生成，本工具**只把它当参数传给 `format('%L')`，从不拼进 SQL、
 * 从不打印**。这是 MATT-36 那条裁定（不入库 / 不进镜像 / 不进 git）在数据库侧的同一个形状。
 *
 * ## 它还拥有「会话是 UTC」这个前提（MATT-91）
 *
 * 「连库后 session timezone 必须是 UTC」此前是本仓**没有属主**的硬前提：真兜底只有两处**探针**
 * （`db/client.ts` 的起池断言、`db:check` 的 C4），而让会话真是 UTC 的那条 role 级
 * `ALTER ROLE … SET timezone='UTC'` 只在共享 dev 库上**被人手工执行过** —— 新库 / CI / 部署
 * 都没人重放。CI 的 C4 之所以一直绿，只是因为 `postgres:16-alpine` **镜像默认**恰好是 UTC。
 *
 * ⚠ 所以那条 ALTER 落在这里（**唯一「代码拥有的建角色路径」**），而不是「连上再 SET」：
 *   `client.ts` 起池时发现 timezone 不是 UTC 就**直接抛**，等于拒绝了「先连上、再 SET 兜」
 *   这条路 —— 前提必须在连接建立**之前**的下发点成立。
 *   ⇒ 删掉这一条，本工具的复核（`APP_ROLE_MUST.hasUtcTimezone`）与
 *   `tools/ci-provision-role.spec.ts` 会**当场红**，而不是等 C4 在别的库上红。
 *
 * 用法：
 *   · 连接用 `PGUSER` / `PGPASSWORD` / `PGHOST` / `PGPORT` / `PGDATABASE`（此时它们是超级用户）
 *   · 目标角色 `MN_CI_APP_ROLE`（默认 `mn_app`）
 *   · 目标角色口令 `MN_CI_APP_PASSWORD`（**必填**，没有就拒跑 —— 免得落库一个空口令角色）
 *   · `--check` 只校验现状、不改任何东西（用于「这一步真的生效了吗」的独立复核）
 */
import { pathToFileURL } from "node:url";
import postgres from "postgres";

export const DEFAULT_ROLE = "mn_app";

/**
 * 会话时区（MATT-91）。工具内只有这一处事实源：DDL 里下发它，复核里断言它的存在。
 * 与 `tools/db-check.mjs` 的 `TARGET_TZ` 是同一口径（本文件刻意不 import 那个脚本 ——
 * 它是带副作用的入口脚本，不是一个可 import 的模块）。
 */
export const SESSION_TIMEZONE = "UTC";

/** PG 的标识符：只认小写开头的字母/下划线 + 数字 + 下划线 */
const SAFE_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * 标识符只能用 `%I` 之外的写法 —— 因为 `ALTER DATABASE … OWNER TO …` 的目标
 * **不是参数位**，DDL 里没有占位符。所以必须自己拼，也就必须自己把关。
 *
 * 拼错的后果是注入（`mn_app; DROP DATABASE …`），所以这里宁可**拒绝**，不转义。
 */
export function quoteIdent(name, what = "标识符") {
  if (typeof name !== "string" || !SAFE_IDENT.test(name)) {
    throw new Error(
      `${what} ${JSON.stringify(name)} 不合法：只允许 /^[a-z_][a-z0-9_]{0,62}$/（小写开头）。` +
        `这是刻意**拒绝**而不是转义 —— 它要被拼进 ALTER 语句，转义一旦漏一处就是注入。`,
    );
  }
  return `"${name}"`;
}

/**
 * 分权要执行的语句。纯函数，不碰连接 —— 判据全在这里，可离线测。
 *
 * 口令走 `$1` / `$2` 参数位，**不进 SQL 文本**（因此也不会出现在任何日志里）。
 */
export function provisionSql({ database, role, password, roleExists = false }) {
  if (!password) {
    throw new Error(
      "MN_CI_APP_PASSWORD 是必填项 —— 没有它就会建出一个空口令的可登录角色，" +
        "那比超级用户还糟（谁能登上谁就能拿到那个角色）。",
    );
  }
  const db = quoteIdent(database, "库名");
  const r = quoteIdent(role, "角色名");

  // ⚠ 为什么是「format 出一条语句、再执行它」，而不是直接发 `create role … password '…'`：
  //
  //   1. **口令不能进 SQL 文本** —— 它会进日志、进 `pg_stat_activity`、进任何一次异常回显，
  //      而 MATT-36 的裁定是三把密钥「不入库 / 不进镜像 / 不进 git」。数据库口令是同一类东西。
  //   2. **但 PG 没有 `CREATE ROLE … PASSWORD $1`** —— 角色名与口令都不是参数位。
  //      所以只能用服务端侧的 `format('%I' / '%L')` 生成语句文本。
  //
  // ⚠⚠ 早先这里写的是 `do $ … if not exists (select … where rolname = $1) … $;`
  //    —— **在真库上直接报错**：`could not determine data type of parameter $1`。
  //    DO 块的体是一个函数体，$1 被 PL/pgSQL 当成**函数参数**引用，而这个函数没有参数。
  //    （这条只有在真库上跑才暴露 —— 16 条离线判据全绿，因为它们只看 SQL 文本。）
  const stmt = (verb) => ({
    text:
      // ⚠ `$1::text` / `$2::text` 不能省：format 是 VARIADIC "any"，
      //   PG 无法为无类型标注的占位符推断 any 类型（报「无法确定参数类型 $1」）。
      `select format('${verb} role %I login password %L ` +
      "nosuperuser nocreatedb nocreaterole', $1::text, $2::text) as stmt",
    params: [role, password],
    // true = 返回的 stmt 字段要**再执行一遍**（它才是真正的那条 DDL）
    exec: true,
  });

  return [
    // 角色已存在时跳过 create：重复创建会报 42710，而报错在这里是**正常路径**不是故障。
    // 权限仍然由下面那条 alter 收回来 —— 不依赖历史状态。
    ...(roleExists ? [] : [stmt("create")]),
    stmt("alter"),
    // 会话时区的前提由**这里**拥有（MATT-91，理由见文件头）。两条路径（新建 / 已存在）都发 ——
    // 「角色已存在」不代表它被下发过这条默认值（本地与共享库正是这种历史状态）。
    //
    // ⚠ 它是**独立一条语句**，不并进上面那条 `alter role … nosuperuser …`：那条走
    //   `format()` 现拼（因为口令必须走参数位），而这条只有角色名与常量，直发即可，
    //   报错也会明确指向「时区默认值没下发」而不是混在口令那条里。
    { text: `alter role ${r} set timezone to '${SESSION_TIMEZONE}';`, params: [] },
    // 姿态的第一半：它是库的属主 ⇒ 库级 CREATE 自动有（够 drizzle 建 `drizzle` schema）
    { text: `alter database ${db} owner to ${r};`, params: [] },
    // 姿态的第二半：`public` 的 CREATE。**显式**改，不依赖 PG15+ 的伪角色默认（见文件头 ⚠）
    { text: `alter schema public owner to ${r};`, params: [] },
  ];
}

/**
 * 交接出去之后，这个角色**必须**满足的性质。查出来是为了让 CI 自己作证，
 * 而不是等几分钟后 C3 在 db:check 里报一条与真因无关的红。
 */
export const APP_ROLE_MUST = {
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  ownsDatabase: true,
  canCreateInPublic: true,
  // MATT-91：会话 UTC 的前提也要由这里**证明确实交出去了**。
  //
  // ⚠ 为什么断言的是 `rolconfig` 里的 role 级默认值，而不是「这次连接的 session timezone」：
  //   后者在 CI 里**必然**是 UTC —— 镜像默认值就是 UTC，所以它绿得毫无信息量，
  //   删掉上面那条 ALTER 也照样绿。rolconfig 里的这一项才是「本工具下发过」的证据。
  hasUtcTimezone: true,
};

/**
 * 复核查询。
 *
 * ⚠ 别名**必须**与 APP_ROLE_MUST 的键**逐字一致** —— 曾经写成 `owns_db` / `can_create_public`，
 *   而常量里是 `ownsDatabase` / `canCreateInPublic`，于是查出来全是 `undefined`。
 *   分权**其实成功了**（日志里自有库=true public 可建=true），却因为这层命名不一致报红。
 *
 *   这就是这一层存在的理由：它宁可红，也不肯在「查出来的不是它要验的东西」时放行。
 *   而代价是别名必须与常量对齐 —— 所以下面那条测试就是钉这个。
 */
export const checkSql = `
  select current_user as usr,
         current_database() as db,
         (select rolsuper from pg_roles where rolname = current_user) as rolsuper,
         (select rolcreatedb from pg_roles where rolname = current_user) as rolcreatedb,
         (select rolcreaterole from pg_roles where rolname = current_user) as rolcreaterole,
         (select pg_get_userbyid(datdba) = current_user from pg_database
           where datname = current_database()) as "ownsDatabase",
         has_schema_privilege(current_user, 'public', 'CREATE') as "canCreateInPublic",
         -- ⚠ 两个实测坑（PG 16.14 真库，2026-10-17）：
         --   1. rolconfig **不在本查询的 FROM 里**（这条 SQL 没有 FROM）——
         --      裸写 any(rolconfig) 会报 column "rolconfig" does not exist。必须走子查询。
         --   2. GUC 名被 PG **归一化**成 TimeZone（不是我们写的 timezone）：
         --      ALTER ROLE … SET timezone TO 'UTC' 落库是 {TimeZone=UTC}。
         --      写成小写会得到一条**永远为 false** 的断言 —— 而它在离线文本测试里照样绿。
         (select coalesce(array_position(rolconfig, 'TimeZone=${SESSION_TIMEZONE}') > 0, false)
            from pg_roles where rolname = current_user) as "hasUtcTimezone",
         (select rolconfig from pg_roles where rolname = current_user) as "rolconfigRaw"`;

export function report(actual) {
  return Object.entries(APP_ROLE_MUST)
    .filter(([k, want]) => actual[k] !== want)
    .map(
      ([k, want]) =>
        // 显式说清「查到了吗」：undefined 与 false 是两回事，前者是查错了列
        `  ${k}: 期望 ${want}，实到 ${actual[k] ?? "(查不到这一列)"}`,
    );
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  // 与 db-check / migrate 同一口径（Node 22 自带，不引 dotenv）：
  // **没有 `.env` 不是错误** —— CI 的值由 workflow 注入；本地才有 `.env` 可读。
  try {
    process.loadEnvFile();
  } catch {
    /* 没有 .env：走环境变量，正常路径 */
  }

  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check");
  const role = process.env.MN_CI_APP_ROLE ?? DEFAULT_ROLE;
  const password = process.env.MN_CI_APP_PASSWORD;
  const database = process.env.PGDATABASE;

  if (!database) {
    console.error("[FAIL] PGDATABASE 未设 —— 不知道往哪个库分权。");
    process.exit(2);
  }

  const conn = {
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5432),
    database,
    username: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 1,
    connect_timeout: 8,
    onnotice: () => {},
  };

  if (!checkOnly) {
    const boot = postgres(conn);
    try {
      const [me] = await boot.unsafe("select rolsuper from pg_roles where rolname = current_user");
      if (me.rolsuper !== true) {
        throw new Error(
          `当前连接角色 ${conn.username} 不是超级用户，建不出新角色。` +
            `这条工具**只**允许用超级用户跑（它是唯一能 CREATE ROLE 的入口）——` +
            `但它建出来的角色是给流水线后面每一步用的非超级用户。`,
        );
      }
      const [{ n: existing }] = await boot.unsafe(
        "select count(*)::int as n from pg_roles where rolname = $1::text",
        [role],
      );
      for (const s of provisionSql({
        database,
        role,
        password,
        roleExists: existing > 0,
      })) {
        if (s.exec) {
          const [{ stmt: ddl }] = await boot.unsafe(s.text, s.params);
          await boot.unsafe(ddl);
        } else {
          await boot.unsafe(s.text, s.params);
        }
      }
      console.log(`已分权：${role} 现在是 ${database} 的属主，且非超级用户`);
      console.log(
        `  · 会话时区已随角色下发：alter role ${role} set timezone to '${SESSION_TIMEZONE}'`,
      );
    } catch (e) {
      console.error(`[FAIL] 分权失败：${e.message}`);
      await boot.end({ timeout: 2 }).catch(() => {});
      process.exit(1);
    }
    await boot.end({ timeout: 2 }).catch(() => {});
  }

  // 复核：换一个**应用角色**的连接来验，证明交出去的那套凭据真的能用
  const app = postgres({ ...conn, username: role, password });
  try {
    const [actual] = await app.unsafe(checkSql);
    const bad = report(actual);
    console.log(
      `复核（以 ${actual.usr} 连接）：rolsuper=${actual.rolsuper} ` +
        `rolcreatedb=${actual.rolcreatedb} rolcreaterole=${actual.rolcreaterole} ` +
        `自有库=${actual.ownsDatabase} public 可建=${actual.canCreateInPublic} ` +
        `role 级 timezone=${SESSION_TIMEZONE}=${actual.hasUtcTimezone}` +
        `（rolconfig=${JSON.stringify(actual.rolconfigRaw ?? null)}）`,
    );
    if (bad.length) {
      console.error("[FAIL] 应用角色的性质不符合要求：");
      for (const b of bad) console.error(b);
      process.exit(1);
    }
    console.log("交接完成。流水线后续步骤请用这个角色的 PGUSER / PGPASSWORD。");
  } catch (e) {
    console.error(
      `[FAIL] 以应用角色 ${role} 连接失败 —— 这就是流水线后面每一步会看到的错误：${e.message}`,
    );
    process.exit(1);
  } finally {
    await app.end({ timeout: 2 }).catch(() => {});
  }
}

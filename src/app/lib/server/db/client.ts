import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * 服务端唯一连接入口（禁令⑤：业务读写一律走 `/api/**`，而 `/api/**` 只从这里拿连接）。
 *
 * 三条与规格件直接相关的口径：
 *   · 池上限 10、不引 pgbouncer（技术选型 §12.5）—— pgbouncer 的 transaction mode 与
 *     advisory lock / `SET LOCAL` 冲突，单飞与 `SET TIME ZONE` 都会变得不可预期。
 *   · **会话固定 UTC 靠"角色级默认 + 首次取用时的启动断言"两道**（spec/backend/database-guidelines.md
 *     「ID、时间与编号」）：`dev_matternest` 已 `ALTER ROLE … SET timezone='UTC'`，
 *     而断言保证换环境（角色没配）时是**当场抛错**而不是静默按 +08 跑。
 *   · `connect_timeout` 设短：共享 dev 机的端口映射一断，宁可 5s 报错也不要请求挂着。
 *
 * 只在服务端 import：本文件在 `src/app/lib/server/` 下，禁令① 保证它不会渗进 `src/shared/**`。
 *
 * 两条反直觉的工具事实（2026-09-27 读 `node_modules/postgres/src/index.js` 与实测得出，别再造）：
 *   · postgres.js 的选项名是 **`connect_timeout`**，`connection_timeout` 会被静默忽略；
 *   · 它**没有** `after_connect`/`options` 这类"连接后执行 SQL"的钩子，所以会话参数不能塞进连接串，
 *     只能走角色级默认 + 显式断言（或每次请求 `SET LOCAL`）。
 */
type Pool = ReturnType<typeof postgres>;
type Db = ReturnType<typeof drizzle<Record<string, unknown>>>;

let pool: Pool | undefined;
let dbInstance: Db | undefined;
let asserted: Promise<true> | undefined;

function makePool(): Pool {
  const host = process.env.PGHOST;
  const database = process.env.PGDATABASE;
  const user = process.env.PGUSER;
  if (!host || !database || !user) {
    throw new Error(
      "缺 PGHOST/PGDATABASE/PGUSER —— 复制 .env.example 为 .env（任何密钥不入库，技术选型 §6）",
    );
  }
  return postgres({
    host,
    port: Number(process.env.PGPORT ?? 5432),
    database,
    user,
    password: process.env.PGPASSWORD ?? "",
    max: Number(process.env.PG_POOL_MAX ?? 10),
    connect_timeout: 5,
    idle_timeout: 20,
    ssl: false,
  });
}

/**
 * 启动断言：只跑一次（`asserted` 缓存的是 promise，所以并发请求只会测一回）。
 * 失败一定要抛 —— 时区口径错了不会立刻出错，只会在跨零点那一刻把编号和期限算到前一天。
 */
/** 导出只为让单测能塞一个假池进来（真库里断言跑不动：测试必须离线） */
export async function assertSessionConventions(p: Pool): Promise<true> {
  const rows =
    (await p`select current_setting('timezone') as tz, current_setting('client_encoding') as enc`) as [
      { tz: string; enc: string },
    ];
  const { tz, enc } = rows[0];
  if (tz.toUpperCase() !== "UTC") {
    throw new Error(
      `会话时区不是 UTC（拿到 ${tz}）—— 执行 ALTER ROLE ${process.env.PGUSER} SET timezone='UTC'; 后重连`,
    );
  }
  if (enc.toUpperCase() !== "UTF8") {
    throw new Error(`client_encoding 不是 UTF8（拿到 ${enc}）`);
  }
  return true;
}

/** 懒建池：Route Handler 里第一次用到才连，模块加载期不碰网络（Next 会在构建期 import 路由文件） */
export async function getDb(): Promise<Db> {
  pool ??= makePool();
  /**
   * ⚠ 断言失败必须**清掉缓存**，不能只 `asserted ??=`。
   *
   * 缓存的是 **promise**（为了让并发请求只测一回），而 promise 会把**失败也缓存住**：
   * 一次瞬时断连（共享 dev 机的端口映射一抖）让断言失败之后，`asserted` 就永久持有那个
   * rejected promise，之后**每个请求**都 await 到同一个失败 ⇒ 进程从此 500，
   * 哪怕库早就恢复了。症状是"改完代码好好的，过一会儿所有接口都 500，重启 dev server 就好"
   * ——而重启掩盖了根因（本轮实测：隧道抖动期间反复出现，我重启了三次才定位到这一行）。
   *
   * 修法：失败时把 `asserted` 置回 undefined，下一个请求重试。成功仍然只跑一次。
   */
  if (!asserted) {
    asserted = assertSessionConventions(pool).catch((e: unknown) => {
      asserted = undefined;
      throw e;
    });
  }
  await asserted;
  dbInstance ??= drizzle(pool, { schema }) as unknown as Db;
  return dbInstance;
}

/** 关闭连接：worker 与测试收尾用；SIGTERM drain 也要走它（技术选型 §13.3-4） */
export async function closeDb(): Promise<void> {
  asserted = undefined;
  dbInstance = undefined;
  await pool?.end({ timeout: 5 });
  pool = undefined;
}

export { schema };

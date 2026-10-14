/**
 * 等定时器的**第一次成功 pump**落地（MATT-74）。
 *
 * 用法：`node tools/wait-heartbeat.mjs [超时秒数]`（默认 180）
 * 退出码：0 心跳新鲜；1 超时 / 连不上 / 表或行不对。
 *
 * ## 为什么需要这个工具（CI 的顺序问题）
 *
 * `db:check` 的 C18 探针在 `src/instrumentation.ts` 存在之后会从 `info` **变成硬断言**：
 * 它要求心跳行是「跑过且新鲜」（< 15 分钟）。而 CI 原来的顺序是
 * `migrate → seed → db:check → 起 dev server` —— 那条顺序下 `created_at` 必然是 NULL
 * （seed 落的初始行就是 NULL），C18 报的是「定时器**从未运行**」。
 * 那个红**不是**缺陷，是**顺序错了**：探针问的那个问题在那一刻还没有答案。
 *
 * 修法有三条路，选的是第三条（理由见 `.github/workflows/ci.yml` 的注释）：
 *   ① 把 db:check 挪到冒烟之后 —— 那等于让 C18 在 CI 里**永远不成立地绿**（同一格时间下
 *      定时器可能刚好被读过一次，但没有任何东西保证它跑过）；
 *   ② 把 C18 在 CI 里降回 info —— 那等于**把门禁关掉**（本票的全部价值就在这条门禁上）；
 *   ③ **起 server → 等首轮心跳 → db:check → 冒烟**：把「等」显式化成一个有界的门。
 *
 * 第 ③ 条额外买到一件事：这一步本身就是**「定时器在 CI 里真的起来了」的断言**——
 * 比 C18 更强。C18 只读一行数据，判不出那行是谁写的；本步等的是**这一次进程**写出来的
 * 新鲜戳（起 server 时它还是 NULL）。
 *
 * ## 为什么首轮不必等 5 分钟
 *
 * `register()` 起来就立即执行一次（MATT-74 的 `job.trigger()`，见 `src/instrumentation.ts`），
 * 不等第一个 5 分钟槽位。所以这里的预算只需要覆盖「dev server 起来 + 首次编译」，
 * 180s 是宽裕值（实测几秒）。若有人把首轮改回「等 5 分钟」，这一步会红
 * ——那正是它要挡的形态。
 *
 * 只读：不写任何数据，全程不打印密码。
 */
/* global setTimeout */
// 上面这条是 `run-smokes.mjs:81-84` 同款：本文件用到的 Node 内建全局在这里点名，
// 而不是去放开共享的 `no-undef` 配置。
const timeoutSeconds = Number(process.argv[2] ?? 180);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error("用法：node tools/wait-heartbeat.mjs [超时秒数]，例如 180");
  process.exit(1);
}

try {
  process.loadEnvFile();
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  console.error("找不到 .env。先执行：cp .env.example .env 并填入 PGPASSWORD。");
  process.exit(1);
}

const pg = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 30432),
  database: process.env.PGDATABASE,
  username: process.env.PGUSER,
  password: process.env.PGPASSWORD,
};
if (!pg.database || !pg.username) {
  console.error("PGDATABASE / PGUSER 为空，无法探活。检查 .env。");
  process.exit(1);
}

const { default: postgres } = await import("postgres");
/** 与 `db:check` 的 C18 同一口径：3 个周期（5 分钟 × 3） */
const HB_MAX_AGE_S = 3 * 5 * 60;

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

const started = Date.now();
let last = "（还没有读到心跳行）";
let ok = false;
try {
  while ((Date.now() - started) / 1000 < timeoutSeconds) {
    const rows = await sql`
      select id, created_at, pump_count::text as pump_count,
             extract(epoch from (now() - created_at))::int as age_s
        from mn_timer_heartbeat order by id`;
    if (rows.length === 0) {
      last = "表在、但没有任何行 —— seed 0007 没跑过（这一态 db:check 的 C18 会另报一条结构红）";
    } else if (rows[0].created_at === null) {
      last =
        "行在、created_at IS NULL ⇒ 定时器**从未运行**（看 src/instrumentation.ts 有没有被加载）";
    } else if (rows[0].age_s < HB_MAX_AGE_S) {
      console.log(
        `心跳新鲜：距今 ${rows[0].age_s}s（阈值 ${HB_MAX_AGE_S}s = 3 个周期）· ` +
          `累计成功 ${rows[0].pump_count} 次 · 等了 ${Math.round((Date.now() - started) / 1000)}s`,
      );
      ok = true;
      break;
    } else {
      last = `戳太旧：距今 ${rows[0].age_s}s（> ${HB_MAX_AGE_S}s）—— 是**这次进程之前**留下的戳`;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
} catch (e) {
  console.error(`连不上或查询失败：${e.message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
await sql.end({ timeout: 5 }).catch(() => {});

if (!ok) {
  console.error(
    `等了 ${timeoutSeconds}s 没等到新鲜心跳：${last}\n` +
      "排查方向（两种红不一样，别走错）：\n" +
      "  · 从未运行 ⇒ 看 src/instrumentation.ts 有没有被加载、register() 里那个定时器有没有起来\n" +
      "  · 起过又停 ⇒ 看进程日志与进程存活（崩溃循环 / 被 kill / 事件循环被堵）",
  );
  process.exit(1);
}

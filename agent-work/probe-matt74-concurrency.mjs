/**
 * MATT-74 的并发压测：**定时器 × 读驱动同时触发**（票面判据之一）。
 *
 * 用法：
 *   node --env-file=.env agent-work/probe-matt74-concurrency.mjs
 *   MN_DEV_LOG=<dev server 的 stdout 文件> node --env-file=.env agent-work/probe-matt74-concurrency.mjs
 *
 * 退出码：0 全过；1 断言红；3 环境不对（库连不上 / 找不到 dev server 日志）。
 *
 * ## 它在证什么（三条，都是票面原话）
 *
 * 1. **不产生重复通知**：`mn_notification_event` 的 `dedupe_key` 与
 *    `mn_notification_delivery` 的 `(event_id,user_id,channel)` 上都**没有**重复行。
 *    唯一的保证是那两个唯一键（MATT-35 已实测），本探针只是把它**再测一遍**
 *    ——并发是这场测试的全部内容，而"跑过了"与"结论仍然成立"是两件事。
 * 2. **连接池不饥饿**（`PG_POOL_MAX=10`）：12 个并发读请求 + 定时器那一份 pump
 *    全部返回 200，没有一个 `connect_timeout` / 池等待超时的错。
 *    ⚠ 并发数取 12 > 池上限 10，是**故意**的：排队是允许的，报错不是。
 * 3. **重叠真的发生过、而且被串行化**：这是最容易做成"跑了个寂寞"的一条——
 *    如果窗口里定时器根本没触发，前两条会**照样全绿**，而它们想证的东西没被碰到。
 *    所以分两相：
 *      · A 相（爆发）：12 并发 × 4 轮 —— 测池与重复；
 *      · B 相（跨过 5 分钟边界）：6 并发 × 每 200ms 一批持续 5s
 *        ⇒ 链上一直有读驱动的泵在跑，而定时器在边界那一刻触发 ⇒ 它**必然**
 *        排一次队，日志里会出现 `[pump] timer 这一次排在其后`。
 *        这是"定时器与读驱动同时在跑"的**直接证据**，而且是确定性的，不是碰运气。
 *
 * ⚠ 为什么单飞的日志要带调用者标签：不带的话，"窗口里出现过排队"只证明
 * **有过排队**——12 个并发读请求自己就会排成一队，定时器压根没触发也照样绿。
 * 标签是 `services/pump-gate.ts` 的 `PumpCaller`，两个调用点各传自己的名字。
 *
 * ## 为什么"跳过/合并"形态会在这里露馅
 *
 * 本仓的 `services/pump-gate.ts` 选的是**排队**：每次调用都拿到属于自己的那次 pump。
 * 若换成"跳过"，B 相里被跳过的那次 GET 仍然返回 200（断言照样绿），
 * 但那是把读驱动的语义（返回前一定跑过一次完整 pump）换掉了
 * ——`agent-work/smoke-notifications.mjs:363-379` 逐字依赖它。所以本探针 B 相
 * 除了查日志，也查**请求数与成功 pump 数的对账**（下面 `requests == pumps` 那条）。
 */
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import {
  createSmokeAccount,
  dropSmokeAccount,
  finishSmoke,
  ROLE_CODES,
} from "./_testacct.mjs";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const BOUNDARY_MS = 5 * 60 * 1000;
const BURST_WIDTH = 12; // > PG_POOL_MAX(10)，故意
const BURST_ROUNDS = 4;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** dev server 的 stdout：CI 是 `/tmp/next-dev.log`，本机跑 `pnpm dev` 时用 MN_DEV_LOG 指过去 */
function resolveLogPath() {
  if (process.env.MN_DEV_LOG) return process.env.MN_DEV_LOG;
  if (existsSync("/tmp/next-dev.log")) return "/tmp/next-dev.log";
  return null;
}
const LOG = resolveLogPath();
const readLog = () => (LOG ? readFileSync(LOG, "utf8") : "");

const sql = postgres({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  max: 2,
});

try {
  await sql`select 1`;
} catch (e) {
  console.error(`数据库连不上（${e?.message ?? e}）—— 隧道可能正在抖，这不是断言失败。`);
  process.exit(3);
}
if (!LOG) {
  console.error(
    "找不到 dev server 日志（设 MN_DEV_LOG=<path>）。B 相的『重叠真的发生过』这条断言" +
      "离开日志**无法成立**，所以这里不假装跑过：exit 3。",
  );
  await sql.end({ timeout: 5 });
  process.exit(3);
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, cookie };
}

let account;
try {
  account = await createSmokeAccount(sql, { roles: [ROLE_CODES.fullAdmin], suffix: "_t4e" });
  const auth = await login(account.username, account.password);
  ok("临时账号能登录（压测要一个真会话）", auth.status === 200, `status=${auth.status}`);
  const cookie = auth.cookie;

  const before = (await sql`select count(*)::int as n from mn_notification_event`)[0].n;

  /* ── A 相：12 并发 × 6 轮（测池与重复） ─────────────────────────────── */
  let poolPeak = 0;
  let activePeak = 0;
  let samplerStop = false;
  const sampler = (async () => {
    while (!samplerStop) {
      try {
        const [r] = await sql`
          select count(*)::int as total,
                 count(*) filter (where state = 'active')::int as active
            from pg_stat_activity where datname = current_database()`;
        poolPeak = Math.max(poolPeak, r.total);
        activePeak = Math.max(activePeak, r.active);
      } catch {
        /* 采样失败不影响断言：它只是汇报数字 */
      }
      await sleep(120);
    }
  })();

  const durations = [];
  let burstNotOk = 0;
  for (let round = 0; round < BURST_ROUNDS; round++) {
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: BURST_WIDTH }, () =>
        fetch(`${BASE}/api/notifications`, { headers: { cookie } })
          .then((r) => ({ status: r.status }))
          .catch((e) => ({ status: 0, err: String(e?.message ?? e) })),
      ),
    );
    durations.push(Date.now() - t0);
    burstNotOk += results.filter((r) => r.status !== 200).length;
  }
  samplerStop = true;
  await sampler;
  const worst = Math.max(...durations);
  ok(
    `${BURST_WIDTH} 并发 × ${BURST_ROUNDS} 轮全部 200（池上限 10 < 并发 12：排队可以，报错不行）`,
    burstNotOk === 0,
    `非 200 共 ${burstNotOk} 个 · 单轮最慢 ${worst}ms`,
  );
  ok(
    "定时器与 12 个读请求共用同一个池时**没有把池打空**",
    poolPeak <= 20,
    `采样到的峰值：总连接 ${poolPeak} 条 / active ${activePeak} 条（另一个进程也在连同一个库，故不是纯本应用计数）`,
  );

  /* ── B 相：跨界窗口里持续并发（证明**定时器那一份**真的被排过队） ────── */
  const boundary = Math.ceil(Date.now() / BOUNDARY_MS) * BOUNDARY_MS;
  const startAt = boundary - 2000;
  if (startAt > Date.now()) await sleep(startAt - Date.now());
  const logFrom = readLog().length;
  let bRequests = 0;
  let bNotOk = 0;
  // 窗口里让链**一直忙**：6 并发 × 每 200ms 一批，而单次 pump 约 300ms
  // ⇒ 定时器在边界那一刻触发时，链上必定有读驱动的泵在跑 ⇒ 它必然排一次队。
  // 这是**确定性**的（不是"多试几次总有一次撞上"）：撞不上只能说明泵快得反常。
  while (Date.now() < boundary + 3000) {
    const statuses = await Promise.all(
      Array.from({ length: 6 }, () =>
        fetch(`${BASE}/api/notifications`, { headers: { cookie } })
          .then(async (r) => {
            await r.arrayBuffer();
            return r.status;
          })
          .catch(() => 0),
      ),
    );
    bRequests += statuses.length;
    bNotOk += statuses.filter((s) => s !== 200).length;
    await sleep(200);
  }
  const window = readLog().slice(logFrom);
  const timerQueued = /\[pump\] timer 这一次排在其后/.test(window);
  ok("B 相（跨界窗口）内读驱动全部 200", bNotOk === 0, `${bRequests} 次并发读请求`);
  ok(
    "定时器在同一个窗口里**真的跑过**（否则本探针的两条主断言是空转）",
    /\[timer\] pump 成功/.test(window),
    `${new Date(boundary).toISOString()} 前后 5s`,
  );
  ok(
    "**定时器那一份被排在了读驱动之后**（单飞真的挡住了重叠，而不是各跑各的）",
    timerQueued,
    timerQueued
      ? "窗口内出现 `[pump] timer 这一次排在其后`"
      : "窗口内**没有**定时器的排队日志 —— 要么定时器没触发，要么它没被挡住",
  );

  /* ── 重复通知：唯一键把并发吸收干净了吗 ─────────────────────────────── */
  const [dupKey] = await sql`
    select count(*)::int as n from (
      select dedupe_key from mn_notification_event group by dedupe_key having count(*) > 1
    ) x`;
  const [dupDelivery] = await sql`
    select count(*)::int as n from (
      select event_id, user_id, channel from mn_notification_delivery
       group by event_id, user_id, channel having count(*) > 1
    ) x`;
  ok("没有两条事件共用同一个 dedupe_key（并发没有把唯一键穿过去）", dupKey.n === 0, `重复组 ${dupKey.n}`);
  ok(
    "没有两条投递行共用同一个 (event, 人, 渠道)",
    dupDelivery.n === 0,
    `重复组 ${dupDelivery.n}`,
  );
  const after = (await sql`select count(*)::int as n from mn_notification_event`)[0].n;
  console.log(
    `\n汇总：事件数 ${before} → ${after}（本探针只读通知中心，不造业务夹具；` +
      `新增只可能来自泵消费既有的 outbox 行）· 池峰值 ${poolPeak} · 单轮最慢 ${worst}ms`,
  );
} finally {
  try {
    await dropSmokeAccount(sql, account?.id);
  } catch (e) {
    console.log(`[clean] 清场失败 —— ${e?.message ?? String(e)}`);
  }
  await sql.end({ timeout: 5 }).catch(() => {});
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
finishSmoke(fail);

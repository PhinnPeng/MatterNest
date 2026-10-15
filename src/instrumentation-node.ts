import { Cron } from "croner";
import { eq, sql } from "drizzle-orm";
import { assertSessionPepperConfigured } from "@/app/lib/server/auth/auth";
import { assertFieldCryptoConfigured } from "@/app/lib/server/crypto/field-crypto";
import { getDb } from "@/app/lib/server/db/client";
import { timerHeartbeat } from "@/app/lib/server/db/schema";
import { pumpAll, type PumpResult } from "@/app/lib/server/services/pump-gate";
import { BUSINESS_TIMEZONE } from "@/shared/time/zh-cn";

/**
 * 应用内定时器：让提醒**不需要有人先打开通知页**（MATT-74 / T4e）。
 * 入口是 `src/instrumentation.ts`（它只做 Edge/Node 分派，理由写在那里的头注）。
 *
 * ## 为什么有这个文件
 *
 * 在此之前 `pumpNotifications()` 的唯一调用点是 `GET /api/notifications`
 * （读驱动），而通知中心无轮询、无徽标 ⇒ **没人打开通知页就没人发提醒**。
 * MATT-35 的原话：「一个要人主动去找才收到的提醒，不是提醒」。
 *
 * 本方案是那条裁决的落地：**零部署件**、不新增进程/容器、不碰
 * crontab / systemd timer / Task Scheduler（本票的硬约束就是它们）。
 * Windows / Linux / Docker 行为一致；`standalone` 与 `next start` 都是单进程
 * （`docs/research-portable-scheduler.md` §3.4）。
 *
 * ## 四个前置件：每一个都防一种具体失败，逐条落位在下面
 *
 * | # | 前置件 | 它防的失败 |
 * |---|---|---|
 * | 1 | `registerNode()`（入口里那个 `register()`）同步返回、不 await 任何 I/O | 「register 抛错 ⇒ 整个 Next 进程 `exit 1`」（**不是 502**：502 需要前面还有反代；真实形态是崩溃循环） |
 * | 2 | `try/catch` 在 **tick 回调体内部** | tick 抛错变 `unhandledRejection`，而那时 `register()` 早已返回 ⇒ 外层 `try/catch` 连执行机会都没有（⚠ 它是否**致命**见下面「实测修正」） |
 * | 3 | croner 配齐 `timezone` / `unref` / `protect` / `catch` | 触发时刻随容器 `TZ` 漂移、进程被定时器句柄拖住退出、重入、未捕获拒绝 |
 * | 4 | pump 的进程内单飞（`services/pump-gate.ts`） | 定时器与读驱动同时各跑一份相同扫描：行锁互等 + 各占一条池连接（`PG_POOL_MAX=10`） |
 *
 * ⚠ 前置件 2 有一半是**反向**的：把整段包在外层 `try/catch` 里更坏，因为它会把
 * 「croner 配置写错」降级成「一行日志 + 定时器压根没起来」——
 * 而**静默不跑与「没人该收」在库里长得一模一样**（`api/notifications/route.ts`
 * 自己写了这句话）。所以 `registerNode()` **故意没有**外层 try/catch：
 * 配置写错就必须响亮地 `exit 1`。
 *
 * ## ⚠ 关于前置件 2 的一处**实测修正**（票面与研究文档的机制描述在本运行时**不成立**）
 *
 * 票面与 `docs/research-portable-scheduler.md` §6.1② 都写：tick 抛错 ⇒ `unhandledRejection`
 * ⇒ Node ≥15 的默认（`--unhandled-rejections=throw`）⇒ **带走整个进程**。
 * **在 Next 16.3.6 上这条不成立**：Next 自己**故意**装了一个进程级的
 * `unhandledRejection` 监听器，它只记日志、**不让进程崩**
 * （`node_modules/next/dist/server/node-environment-extensions/process-error-handlers.js`，
 * 原文：「we're going to intentionally override the default error handling behavior of the
 * outer JS runtime to be more forgiving」「we definitely shouldn't crash the entire process」；
 * 注册点两处且**不分 dev/生产**：`dev/next-dev-server.js:274-275`、
 * `lib/router-server.js:654-655`——后者就是 `next start` 用的那个 server）。
 * `uncaughtException` 同样被它接管成「只记日志」。
 *
 * 本轮实测（反向红三步）：
 *   ① 注入一次 tick 内抛错 ⇒ 进程存活、日志有 `[timer] pump 抛错`（本文件的兜底接住了）；
 *   ② 把 tick 内这层 try/catch 挪到外面 ⇒ **外层 catch 一次都没被触发**（它看不到
 *      async 回调体里的抛错，这一条票面说对了），错误落到 croner 的 `catch` 上，
 *      本文件的「本不该出现」告警**如期打了出来**；
 *   ③ 连 croner 的 `catch` 与 `trigger().catch` 一起摘掉 ⇒ 日志出现
 *      `Unhandled Rejection: Error: …`，而**进程照样活着**（`/login` 仍 200）。
 *      再把 `process.removeAllListeners("unhandledRejection")` 也加上，仍然活着
 *      —— dev 侧还有别的上报路径在接它。
 *
 * ⇒ **所以那层 try/catch 的理由要换，但结论不变**（它必须留在回调体内部）：
 *   1. 它是**应用自己的、按轮次的、带类型**的记录：`pump 抛错` 与 `心跳写入失败`
 *      是两种红，C18 的排障方向依赖这个区分；摘掉它，只剩运行时一句通用日志；
 *   2. 那条「进程不会死」是 **Next 的实现细节，不是契约**（它自己的注释都写着
 *      「It's possible this may always need to be configurable」）；
 *   3. `--unhandled-rejections=strict`、别的宿主、或将来的 Next 都会让默认重新生效
 *      —— 那时这层兜底就是唯一的东西；
 *   4. 定时轮次失败若只剩通用日志，在**应用可观测面**上与「没人该收」同形
 *      —— 那正是本票存在的理由。
 *
 * ## ⚠ 心跳行不可省：这是本方案唯一的结构性短板
 *
 * croner 的状态面（`isRunning()` / `previousRun()`）**答不出「定时器还活着吗」**：
 * 全部状态是**进程内存字段**，进程一死归零；`previousRun()` 在 `finally` 里赋值
 * ⇒**抛异常照样前进**（它记「跑完了」不记「跑成了」）；`isRunning()` 甚至不读 timer 句柄。
 * 「进程内的观察者无法报告自己进程的死亡」是逻辑必然，能突破它的只有**进程外的见证者**
 * ——也就是这张 `mn_timer_heartbeat`（MATT-83，迁移 0015）。详见
 * `docs/research-croner-status-heartbeat.md` §8。
 *
 * 写入形状：**只在 pump 成功之后**、DB 时钟（`now()`）、单条语句原子自增。
 *
 * ## 为什么这文件可以直接写库（而业务写必须走 `/api/**`）
 *
 * `mn_timer_heartbeat` 不是业务表：单行、无软删、无审计，schema 文件头自己写明
 * 「它是 instrumentation 物」（`db/schema/timer-heartbeat.ts:38-42`）。
 * 业务读写一律 `/api/**` 那条规则（禁令⑤）管的是**业务数据与权限范围**，
 * 这里两者都没有——它连 `actor` 的概念都不需要（与 `api/internal/pump/route.ts`
 * 同一个理由：系统动作以 `operator = SYSTEM` 执行）。
 *
 * ## 与 MATT-73 的 `POST /api/internal/pump` 是**两条路，绝不同开**
 *
 * 那个端点是给**应用外**的触发器（systemd timer / croner 脚本）用的：它要 `MN_INTERNAL_TOKEN`
 * （未配即 404、fail closed），还要应用知道自己的 origin。本文件是「应用内定时器」那条路
 * ——**不调那个端点，直接调服务函数**，理由三条写在 `registerNode()` 上方。
 *
 * ## ⚠ 一处已知边界（照实写，不美化）
 *
 * **改了本文件不会热生效**：dev 的自动重启只盯 `CONFIG_FILES`，而 instrumentation 模块
 * 被 Next 永久缓存（`instrumentation-globals.external.js:6,8-13`）⇒ 症状是
 * 「我改了代码，定时器还在跑旧逻辑」、且**没有任何报错**。必须重启 dev server（研究 §3.3 坑 1）。
 */

/** 每 5 分钟（MATT-35 Q5：同一条管线还跑**评论通知**，那是分钟级语义；每天一次会晚 24 小时） */
const PUMP_PATTERN = "*/5 * * * *";

/** 心跳读取侧是 `db:check` 的 C18 探针：超过 3 个周期（15 分钟）即红。周期数改了要同步那里 */
export const HEARTBEAT_STALE_MINUTES = 15;

/**
 * 应用日志。本仓此前 `src/` 里**一处日志都没有**（无 logger 实现，`LOG_LEVEL` 也没人读），
 * 而票面要求「进程存活且**日志有记录**」——所以这里用 `console` 加统一前缀 `[timer]`：
 * 前缀是给人 grep 容器 stdout 用的，也是本票全部证据的抓手。
 */
export type Logger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

const log: Logger = {
  // eslint 里没有 no-console；这是全仓第一个应用日志落点（见上）
  info: (msg) => console.info(`[timer] ${msg}`),
  error: (msg) => console.error(`[timer] ${msg}`),
};

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * 心跳：**只在成功之后**回写（失败不动这行——「时间戳前进」本身就是「跑成了」的口径，
 * 与 croner 的 `previousRun()` 恰好相反）。
 *
 * 三条都与 MATT-83 的探针口径对齐：
 *   · 时间是 **DB 时钟**（`now()`），不是 `new Date()`：容器的墙上时钟漂了不会把
 *     「新鲜」判成「停摆」，且与探针的 `now() - created_at` 同一把尺子；
 *   · `pump_count + 1` **在同一条 SQL 的 SET 里**，不是「先查再加」（无窗口）；
 *   · 单条语句：没有「先读心跳再写」的两步。
 *
 * `returning` 只为把「行没了」从静默变成一行日志：seed 漏跑或那行被人删掉时，
 * UPDATE 影响 0 行而**不报任何错**——那会变成「泵在跑、心跳不动」，
 * 也就是 C18 的「已停摆」态，而真正的原因是这张表被弄丢了（处置方向完全不同）。
 * C18 也会红，但它要等下一次有人跑 `db:check`。
 */
export async function writeHeartbeat(): Promise<void> {
  const db = await getDb();
  const rows = await db
    .update(timerHeartbeat)
    .set({ createdAt: sql`now()`, pumpCount: sql`${timerHeartbeat.pumpCount} + 1` })
    .where(eq(timerHeartbeat.id, 1n))
    .returning({ id: timerHeartbeat.id });
  if (rows.length !== 1) {
    throw new Error(
      `心跳行不在了（UPDATE 影响 ${rows.length} 行）—— seed 0007 没跑过，或那行被删了。` +
        `此刻泵是好的，但 C18 会在 ${HEARTBEAT_STALE_MINUTES} 分钟后报「已停摆」`,
    );
  }
}

/** tick 的依赖：生产走真泵，单测塞假的（**注入只为让前置件 2 能被断言钉住**） */
export type TickDeps = {
  pump: () => Promise<PumpResult>;
  heartbeat: () => Promise<void>;
  log: Logger;
};

/**
 * 一次 tick。**`try/catch` 必须留在这个回调体内部**（前置件 2）。
 *
 * 为什么不能在外层：`tick` 是 async 回调体，`await` 之后抛出的错**不会**被
 * `registerNode()` 外层的 `try/catch` 捕获，它变成 `unhandledRejection`；
 * 而那时 `registerNode()` 早已返回、server ready 早已放行，外层 catch 连执行机会都没有
 * （这一步本轮**实测**过：把兜底挪到外面，外层 catch 一次都没触发）。
 *
 * ⚠ 「变成未处理拒绝 ⇒ 进程死」这一步在 Next 16.3.6 上**不成立**（它自己装了
 * 只记日志的 `unhandledRejection` 监听器）——完整实测与修正见本文件头
 * 「关于前置件 2 的一处实测修正」。这层兜底的理由因此换成：**按轮次、带类型的记录**，
 * 以及「别把进程存活这件事故托在框架的实现细节上」。
 *
 * 两层 `try` 是刻意的：**「泵失败」与「心跳写失败」的处置方向相反**——
 *   · 泵失败：等下一轮（outbox 自愈，`notifications.ts:851-860` 失败只累加 attempts）；
 *   · 心跳写失败：泵是好的，而 C18 会在 15 分钟后报「已停摆」，把人送去查进程存活
 *     ——所以这一条必须自己说清楚「泵没问题，坏的是这一句 UPDATE」。
 *
 * 失败**不写心跳**（口径：心跳 = 成功），所以此处没有「失败也前进」的问题
 * ——那正是 croner 的 `previousRun()` 不能当心跳戳的原因。
 */
export function makeTick(deps: TickDeps): () => Promise<void> {
  return async function tick() {
    try {
      const counts = await deps.pump();
      try {
        await deps.heartbeat();
      } catch (e) {
        deps.log.error(
          `心跳写入失败：**泵是好的**，坏的是这一句 UPDATE ⇒ C18 会在 ${HEARTBEAT_STALE_MINUTES} ` +
            `分钟后报「已停摆」（那一态会把人送去查进程存活，而进程没问题）。原因：${describe(e)}`,
        );
        return;
      }
      const { outbox, scan, archive } = counts;
      deps.log.info(
        `pump 成功 · outbox 扫 ${outbox.scanned}/投递 ${outbox.published}/失败 ${outbox.failed}` +
          `/事件 ${outbox.events} · 节点扫描 扫 ${scan.scanned}/事件 ${scan.events}` +
          ` · 规则 9 扫 ${archive.scanned}/事件 ${archive.events} · 心跳已前进`,
      );
    } catch (e) {
      // 走到这里 = 泵抛错。**这一行是本票「崩溃形态」证据的抓手**：
      // 日志里有它、而进程还活着，就说明前置件 2 在位。
      deps.log.error(`pump 抛错（心跳不前进，等下一轮）：${describe(e)}`);
    }
  };
}

/**
 * `protect` 命中一次 = **上一轮还没跑完就撞上了下一轮**（单次 pump > 5 分钟）。
 *
 * ⚠ 研究（`docs/research-croner-status-heartbeat.md` §5.2）点名的坑：
 * `protect: true` 丢掉那一轮时**不触发任何回调**，`previousRun()` 却照常前进 ⇒
 * 从 croner 的状态面上完全看不出丢过轮。所以这里用的是它的**函数形态**
 * （`CronOptions.protect?: boolean | ProtectCallbackFn`，`dist/croner.d.ts:206`）：
 * 判定语义与 `true` 相同（truthy），但丢轮那一刻**真的会调到这里**（本机实测：
 * 1 秒周期 + 2.5 秒回调，7 秒内 `dropped=4`）——于是「丢轮」第一次有了写入方。
 *
 * 计数是**进程内**的：进程一死归零，重启后看不出历史丢轮。这是记录在案的**限制**，
 * 不是可以补上的洞——心跳表只能表达「距上次成功几个周期」（停摆粒度），
 * 丢轮与停摆的处置方向不同（丢轮 = 泵变慢/超时；停摆 = 定时器没起来），
 * 所以处置方向写在这一行日志里，而**判据本身**在心跳行的 age 上。
 */
let droppedRounds = 0;

export function makeOnOverrun(logger: Logger): () => void {
  return function onOverrun() {
    droppedRounds += 1;
    logger.error(
      `上一轮 pump 还没跑完，本轮被 protect 丢弃（累计 ${droppedRounds} 次）：` +
        `单次 pump 已经超过一个周期（5 分钟）⇒ 这是**变慢/超时**，不是定时器没起来。` +
        `⚠ 心跳表看不出丢轮（它只记最后一次成功），croner 的 previousRun() 反而会照常前进`,
    );
  };
}

/**
 * 建定时器（**同步返回**，前置件 1）：`Cron` 构造是同步的。
 *
 * ## 首轮为什么立即执行（而不是等 5 分钟）
 *
 * 三条，前两条是功能，第三条是门禁：
 *   1. 重启后 5 分钟内到期的提醒/评论通知不必再等一个周期——outbox 积压本来就会在
 *      「下一次 pump」消化（研究 §5.2），把那个「下一次」从「最多 5 分钟后」变成「现在」；
 *   2. 「定时器起来了没有」于是**几秒内**就能在库里看到（心跳行前进），
 *      而不是要等一个完整周期——这正是 C18 探针需要的那种及时性；
 *   3. CI 的顺序问题靠它收敛：`db:check` 的 C18 在写入方落地后是**硬断言**
 *      （要求 15 分钟内有成功 pump），而 CI 的 dev server 是刚起来的
 *      ——若首轮要等 5 分钟，`db:check` 就只能在 CI 里凭空等一轮（见 `.github/workflows/ci.yml`
 *      与 `tools/wait-heartbeat.mjs`：顺序改成「起 server → 等首轮心跳 → db:check → 冒烟」）。
 *
 * 它**不是**「补跑」：节点提醒是「按此刻算还剩几天」的等值判定
 * （`src/shared/notification/scan.ts:81`），多跑一次不会补出任何过期档位，
 * 只会把该发的发得更早（同一业务日的 `dedupe_key` 会吸收重复）。
 */
export function startTimer(
  deps: TickDeps = { pump: () => pumpAll("timer"), heartbeat: writeHeartbeat, log },
): Cron {
  const tick = makeTick(deps);
  return new Cron(
    PUMP_PATTERN,
    {
      /**
       * 前置件 3a：**显式业务时区**。不传时 croner 按本地时区算，而本地时区取决于容器
       * `TZ`（`.env.example` 未设）⇒ Windows 开发机与 Linux 生产容器的触发时刻不同。
       * 取值走 `BUSINESS_TIMEZONE`（`shared/time/zh-cn.ts:41`，全项目唯一的业务时区出口），
       * 不是硬编码字符串。croner 走 Node 自带 ICU，**不读 OS tzdata、不起子进程**
       * ⇒ 这就是「Windows 与 Linux 同构」的机制。
       */
      timezone: BUSINESS_TIMEZONE,
      /**
       * 前置件 3b：**不拖着进程退出**。塞进 Next 进程必须配：一个引用中的 `setInterval`
       * 会让「本该退出的进程」多活一轮。
       */
      unref: true,
      /** 前置件 3c：重入保护 + 丢轮的写入方（见 `makeOnOverrun`） */
      protect: makeOnOverrun(deps.log),
      /**
       * 前置件 3d：**回调抛错不许变成未处理拒绝**。
       *
       * 这一条正常情况下**永远不该触发**：tick 体内已有 try/catch（前置件 2）。
       * 所以这行日志是「前置件 2 被人挪回外面」的**告警**——真触发时说明那层兜底没了，
       * 而那意味着这条失败只剩运行时的一条通用日志（见本文件头「关于前置件 2 的一处实测修正」）。
       * croner 自己的 `catch` 回调抛错会被它静默吞掉（`src/croner.ts:536-538`），
       * 所以这里只做日志，不抛。
       */
      catch: (e) => {
        deps.log.error(
          `⚠ croner 的 catch 被触发 —— 这行**本不该出现**：它意味着 tick 内的 try/catch` +
            `（前置件 2）被挪到了回调体外。原始错误：${describe(e)}`,
        );
      },
      /** 具名只为日志/排查时能认出它（同时进 croner 的 `scheduledJobs`） */
      name: "matternest-notification-pump",
    },
    tick,
  );
}

/**
 * 启动期的密钥自检（MATT-36 决策第 4 项 · 收紧第 3 项）。
 *
 * ## 为什么合在一个函数里，而不是各自挂在启动钩子上
 *
 * 「启动期密钥自检」这个名字覆盖**三把**。若只接 `assertFieldCryptoConfigured()`，
 * 缺 `MN_SESSION_PEPPER` 仍然要到「第一次有人鉴权」才炸 —— 那时应用已经 ready，
 * 而 18 个 `/api/**` handler 全程不可用、`/login` 却报 200。
 * **漏一把比不做更坏**：它会让人以为已经查过了。
 *
 * ## 为什么排在 `startTimer()` 之前
 *
 * 顺序反了不会立刻出事，但会留下一条更难查的形态：定时器已起来、心跳在推进、
 * 只有自检还没执行 —— 于是「密钥缺失」被推迟到某个请求上，而进程日志里那时
 * 已经有「定时器已启动」几行，读的人会先怀疑定时器。
 *
 * ## 为什么抛出去就让它崩，不 catch
 *
 * 与本文件头「前置件 1」同一条纪律：`register()` 抛错 ⇒ 整个 Next 进程 `exit 1`
 * （真实形态是崩溃循环，不是 502）。而这里**就该**是崩溃循环 ——
 * 缺密钥的应用不能对外 ready，那正是 `field-crypto.ts` 文件头说的
 * 「静默降级是最危险的失败形态」。给容器 `restart: unless-stopped`
 * 会重试并留下 stdout 第一行，那行是人话。
 *
 * ⚠ 它只管**密钥**。`PG*` 那几项的启动期断言在 `db/client.ts` 且至今仍只在
 * 首次请求时抛 —— 同一种「ready 了但全 500」的形态，本轮没扩到那里。
 * 这个函数名**不该**被读成「启动期该查的都查过了」。
 *
 * ⚠ 它**可能因缓存已暖而永不抛**：production 里它跑在 instrumentation chunk 的
 * `auth.ts` 实例上，而请求路径跑的是 route chunk 那一份 ⇒ 两个实例、两个缓存，
 * 自检那份必然是冷的。反过来在**单 registry** 的测试里，先跑过的用例会把它暖掉
 * （`src/instrumentation.spec.ts` 的 `vi.resetModules()` 就是为此）。
 */
export function assertServerSecretsConfigured(): void {
  assertFieldCryptoConfigured();
  assertSessionPepperConfigured();
}

/**
 * Next 在**每个 server 实例启动时调用一次**，且「必须完成之后 server 才 ready」
 * （`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md:18`）。
 *
 * **前置件 1（本函数的形态就是它）：同步返回，绝不 await 任何 I/O。**
 * 框架缓存的是 `register()` 的**返回值**（`instrumentation-globals.external.js:21-39,50-56`），
 * 所以启动期的一次 I/O 失败会被永久缓存成 rejected promise ⇒ **整个 Next 进程 `exit 1`**。
 * 真实形态是崩溃循环，**不是 502**（502 需要前面还有一层反向代理；
 * 按 502 排障会去查代理，按 exit 1 排障该看容器 stdout 第一行）。
 *
 * ⚠ 这也是「不调 `POST /api/internal/pump`」的头号理由（票面要求说明为什么）：
 * 三条，一条比一条硬——
 *   1. **自调用要等自己**：`register()` 在 `server.listen()` 之前跑完，
 *      而定时器首轮是立即执行的 ⇒ 那一刻打自己的 `127.0.0.1:3777` 会**必然 ECONNREFUSED**；
 *   2. **要应用知道自己的 origin**：端口在 dev 是 3777、生产由 `PORT` 决定，
 *      没有一处配置保证它自洽（多一层「部署时得配对」的静默失败面）；
 *   3. **要 `MN_INTERNAL_TOKEN` 在本进程里存在**：那个端点缺 token 就 404（fail closed，
 *      MATT-73 的口径），于是「token 没配」会变成**定时器静默不跑**——
 *      正是本票最想消灭的形态（它 `.env.example` 里目前连键都没有）。
 *      HTTP 这一跳换不到任何东西：同一个事件循环、同一个连接池、没有隔离。
 *      **两条路「绝不同开」**（MATT-35）：那个端点是给应用外触发器用的。
 *
 * dev HMR **不会**起第二份：框架的模块级 promise 缓存永不重置（研究 §3.3）。
 * 本仓没有 `globalThis` 单例标记，也不需要——框架防住了「register 重跑」这一类，
 * 而另一类（被 app 代码 import 而重求值）由「定时器只住在本文件里」防住
 * （`services/pump-gate.ts` 的文件头写了这条）。
 *
 * ⚠ 第一句是密钥自检（`assertServerSecretsConfigured()`），**它不是 I/O** ——
 * 只读 env、只做长度校验，所以不违反前置件 1。
 */
export function registerNode(): void {
  assertServerSecretsConfigured();
  const job = startTimer();
  log.info(
    `定时器已启动：pattern=${PUMP_PATTERN} tz=${BUSINESS_TIMEZONE} ` +
      `next=${job.nextRun()?.toISOString() ?? "?"}（首轮立即执行，之后每 5 分钟）`,
  );
  /**
   * 首轮立即执行：**不 await**（前置件 1 只禁止「挡 ready」，不禁止「不等它」）。
   *
   * 用 croner 的手动触发入口 `job.trigger()` 而不是自己另拿一个 tick 引用：
   * `trigger()` 走的就是同一个回调（`src/croner.ts:560-562`），语义就是「现在跑一次」，
   * 于是没有「首轮」与「计划轮」两套行为分叉的可能。
   *
   * ⚠ 它**不是**「计划触发」：`protect` 只在 `_checkTrigger`（计划路径）上生效，
   * 所以「首轮 × 计划轮 × 读驱动」这三个的并发保护**完全**落在前置件 4
   * （`services/pump-gate.ts` 的单飞）上。
   *
   * `.catch` 不是多余的：tick 自身永不拒绝（它体内有 try/catch），但这是本文件里
   * **唯一一个可能逃逸的 promise**（croner 内部步进若抛错，`trigger()` 自己会拒绝），
   * 而一次未处理拒绝就是一条命。日志口径与 `catch` 选项一致。
   */
  void job.trigger().catch((e) => {
    log.error(`首轮 trigger() 自身拒绝了（本不该发生，tick 内部已有 try/catch）：${describe(e)}`);
  });
}

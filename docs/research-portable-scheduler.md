# 可移植定时触发方案：事实核查

> 研究日期 2026-10-13 · 调研对象 `MatterNest`（Next.js 16.3.6 + Drizzle + `postgres` + Postgres 16，`output: 'standalone'`，内网单机私有化，十人企业）
>
> 约束（不可动摇）：**独立于操作系统调度器、任意可部署、零外部服务、开发机与生产同构。**
> 明确排除 crontab / systemd timer / Windows Task Scheduler。
>
> 一手来源口径：Next 的能力取自 `node_modules/next/dist/docs/` 与 `node_modules/next/dist/esm/server/`；库的能力取自 `https://registry.npmjs.org/<pkg>` 与各包 tarball 内的 `dist/` 源码；本仓事实取自代码与 `docs/`。无二手博客。

---

## 1. 结论摘要

| | 一句话结论 |
|---|---|
| **Q-A** | 选 **`croner@10.0.1`**：唯一同时满足「零依赖 + 2026-02 仍在发版 + 时区用 ICU 不碰 OS tz 数据库 + 自带 `unref`/`protect`/`catch`」的库；`node-cron@4.6.0` 可作备选但它的多副本路线要 Redis（已被裁定排除）；`node-schedule@2.1.1` 应排除（3 个依赖、2023-01 最后发版、README 自称不适合 interval）。 |
| **Q-B** | **应用内定时器可行且零部署件**：`register()` 只 `await` 它**返回的** promise，`setInterval` 同步返回 ⇒ **不会挡住 server ready**；框架自带单例（模块级 promise 缓存且永不重置），dev HMR 不会起第二份；`standalone` 与 `next start` 都是**单进程**。但「register 抛错 ⇒ 全站 502」这个说法**机制上是错的**——真实形态是 `process.exit(1)` 崩溃循环。 |
| **Q-C** | **正确性上安全**：`ON CONFLICT DO NOTHING` 与 `merge_count = merge_count + 1` 都是单语句原子操作，没有「查了再插」的窗口；**风险不在连接条数而在连接占用时长**——单次 pump 顺序持有 1 条连接数秒，峰值 3 条；`PG_POOL_MAX=10` 在十人企业下够用但会有排队。 |
| **Q-D** | 节点到期提醒**不补发**（`pickDueReminders` 是 `daysLeft === remindDay` 等值判定），停机 2 小时后错过的档位**永久丢失**；outbox **自愈**（无 `DELETE`，失败只累加 `attempts`）。**⚠ 前半句已被 MATT-78 改掉**（等值 → 区间判定，补发窗口 K=3 天）——见 §5.1 的更新块；outbox 那半句不变。 |

---

## 2. Q-A：自带调度器的选型（一手来源）

### 2.0 实时 registry 数据（`https://registry.npmjs.org/<pkg>`，取于 2026-10-13）

| | `croner` | `node-cron` | `node-schedule` |
|---|---|---|---|
| 最新版本 | **10.0.1** | 4.6.0 | 2.1.1 |
| 该版本发布时间 | **2026-02-01T20:49:29Z** | 2026-07-05T14:44:45Z | **2023-01-11T20:29:02Z**（约 3 年 9 个月前） |
| 首发时间 | 2015-12-09 | 2016-02-04 | 2011-05-12 |
| 总版本数 | 251 | 45 | 45 |
| `dependencies` | **{}** | **{}** | `{cron-parser ^4.2.0, long-timeout 0.1.1, sorted-array-functions ^1.3.0}` |
| `engines.node` | `>=18.0` | `>=20` | `>=6` |
| License / 维护者 | MIT / `hexagon` | ISC / `merencia` | MIT / 5 人 |

> 本仓 `package.json:8` 锁 `"node": ">=22.0.0 <23"`，三者 `engines` 均满足。

### 2.1 `croner@10.0.1` — **推荐**

**依赖树**：`dependencies: {}`，`peerDependencies: {}`。README 首行 badge 即「No dependencies」，并自我描述为「Operates in-memory, with no need for a database or configuration files」。**零外部服务、零外部依赖成立。**

**长驻进程 API 形状**（签名 `new Cron(pattern, options?, fn?)`，见 README「Signature」节）：

```ts
import { Cron } from "croner";
const job = new Cron("*/5 * * * * *", {
  timezone: "Asia/Shanghai",   // IANA 名
  unref: true,                 // 允许进程退出
  protect: true,               // 上一轮未结束则跳过本轮（overrun protection）
  catch: (err) => log(err),    // 吞掉被调函数的未捕获异常
}, async () => { await pump(); });
```

- **有没有 `unref()`**：`unref` 是**构造选项**。源码（`dist/croner.js`）里 `s.unref = s.unref === void 0 ? !1 : s.unref` 并对非布尔值抛错，随后走 `function x(s){ typeof Deno < "u" && typeof Deno.unrefTimer < "u" ? Deno.unrefTimer(s) : s && typeof s.unref < "u" && s.unref() }` —— 底层就是 `timer.unref()`。独立进程里**应当保持默认 `false`**（否则进程跑完任务就退出了）；塞进 Next 应用进程时**应当设 `true`**（见 Q-B）。
- **有没有 `protect()`**：有，同为构造选项。`_checkTrigger` 的逻辑是 `let n = this._states.blocking && this.options.protect; r && !n ? 触发 : r && n && 是函数 ? setTimeout(() => this.options.protect(this), 0)` —— 即「上一轮还在跑（`_states.blocking`）就跳过本轮并回调」。**对本项目直接有用**：它把「定时器重入」变成不可能，而不用自己写单飞。
- **进程要不要阻塞退出**：默认阻塞（`unref: false`）。文档 Warning 明写「Unreferencing timers (option `unref`) is only supported by Node.js and Deno」。

**漏跑语义**：**不补跑**。`_next(e)` 的入参是 `e || this._states.currentRun`，都没有时取当前时刻；下一轮永远是从「现在」起算的下一个匹配时刻。进程停 2 小时再起来，那 2 小时里的 24 个五分钟槽位**一个都不会重放**。唯一相关的是 `maxRuns`（默认 `Infinity`，用完就停）与 `interval`（两次触发之间的最小秒数间隔）。

**时区 / DST**：

- 默认**按本地时区**。`timezone` 选项接受 IANA 名（Europe/Stockholm 格式），源码走 `new Intl.DateTimeFormat("en-US", { timeZone: e, ... }).formatToParts(...)`（`dist/croner.js` 中 `function g(s,e)`），**只用 Node 自带的 ICU，不读 OS 的 tzdata、不起子进程调 `date`**。这是「Windows 与 Linux 同构」的硬证据：两端 tz 规则都来自 Node 二进制里的 ICU。
- DST 语义（README 原文）：「Jobs scheduled during DST gaps are skipped; jobs in DST overlaps run once at first occurrence.」
- 对本项目：`Asia/Shanghai` 自 1991 年起无夏令时，**DST 分支根本走不到**。真正的雷不是 DST，是**默认值**：不传 `timezone` 时，本地时区取决于容器 `TZ`（`.env.example` 未设 `TZ`）——Windows 开发机与 Linux 生产容器会落在不同的墙上时间触发。**必须显式传 `timezone: 'Asia/Shanghai'`。**

### 2.2 `node-cron@4.6.0` — 备选，但不推荐作为首选

**依赖树**：`dependencies: {}`，零依赖，ISC，README badge「zero dependencies」。这一点与 croner 打平。

**API 形状**：`cron.schedule('* * * * *', async (ctx) => {...}, { name, timezone, noOverlap, unref, maxRandomDelay, missedExecutionTolerance })`。

- **`unref`**：`TaskOptions` 里有 `unref?: boolean`（`dist/node-cron.d.ts:40`），内部对 `heartBeatTimeout` 与 `jitterTimeout` 调 `.unref()`（`dist/_shared.js`：`this.heartBeatTimeout = setTimeout(heartBeat, ...); if (this.unref) this.heartBeatTimeout.unref();`）。
- ⚠ **`task.unref()` 方法对内联函数任务无效**：`dist/node-cron.js` 里 `unref() { if (!this.forkProcess) return; ... }` —— 它 unref 的是**后台 fork 出来的子进程**，内联任务直接静默返回。**只有 `unref: true` 选项能用**，方法不能。
- **`protect()` 对应的能力叫 `noOverlap`**：`this.noOverlap = options?.noOverlap === undefined ? false : options.noOverlap`，并有 `execution:overlap` 事件。语义与 croner 的 `protect` 一致。

**漏跑语义**：**三家里唯一会重放的**，但只在进程存活期间。`dist/_shared.js` 的 `planBeat(expected, now, toleranceMs, getNextMatch)` 把已经过去的槽位 `missed.push(slot)`，调用方 `for (const missedSlot of plan.missed) runAsync(...)` 逐个重放；`DEFAULT_MISSED_EXECUTION_TOLERANCE = 1000`（1 秒容差内的那一个直接立即跑）。**但进程重启后 `expectedNextExecution` 从当前时刻初始化，停机期间的槽位照样丢失。** 也就是说 node-cron 补的是「事件循环被阻塞导致的迟到」，不是「进程不在导致的缺席」——**对 Q-D 的场景没有帮助**。

**时区 / DST**：`timezone` 选项。README 原文：「Across a daylight-saving fall-back the repeated hour runs once, so a sub-hourly schedule (for example `*/15`) can pause for up to the length of the DST shift during that hour. If you need a fixed interval to keep firing uninterrupted across DST transitions, use a zone without DST, for example `timezone: 'UTC'`。」

实现同样是 ICU：`dist/_shared.js:706` `buildDateParts` → `getPartsFormatter(timezone)` → `formatToParts`，`:743` `getTimezoneGMT` → `Intl.DateTimeFormat` 的 `timeZoneName`。**与 croner 同为零 OS tz 数据库依赖。**

**为什么不首选**：

1. 它把「多副本协调」做成卖点（`distributed: true` / `setRunCoordinator`），README 明确说高可用要「plug in a Redis coordinator」。Redis 已被裁定不引入，这块是死代码。
2. `engines.node: ">=20"`。本仓锁 Node 22 没问题，但比 croner 的 `>=18` 更紧。
3. **漏跑会重放**：对本项目是**负资产**（见 Q-D.1，节点提醒是档位等值判定，重放 24 轮只会白跑 24 次索引扫描，什么也补不回来）。

### 2.3 `node-schedule@2.1.1` — **排除**

**排除理由（三条，各自独立成立）**：

1. **有依赖**：`cron-parser ^4.2.0` + `long-timeout 0.1.1` + `sorted-array-functions ^1.3.0`。本仓对新增依赖的成本敏感，且 `cron-parser` 本身还会再拖一层。
2. **停更**：`2.1.1` 发布于 **2023-01-11**，距今约 3 年 9 个月。
3. **README 自己说不适合本需求**（原文）：「Node Schedule is for time-based scheduling, not interval-based scheduling. While you can easily bend it to your will, if you only want to do something like "run this function every 5 minutes", **toad-scheduler** would be a better choice.」
   附带的坑：README 还说「Currently, `W` (nearest weekday) and `L` (last day of month/week) are not supported」。
4. **`Job.cancel()` 是唯一控制手段，没有 `unref`**（源码 `lib/Job.js` 暴露 `cancel()`）。

---

## 3. Q-B：应用内定时器（零部署件）

### 3.1 `register()` 的精确契约 —— 「must complete before the server is ready」到底挡什么

文档原文（`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md:18`）：

> The file exports a `register` function that is called **once** when a new Next.js server instance is initiated, and **must complete before the server is ready to handle requests**. `register` can be an async function.

实现（`node_modules/next/dist/esm/server/lib/router-utils/instrumentation-globals.external.js:21-39`）：

```js
async function registerInstrumentation(projectDir, distDir) {
    if (process.env.NEXT_PHASE === 'phase-production-build') { return; }   // :23
    if (!instrumentationModulePromise) { instrumentationModulePromise = getInstrumentationModule(...); }
    const instrumentation = await instrumentationModulePromise;
    if (instrumentation?.register) {
        try {
            await instrumentation.register();                                // :32
            extendInstrumentationAfterRegistration();
        } catch (err) {
            err.message = `An error occurred while loading instrumentation hook: ${err.message}`;
            throw err;                                                      // :36
        }
    }
}
```

**答**：框架 `await` 的是 **`register()` 的返回值**，不是它内部做了什么。因此：

- `register()` 同步返回 `undefined` ⇒ `await undefined` 在**微任务**里就 resolve ⇒ **`setInterval(...)` 不会挡住 server ready**，超出「挡 ready」的语义一个字节都不占。
- 只有 `register()` **返回/抛出一个尚未 settle 的 promise** 才会挡住 ready。「must complete」的准确含义是「它的返回值必须先 settle」。

这条判断有直接推论：**不要在 `register()` 里 `await` 首次 pump**。`await pumpNotifications()` 会把「数据库连不上」升级成「server 起不来」，而这正是本仓 `db/client.ts:78-93` 已经踩过并写进注释的同一个坑（缓存 rejected promise ⇒ 进程从此 500，`重启 dev server 就好` 只是掩盖根因）。**框架在这个点上犯了和 `getDb()` 一模一样的错**：`registerInstrumentationPromise`（`:50-56`）缓存的就是那个 promise，失败被永久缓存：

```js
let registerInstrumentationPromise = null;
export function ensureInstrumentationRegistered(projectDir, distDir) {
    if (!registerInstrumentationPromise) {
        registerInstrumentationPromise = registerInstrumentation(projectDir, distDir);
    }
    return registerInstrumentationPromise;
}
```

调用点有三处，全部 `await`：`NextServer.prepareImpl()`（`dist/esm/server/next-server.js:504-510`）、`RouteModule.prepare()`（`dist/esm/server/route-modules/route-module.js:355-361`，注释明写「so any caller of `RouteModule.prepare` … still observes the instrumentation hook completing before the userland route handler runs」）、dev server（`dist/esm/server/dev/next-dev-server.js:484-486`）。**第三条最重要：`prepare` 在请求路径上**，所以 register 的失败不只挡启动，也挡每一个请求。

### 3.2 独立复核：「register 抛错 ⇒ 全站 502」这个判断

**结论：实质方向对，机制描述错。** 分三层说：

| | 说法 | 核实结果 |
|---|---|---|
| ① 实质 | 「register 抛错会把轮询代码的 bug 升级成全站不可用」 | ✅ **成立**，而且比 502 更硬。见下表。 |
| ② 机制 | 「全站 502」 | ❌ **不成立**。standalone 的失败形态是 `console.error(err); process.exit(1)`，不是返回 502。 |
| ③ 修法 | 「`try/catch` 包裹能消掉它」 | ⚠ **只能消掉一半**，且消的不是最危险的那一半。见下。 |

**② 的证据（失败形态）**：

- **standalone**：`server.js` 的模板在 `dist/build/utils.js:1143-1154` 生成，尾部是

  ```js
  startServer({ dir, isDev: false, config: nextConfig, hostname, port: currentPort, allowRetry: false, keepAliveTimeout })
    .catch((err) => { console.error(err); process.exit(1); });
  ```

  `prepare()` 链路（`NextServer.prepareImpl` → `ensureInstrumentationRegistered`）在 `startServer` 内，reject 直接冒到上面这行 ⇒ **进程带 exit code 1 退出**。Docker `restart: always` ⇒ 崩溃循环。
- **`next start` / `start-server.js:439-444`**：`catch (err) { handlersError(); console.error(err); process.exit(1); }` —— 同样 **exit 1**，且发生在 `server.listen()` 之后（`:446`），所以端口会先占用再瞬间释放。
- **502 是谁产生的**：只有当前面还挂了一层反向代理（nginx / 阿里云 ALB）时，它会对「连接被拒」回 502。**本项目是内网单机 Docker 部署，链路上未必有代理**——即便有，502 也是下游症状，根因日志在容器 stdout 里是 `process.exit(1)`。**写成「全站 502」会把排障方向带到代理配置上，而真正的信息在应用启动日志第 0 行。**

**③ 的证据（`try/catch` 能消什么、不能消什么）**：

```ts
export function register() {
  try { setInterval(tick, 5 * 60_000); } catch (e) { /* 记日志 */ }
}
```

- **能消掉的**：`new Cron(...)` 的**同步参数校验抛错**（croner 对 `unref` 非布尔、对 `utcOffset` + `timezone` 同时给都会 throw）。这类错确实会让 server 起不来。
- **消不掉的（也是真正致命的）**：`tick` 是 async。**`try/catch` 不会捕获异步回调体里抛出的错**，`await pumpNotifications()` 抛出的异常会变成 `unhandledRejection`。而 `register()` 早已返回、ready 早已放行——所以这个 `try/catch` 对它**完全无效**。要兜住异步体，得把 `try/catch` 放进 `tick` **里面**（或开 `{ catch: handler }` / `noOverlap: true`）。
- **反向的风险**：`try/catch` 会把「配置写错了」降级成「一行日志 + 定时器根本没起来」。对轮询器来说，**静默不跑**和「压根没跑」在库里长得一模一样**（`src/app/api/notifications/route.ts:13-15` 自己写了这句话：「那种形态与『没人该收』在库里长得一模一样（零事件）」）。所以这里 `try/catch` 的代价是**把响亮的启动失败换成安静的零事件**。

**净判断**：那个代理的**告警是对的**（别在 `register()` 里裸放可能抛错的东西），但**它给出的后果与修法都不准**。正确形态是三层：
1. `register()` 同步返回，绝不 `await` 任何 I/O（否则把库抖动升级成启动失败）；
2. `tick` 内部自带 `try/catch`，失败只记日志、不打断 interval；
3. 定时器用 `{ protect: true, catch: log }`（croner）或 `{ noOverlap: true }`（node-cron），杜绝重入与未捕获拒绝。

### 3.3 dev HMR 会不会起多份

**不会——框架自带单例，不用自己写 `globalThis` 标记。**

证据：§3.1 引的那段里，`cachedInstrumentationModule`（`instrumentation-globals.external.js:6,8-13`）与 `registerInstrumentationPromise`（`:50-56`）都是**模块级 `let`**，全仓检索 `dist/esm/server` 后**只有这一个文件在写它们，没有任何地方重置**。因此：

- HMR 让 app 模块重求值时，`register()` **不会**重跑——`ensureInstrumentationRegistered` 直接返回已 settle 的那个 promise。
- 这条对 dev 与 prod **都成立**，因为它是同一个模块。

**但由此派生出两个必须知道的坑：**

1. **改了 `instrumentation.ts` 不会热生效**。dev server 的自动重启只盯 `CONFIG_FILES`（`dist/esm/server/lib/start-server.js:470-472`），不含 instrumentation 文件；而 `cachedInstrumentationModule` 又让 `require()` 永远拿第一次那份。**症状是「我改了代码但定时器还在跑旧逻辑」，且没有任何报错。** 必须重启 dev server。
2. **`setInterval` 绝不能放在被 app 代码 `import` 的模块里**。放 `instrumentation.ts` 的 `register()` 里（并按官方建议在 `register()` **内部** `await import()`，见 `instrumentation.md:52-68`「We recommend importing the file from within your `register` function, rather than at the top of the file」）是安全的；一旦被 route handler import 链带进来，HMR 就会按模块重求值起第二份。**这才是社区惯用的 `globalThis` 单例标记真正要防的场景**——框架防住了第一种，没防第二种。

### 3.4 `output: 'standalone'` / `next start` 会不会 fork 多进程

**不会。单进程。**

- **standalone `server.js` 的完整模板**在 `dist/build/utils.js:1111-1154`。逐行读：**没有 `cluster`、没有 `worker_threads`、没有 `child_process.fork`**，就是 `require('next')` → `startServer({...})`。
- 全仓 `dist/esm/server/lib/start-server.js` 检索 `cluster|Worker(|worker_threads`：**零命中**。
- 整个 `dist/build` 里 `worker_threads` 只出现在 `dist/build/swc/loaderWorkerPool.js`——那是**构建期**的 SWC loader，不是运行时。
- 本仓无 `middleware.ts`、无 `proxy.ts`、无 `export const runtime = 'edge'` 的路由（`src/app/api` 下 53 个 `route.ts` 全是默认 Node runtime），因此 Edge runtime 的 `enhanceGlobals()`（`dist/esm/server/web/globals.js:98` 里的 `void ensureInstrumentationRegistered()`）这条旁路不会触发。

**风险评估：单副本裁定下，多份定时器的风险 = 0。** 唯一的重复来源是 3.3 的第 2 条（被 app 代码 import），不是进程数。

### 3.5 Next 官方有没有「判断我是唯一实例」的手段

**没有。** 检索 `node_modules/next/dist/docs/`（全目录）没有任何 leader election / lease / 唯一实例的 API、配置项或指南；`serverExternalPackages.md` 里出现的 "cron" 是无关的字符串。

最接近的两条：

1. **隐式单例**：`register()` 每进程一次（§3.3）。在单副本裁定下这就够了。
2. **数据库级单例**：`pg_try_advisory_lock()`。`worker/README.md` 的计划里写了「每个任务都用 `withSingleFlight()`（内含 `pg_try_advisory_lock`）」——**但全仓 `src/` 检索 `advisory_lock|withSingleFlight` 零命中，这段是纸面计划、尚未实现。** 真要多副本，这是唯一不需要 Redis 的答案（ advisory lock 走已有的 10 条连接，不新增部署件）。

---

## 4. Q-C：定时器与现有管线的相容性

### 4.1 连接池压力：风险不在「条数」，在「占用时长」

先数清楚 `consumeOutbox()`（`src/app/lib/server/services/notifications.ts:774-863`）的最坏查询数。

**外层**：1 条 `SELECT ... WHERE published_at IS NULL ORDER BY id LIMIT 50`（`:782-792`），**不在事务内**，查完即释放。

**每行一个事务**（`:801`），事务内的语句：

| 步骤 | 代码位置 | 条数 |
|---|---|---|
| `loadHostFacts` | `:813` | 1 |
| 每意图 × 每 payload → `emitForHost` → `resolveRecipients` | `:439`（仅当 receivers 含 `co_owner`/`follower` 才查 `:178-182`） | 0 或 1 |
| `INSERT mn_notification_event … ON CONFLICT DO NOTHING RETURNING` | `:314-334` | 1 |
| `recipientScopes`（一次查完全部收件人的角色） | `:345` | 1 |
| **每收件人一次 `canSeeHost`** ← N+1 | `:348` → `:240-260` | **N** |
| **每收件人一次 `INSERT mn_notification_delivery`** ← N | `:364-396` | **N** |
| `UPDATE mn_notification_event SET recipient_count` | `:398-401` | 1 |
| `UPDATE mn_event_outbox SET published_at, attempts` | `:839-845` | 1 |

取最坏值：50 行 × 每行 1 意图、10 个收件人 ⇒ 每行 ≈ `1 + 1 + 1 + 1 + 10 + 10 + 1 + 1 = 26` 条 ⇒ **单次 `consumeOutbox` 上限约 1300 次顺序往返**。

**关键事实：这个 for 循环是严格顺序的（`for (const row of pending)`，`:799`），不是 `Promise.all`。所以并发连接数始终是 1。** 但单条连接被占用的**时长**是 1300 次 RTT。`postgres` 的池上限 10（`db/client.ts:45` 读 `PG_POOL_MAX`），连接池耗尽不会发生；会发生的是**排队**——第 11 个来客在 `postgres` 内部排队，`connect_timeout: 5`（`:46`）只管「建连」不管「等池」，所以它会静静等到前面的 pump 放连接。

`scanDueNodes`（`:894-1023`）同理：

- 开局 `Promise.all([scanHost("matter"), scanHost("risk_matter")])`（`:934`）⇒ **瞬时 2 条并发连接**，两条查完就进入顺序循环。
- 循环内 `loadHostFacts` 按 `hostId` 缓存（`:943-947`），每节点每命中档位 1 个事务，含 `nodeOwnerOf`（`:968`）+ `resolveRecipients`（`:969`）+ 上面那套 N+1。
- 上限 `SCAN_BATCH = 500`（`:100`）× 2 表 ⇒ 最坏 1000 个节点，但**只有 `pickDueReminders` 命中的才开事务**（`:959` `if (due.length === 0) continue`）。稳态下命中数是个位数到几十。

**「2×500 行逐行开事务会不会耗尽连接池」的答案：不会。** 峰值并发是 2（开局那两条 SELECT），之后恒为 1。真正的成本是**一次 pump 可能把一条连接按住几秒**，而 `GET /api/notifications` 自己在 `await pumpNotifications()` **之前**就已经占着一条连接做列表查询——于是一个用户请求进来时，可能是 **2 条连接同时在跑两份一模一样的 pump**。

**`PG_POOL_MAX=10` 够吗？** 十人企业、单副本、稳态命中数个位数 ⇒ **够**。但 4.2 会说明这个「够」有一个前提。

### 4.2 定时器与读驱动同时触发：会不会出并发问题

**正确性上：安全。** 逐条核实：

1. **`dedupe_key` 是真正的原子闸门。** `insertNotificationEvent`（`:314-334`）是**单条** `INSERT … ON CONFLICT DO NOTHING RETURNING id`。**不存在「先 SELECT 判断没有、再 INSERT」的窗口**——这正是 `shared/notification/dedupe.ts:8-10` 写死的理由（「应用层判重要在『查一次再插一次』之间留一个窗口，而那个窗口在多副本下必然被穿过」）。两个事务同时插入同一个 key：一个成功，另一个拿到 0 行。
2. **合并计数不会丢更新。** 输家走 `:338-342` 的 `UPDATE … SET merge_count = merge_count + 1 WHERE dedupe_key = …`——`merge_count + 1` 是**读改写写在同一条 SQL 里**，PG 行锁保证不丢更新。输家的这条 `UPDATE` 会**阻塞**在赢家的行锁上直到其提交（READ COMMITTED 下随后重读该行再 +1，结果正确）。
3. **投递行不会重复。** 只有赢家会往下走到 `:347-396` 插 `notificationDelivery`，输家在 `:342` 就 return 了。且投递表自己还有 `ON CONFLICT DO NOTHING (event_id, user_id, channel)`（`:390-396`）兜底。
4. **节点提醒的 `dedupe_key` 不含 `batchId`，这是刻意的。** `:1002` 给每次扫描发一个新的 `randomUUID()` 当 `event_batch_id`，而 `scheduledDedupeKey`（`shared/notification/dedupe.ts:73-79`）只吃 `eventType : targetId : dateKey`。**所以两份并发扫描算出的是同一个 key**——如果 `batchId` 被塞进了 key，并发扫描就会各插一条，通知翻倍。当前实现避开了这个坑（注释在 `:998-1001`）。
5. **`consumeOutbox` 双重消费同一 outbox 行**：两个消费者都查到 `published_at IS NULL`、都跑 `emitForHost`，由 (1) 吸收；随后**双方都**执行 `UPDATE event_outbox SET published_at=now(), attempts = attempts + 1`（`:839-845`）。`attempts` 被多计一次，但它是计数器不是判据，**无害**。`published_at` 被后写者覆盖，无害。

**但有一个真实的并发代价，而且它恰好打在 4.1 的池上：**

定时器 pump 与用户请求 pump 撞车时，两边会**同时**对同一个 `dedupe_key` 发 `INSERT … ON CONFLICT DO NOTHING`。输家那条语句**阻塞在赢家的行锁上**，直到赢家整个事务提交——而赢家事务里还包含 `:364-396` 的 **N 次串行 `INSERT notificationDelivery`**。也就是说：**一次并发重叠会把「等锁」的成本放大成一整个事务的时长**，而这段时间里两边各占着一条池连接。N=10 时这是几百毫秒量级的白等。

更糟的是**用户请求那一侧**：`route.ts:54-55` 在返回列表**之前** `await pumpNotifications(); await scanArchiveIncomplete();`。用户点开通知中心，要先等两份 pump 跑完才看到列表。定时器让这件事从「偶尔」变成「每 5 分钟一次」。

⇒ **定时器不能取消读驱动侧的 pump，只能与之共存**。缓解手段是让重叠**便宜**：`protect: true` / `noOverlap: true` 能挡**定时器自己**重入，**挡不住与用户请求的重叠**。真正能挡的是给 pump 加一个进程内单飞标志（或 `pg_try_advisory_lock`）——两者都只挡「同时刻」，不挡「一先一后」。

### 4.3 `consumeOutbox` 用独立事务，无请求上下文时安全吗

**安全。** 三点：

1. **它是设计上就要独立的事务。** `db.transaction(async (tx) => {...})`（`:801`）自己 `getDb()`（`:781`），完全不依赖调用方的事务句柄。`pumpNotifications`（`:1043-1050`）本身也**不接收 `Tx` 参数**——类型上就不可能误用调用方事务。
2. **它不写审计、不读 actor。** `pumpNotifications` 的注释（`:1040-1041`）明写：「系统动作没有 `actor`：规则以 `operator = SYSTEM` 执行（权限草案 §8），而本函数不写审计、不读用户范围，所以拿不到 actor 也不影响正确性。」定时器调它与请求调它，在这一点上**没有区别**。
3. **`getDb()` 的懒建池对无请求上下文友好**。`db/client.ts:74-97`：池在模块加载期不碰网络（注释明写「Next 会在构建期 import 路由文件」），第一次 `getDb()` 才 `makePool()`。定时器在进程启动后触发，届时 `.env` 已被 `startServer` 载入。启动断言 `assertSessionConventions`（`:57-72`）会**当场抛错**——这是好事：它让「会话时区不是 UTC」这种静默错误变成一次响亮的失败，而不是错 8 小时的提醒。

⚠ **一个只在定时器形态下才存在的坑**：`client.ts:88-93` 里 `asserted` 缓存的是 promise，失败时置回 `undefined` 让下一个请求重试。**定时器不是请求**——如果它在启动瞬间（DB 还没就绪）跑一次并撞上断言失败，`asserted` 被清空，下一个**请求**会重试；这没问题。但如果 `consumeOutbox` 的某个事务中途失败并被 `:851-860` 的 catch 吞掉，`asserted` 不会被清空，**下次 pump 会永久复用同一个 rejected promise**——除非失败的是断言本身（断言在 `:89` 已有 `.catch` 复位）。核对代码：断言有复位、事务失败不碰 `asserted`，所以**没有这个洞**。记录在此以免后人改坏。

### 4.4 长扫描会不会耗尽连接池

见 §4.1：**峰值 3 条**（`scanDueNodes` 开局 `Promise.all` 的 2 条 + 同时段 `consumeOutbox` 占的 1 条），之后恒为 1。`PG_POOL_MAX=10` 有 7 条余量给十个用户。**不会耗尽。**

真正的边界条件是**延迟**，不是条数：`connect_timeout: 5`（`:46`）只覆盖建连。若一次 pump 把连接按住超过某个用户请求的等待预算，用户看到的是**慢**，不是错。**十人企业 + 稳态命中个位数 ⇒ 可接受。** 出现下列任一情况就要重新算：

- 单次 `consumeOutbox` 真的攒到 50 行积压（outbox 停了 2 小时）；
- `scanDueNodes` 命中节点数进入三位数（意味着大批节点同时跨过 7/3/1 档位，比如年度批量导入）。

---

## 5. Q-D：崩溃恢复与漏跑

### 5.1 进程停 2 小时再起来，节点到期提醒会怎样

> **⚠ 更新（MATT-78，2026-10-17）：本节结论已按产品裁定改动。**
>
> 下面这一小节记录的是**改动前**的状态（等值判定），它作为"缺陷为什么存在"的取证仍然成立；
> 但「**不会补发 / 错过的档位永久丢失**」这个结论**对节点提醒已经不成立**：
> `pickDueReminders` 现在是**区间**判定 `remindDay - K < daysLeft <= remindDay`
> （`SCAN_CATCHUP_DAYS = 3`，**K 是产品裁定**），所以档位当天没跑到、之后 K 天内补跑仍会发出。
> 窗口**只朝 `daysLeft` 更小的一侧**扩（`daysLeft` 随日子递减，跨过档位后恢复时它已经小于档位，
> 反方向补不回任何东西）；代价是**晚发**（最迟在还剩 `d-K+1` 天时发出「还有 d 天」），
> 而**停机超过 K 天的那部分仍然会丢**——这一条没有变。
> 连带：scheduled `dedupe_key` 从"扫描日"改成"截止业务日 + 档位"（否则补发窗口内三天各发一条），
> 对齐件已回写 `docs/PRD-phase1-design-revision-r1.md` §7.2（R3）。
> 与规则 9 的对照（下一条 ⚠）**仍然成立**：规则 9 是下界无上界，参数也另算。

**不会补发。错过的档位永久丢失。** 这是本轮最重要的发现（**已过时，见上面的更新块**）。

`src/shared/notification/scan.ts:69-83`（**改动前**的实现，MATT-78 之后 `:81` 那一行是区间判定）：

```ts
export function pickDueReminders(node: ScannableNode, now: string | Date): DueReminder[] {
  if (!node.isTimeConfirmed) return [];
  if (!(SCANNABLE_NODE_STATUSES as readonly string[]).includes(node.status)) return [];
  if (node.isDeleted) return [];
  if (!node.deadlineTime) return [];
  const daysLeft = businessDaysBetween(now, node.deadlineTime);          // :76
  if (daysLeft < 0 || daysLeft > SCAN_WINDOW_MAX_DAYS) return [];        // :78
  const eventType = node.timeType === "range" ? "node_due_end" : "node_due_start";
  const hit = [...new Set(node.remindDays)].filter((d) => d === daysLeft) // :81  ← 等值
                 .sort((a, b) => a - b);
  return hit.map((days) => ({ eventType, daysLeft: days }));
}
```

**`d === daysLeft` 是等值判定，不是 `d >= daysLeft`。** 所以它回答的是「**此刻**还剩几天，恰好命中哪一档」，而不是「**期间**跨过了哪几档」。

停机 2 小时的影响，逐档看（业务日粒度，`businessDaysBetween` 按上海日历天算，`src/shared/time/zh-cn.ts:79-81`）：

- 停机 < 一个业务日：`daysLeft` 不变 ⇒ **完全无影响**，档位照样命中。
- 停机跨过了一个业务日边界：`daysLeft` 已经 -1 ⇒ 原来该发的那一档（比如剩 3 天）**永远不会发**；而 `remind_days` 剩下的档位**仍然会正常发**（1 天档、0 天档的判定照常成立）。

**结论（这就是「天壤之别」）：这是「按现在算还剩几天」，不是「补发错过的档位」。** 用户不会收到一串过期的「你还有 7 天 / 你还有 3 天」，而是**那两天里一条都不发**，然后在**还剩 1 天**那天收到那一条。停机 2 小时 ⇒ 最多丢一档。

这个选择**是对的**（补发过期提醒是噪声，用户看到「你还有 3 天」而实际只剩 1 天会更糟），但它有一个后果必须写进设计：**「停机期间漏跑」与「提醒恰好没配置」在库里长得一模一样**——事件表里没有那一行。排障时唯一的线索是 `scanDueNodes` 的返回值 `scanned`（`:1022`）与 `events`（`:1018`）的差。

⚠ **同一坑在规则 9 上不存在**。`judgeArchiveReminder`（`src/shared/notification/archive-reminder.ts:99-141`）用的是 `daysClosed < config.days` 与 `daysSinceLastNotify < config.cooldownDays`——**两个都是下界判定**，停机 2 小时后 `daysClosed` 只会更大 ⇒ 照发。**两条规则对「停机」的鲁棒性相反**，选型时不要以为它们是一类。

### 5.2 outbox 积压会自愈吗

**会，而且是设计意图。**

1. **行持久保留**：`mn_event_outbox` 上没有任何 `DELETE`（`db/schema/outbox.ts` 全文 45 行只有 schema 定义；`services/notifications.ts` 检索 `delete(` **零命中**）。`published_at IS NULL` 的行**一直留在表里**直到消费成功。
2. **失败只记账不丢弃**：`:851-860` 的 catch 分支只 `UPDATE … SET attempts = attempts + 1, last_error = …`，**不回填 `published_at`** ⇒ 下一次扫描还会扫到它。`attempts` 与 `last_error`（`outbox.ts:36-37`）是**给运维看的重试账本**。
3. **没有死信**：一条永久坏行（比如 payload 里有个永远解析不出来的字段）会**每次扫描都失败一次**，`attempts` 无限增长，占用每次 pump 的一个槽位。当前上限是 50（`OUTBOX_BATCH`，`:98`），所以它会吃掉 1/50 的预算——**不会拖垮，但会永远刷错误日志**。若将来出现，这是需要「连续失败 N 次后标记跳过」的地方；现在不是。
4. **幂等由数据库兜住**：至少一次语义 + `ON CONFLICT DO NOTHING`（`outbox.ts:9-11` 头注明写「消费侧必须去重」）。重放同一行**不会**产生第二条通知。

⇒ **停机 2 小时后，outbox 会在下一次 pump 一次性消化掉积压**，代价是 §4.1 那笔查询数（50 行 × 26 ≈ 1300 次往返，单连接顺序跑）。**这是定时器第一次上线时最需要盯的一项。**

### 5.3 应用内定时器：重启 ⇒ 定时器重来

**是同一个问题，而且更小。**

- `register()` 每进程跑一次（§3.3）⇒ 重启后 interval 从零开始，**第一个 tick 在 5 分钟后**，不是「立即补跑」。
- 对 **outbox**：与 §5.2 完全相同——下一轮自然消化，无损失。
- 对 **节点提醒**：与 §5.1 完全相同——`pickDueReminders` 按「此刻」判定，重启不改变判定结果，**该丢的还是丢**。
- **唯一的新东西**：重启会丢掉「上一次 pump 跑到哪」的进度记忆。但 `consumeOutbox` 没有进度概念（它靠 `published_at IS NULL` 做续传，`notifications.ts:765`：「**至少一次**：只扫 `published_at IS NULL`，成功才打时间戳」）⇒ **本来就不需要记忆**。

⇒ **这一项对两个方案完全等价，不构成选型依据。** 换句话说：进程重启的代价**不在调度器上**，在 §5.1 那个「档位等值判定」上——而那是 `pickDueReminders` 的设计，与谁来触发无关。

---

## 6. 与我被告知的事实相矛盾之处

### 6.1 实质矛盾（两条）

**① 「register 抛错 ⇒ 全站 502」——机制错，形态更重。**

真实形态是 `process.exit(1)`：
- standalone：`dist/build/utils.js:1151-1154`（模板尾部 `startServer(...).catch(err => { console.error(err); process.exit(1) })`）
- `next start` / `start-server.js:439-444`（`catch { handlersError(); console.error(err); process.exit(1) }`）

**502 需要前面还有一层反向代理才会出现**，本仓是内网单机 Docker，链路上未必有。这条区别不是文字游戏：按「502」排障会去查代理与上游存活，按「exit 1」排障去看容器 stdout 的第一行。**告警的方向是对的（别在 register 里裸放可能抛错的东西），后果与修法都不准。**

**② 「`try/catch` 包裹能消掉它」——只能消一半，且消错了那一半。**

`try/catch { setInterval(tick, …) }` 只能兜住 `new Cron()` 的**同步参数校验**。真正致命的是 `tick` 这个 **async 回调体**抛错——它变成 `unhandledRejection`，而 `register()` 早已返回、ready 早已放行，**外层 `try/catch` 对它完全无效**。反过来，`try/catch` 会把「配置写错」降级成「一行日志 + 定时器压根没起来」——对轮询器来说这比响亮地启动失败更糟，因为**静默零事件与「没人该收」在库里长得一模一样**（`src/app/api/notifications/route.ts:13-15` 自己写了这句话）。

**修正**：告警应改写为「`register()` 里不得 `await` 任何 I/O；异步体的 `try/catch` 必须放在 `tick` 内部」。

### 6.2 非矛盾但需要修正的细节（一条）

**③ `worker/README.md` 描述的机制尚未实现。**

该 README 写「每个任务都用 `withSingleFlight()`（内含 `pg_try_advisory_lock`）」「每个进程接 SIGTERM 做 10→30s drain」。全仓 `src/` 检索 `advisory_lock|withSingleFlight` **零命中**，`worker/` 目录下只有那一个 README 文件（无 `.ts`/`.js`）。

**这不推翻「已核实事实」里的「`worker/` 只有 README，无实现」**——那句话说对了。矛盾的是 **README 自身**把计划写成了现在时。**如果有人拿这份 README 当现状来论证「已经有单飞了」，会得出错误结论。** 另外注意 `db/client.ts:99` 的注释已经把 `closeDb()` 定位成「worker 与测试收尾用；SIGTERM drain 也要走它」——**`closeDb()` 写好了，worker 那侧没人调。**

### 6.3 已核实、复核后**确认无误**的（逐条）

| 断言 | 核实 |
|---|---|
| `pumpNotifications()` + `scanArchiveIncomplete()` 唯一调用点在 `route.ts:54-55` | ✅ |
| `notifications.ts:83-88`「一期没有调度器，消费靠表 + 轮询」 | ✅ 原文在 `:83-89` |
| `worker/` 只有 README | ✅ 全目录仅 `worker/README.md` |
| `PG_POOL_MAX=10` | ✅ `.env.example:18`，`db/client.ts:45` 读它 |
| `consumeOutbox` 扫 `published_at IS NULL`、每行独立事务、上限 50 | ✅ `:782-792` / `:801` / `:98` |
| 去重靠 `dedupe_key` 唯一键 + `ON CONFLICT DO NOTHING` | ✅ `:333`、`:390-396` |
| 定时类用 `scheduledDedupeKey`，按「同目标同业务日」 | ✅ `:980-984`；`dedupe.ts:73-79` |
| Next 16.3.6 无内置 cron/schedule/interval | ✅ `node_modules/next/dist/docs/` 全目录检索无此类 API |
| 单副本 / 不引 Redis / 无内置调度器 —— 三条已作废结论 | ✅ 本报告不依赖也不推翻它们 |

---

## 7. 两个方案的成本对比

| 维度 | ① 独立 Node 进程（`croner@10.0.1`） | ② 应用内定时器（零部署件） |
|---|---|---|
| **新增部署件** | **1 个常驻进程**：Dockerfile 一层 + compose 一个 service + 一个 `restart: unless-stopped` + 健康检查 + SIGTERM drain（对齐 `db/client.ts:99` 已备好的 `closeDb()`）。内网单机也要多一个 compose service 与一个端口/进程。 | **0**。`instrumentation.ts` 一个文件（放 `src/` 根，见 `instrumentation.md:12`），加 1 个依赖。 |
| **新增依赖** | `croner` 1 个（零传递依赖，251 个版本、MIT） | 同样 1 个（或 0：`setInterval` 就够，见下方「失败形态」列） |
| **失败形态** | ① 进程起不来 → 该 service 不 Ready，**主站仍然正常**（轮询停摆，用户读请求兜底）。② 进程跑到一半崩 → outbox 积压，下次起来自愈（§5.2）。③ SIGTERM 没 drain → 同 ②，损失一次批。 | ① `register()` 抛错 → **整个 Next 进程 `exit 1`，全站不可用**（§6.1①）。② `tick` 抛错 → `unhandledRejection`；Node 22 默认**不因未处理拒绝退出**（`--unhandled-rejections=throw` 是默认，Node ≥15 起默认 `throw` ⇒ **实际会退出**）。③ 定时器静默不跑 → 零事件，与「没人该收」同形（§6.1②）。 |
| **可观测性** | 独立 stdout / 独立容器日志 / 可单独 `docker logs` / 可接外部 metrics。失败有独立的退出码与重启计数。 | 混在 Next 进程 stdout 里，没有独立生命周期信号。「定时器还活着吗」**没有内建答案**——`croner` 的状态面全是**进程内存字段**（`src/croner.ts:63-86`），进程一死即归零；且 `previousRun()` 在 `finally` 里赋值（`:547-554`）⇒ **抛异常照样前进**，它答不出「跑成了没有」。详见 `docs/research-croner-status-heartbeat.md` §8。 |
| **连接池压力** | **与主站是两个进程 ⇒ 两个独立的池**（各自 `max: 10`）。总连接数翻倍（20），但互不抢占。**这是本方案唯一的结构性优势。** | 与用户请求**共用同一个 10 条的池**。峰值 3 条（§4.1），单条连接被按住数秒；用户请求要排在后面等（§4.2）。 |
| **崩溃恢复** | 独立重启。`croner` **不补跑**（§2.1），所以「重启」=「下一轮从现在起算」，与 ② **等价**。 | 随主站重启。语义与 ① **完全相同**（§5.3）——因为两者都不补跑。**这一维度不构成选型依据。** |
| **开发机体验** | Windows 上要单独起一个进程（`tsx`/`node --watch`），跟 `next dev` 各跑各的。 | **零摩擦**：改完刷新页面就生效（改 `instrumentation.ts` 本身除外，要重启 dev server，§3.3 坑 1）。 |
| **同构性（Windows/Linux）** | 同一个 `node dist/worker.js`，零差异。✅ | 同一个 Next 进程，零差异。✅ **两者都满足「两边同构」，这一条不区分。** |
| **对 `route.ts:54-55` 的影响** | 可以**删掉**读驱动侧的 pump（定时器已是唯一消费者）——管线从「两条触发路径」收敛为一条。 | **删不掉**。读请求与定时器并发 pump 是常态（§4.2），重叠成本真实存在。 |

### 7.1 一句话读表

两个方案的**崩溃恢复完全等价**（都不补跑）、**同构性完全等价**。真正把它们区分开的只有四行：**新增部署件（1 个常驻进程 vs 0）**、**失败半径（只停轮询 vs 全站 exit 1）**、**连接池（独立池 vs 共用池）**、**读驱动侧能否收敛**。

---

## 8. 给 Q4 的最终推荐

### 8.1 推荐：**方案 ② 应用内定时器，但只在补上三个前置件之后**

选 ②，理由三条，按权重排序：

1. **失败半径可控**——只要守住 §8.2 的三条，`register()` 就永远不会抛错，① 那一栏最大的风险就不存在。而 ① 的「独立进程」买到的是**隔离**，而本项目单副本、单库、连接池 10、十个用户，隔离的收益本来就小。
2. **连接池这件事没有想象中严重**（§4.1）：峰值 3 条，余量 7 条给十个用户。真出问题也是「慢」不是「错」，且有一个明确的缓解杠杆（见 §8.2 第 4 条）。
3. **不新增部署件**是硬收益：内网单机私有化环境里，每多一个常驻进程就多一份「谁负责重启它、它挂了谁看」的运维债，而这个系统明确选了不引 Redis、不引外部编排。

### 8.2 上线前必须补的四件事

1. **`register()` 绝不 `await` 任何 I/O。** 同步 `setInterval`（或 `new Cron(..., { unref: true })`）然后立刻返回。理由：§3.1——框架缓存的是 `register()` 的返回值，一次启动期 I/O 失败会被永久缓存成 rejected promise，**直接 `process.exit(1)`**。
2. **`try/catch` 放进 `tick` 内部，不是外面。** 外层的 `try/catch` 对 async 回调体无效（§6.1②）。失败只记日志、**不打断 interval**。
3. **定时器用 `croner` 且配齐三个选项**：`timezone: 'Asia/Shanghai'`（不配则 Windows 与 Linux 触发时刻不同，§2.1）、`unref: true`（**塞进 Next 进程必须配**，否则 `setInterval` 的活跃句柄会……实际上 Next 本身要常驻所以影响有限，但配上更干净）、`protect: true` + `catch: log`（杜绝重入与未捕获拒绝）。
4. **给 pump 本身加一个进程内单飞标志。** `protect` 只挡定时器自己重入，**挡不住与用户请求的重叠**（§4.2）。最小实现：一个模块级 `let inFlight: Promise<void> | null`，重入直接跳过并计数——**不要用 advisory lock**，单副本下它是过度设计，且 `worker/README.md` 里那段至今没实现（§6.2③）。

### 8.3 什么条件下才应该换到方案 ①

以下任一条成立，就换成独立进程（`croner@10.0.1` + `worker/` 里那份 README 已经写好的形状）：

- **单副本裁定被推翻**（要跑 ≥2 副本）。届时应用内定时器会在每个副本里各起一份，`protect` 挡得住自己、挡不住别人；`dedupe_key` 能保证通知不重复，但 1300 次往返的查询量会翻倍。此时 ① 的「独立进程 + 单副本 worker 编排」是正解。
- **一次 pump 的实测耗时超过 1 秒且频繁发生**（说明 §4.1 的 1300 次往返不是理论值）。此时连接池的排队延迟已经开始被用户感知，① 的独立池是唯一干净的解。
- **轮询器的失败被要求「绝不牵连主站」**——比如将来它要写审计、发外部请求、或跑一个可能 OOM 的重活。那时它就不该住在 Next 进程的地址空间里。
- **需要「跑了没有」这个信号**。① 有独立容器日志与重启计数；② **要自己造，且不能靠 croner**——它的 `previousRun()` 记的是「跑完了」而非「跑成了」，且不挺过进程死亡（`docs/research-croner-status-heartbeat.md` §4.3b、§8）。**可观测性是 ② 最实在的短板**，不是连接池。

### 8.4 两个方案各自的失败形态（一句话版）

- **① 独立进程**：失败**局限在轮询器**。进程起不来 → 主站照常、只是退回读驱动；跑一半崩 → outbox 积压、下次起来自愈（§5.2）。代价是**一个没人记得它存在的常驻进程**，以及两份连接池配置。
- **② 应用内定时器**：失败**取决于写在哪**。`register()` 抛错 → **全站 `exit 1`、崩溃循环**（不是 502，§6.1①）；`tick` 抛错 → 未处理拒绝，Node ≥15 默认 `throw` ⇒ **同样把整个 Next 进程带走**；而这一切都可以靠 §8.2 的 4 条前置件消掉。**换句话说：② 的失败半径是 ① 的十倍，但它是完全可控的——代价是那 4 条必须真的做到。**

---

## 附录：一手来源清单

**Next 16.3.6（`node_modules/next/`）**

- `dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md:18`（"must complete before the server is ready"）、`:127`（`NEXT_RUNTIME`）、`:147-153`（版本史）
- `dist/docs/01-app/02-guides/instrumentation.md:19`、`:52-68`（import 放 register 内部）、`:72-84`（按 runtime 条件 import）
- `dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md:36`、`:44-48`（standalone 的 `server.js`）
- `dist/esm/server/lib/router-utils/instrumentation-globals.external.js:6,8-13`（模块缓存）、`:21-39`（`await register()`）、`:30-38`（错误包装与抛出）、`:50-56`（promise 缓存）
- `dist/esm/server/next-server.js:504-510`（`prepareImpl` → `ensureInstrumentationRegistered`）
- `dist/esm/server/route-modules/route-module.js:355-361`（请求路径上 await）
- `dist/esm/server/dev/next-dev-server.js:468-486`（dev 的加载与调用）
- `dist/esm/server/web/globals.js:98`（Edge globals 的旁路，本项目不触发）
- `dist/esm/server/lib/start-server.js:439-444`（setup 失败 → `exit 1`）、`:446`（listen）、`:470-472`（只盯 `CONFIG_FILES` 重启）
- `dist/build/utils.js:1111-1154`（standalone `server.js` 模板全文）、`:1103-1105`（instrumentation 被单独 trace）
- `dist/build/collect-build-traces.js:171-183`（standalone 的 server entries）

**npm 库**

- `https://registry.npmjs.org/{croner,node-cron,node-schedule}`（2026-10-13 取：`dist-tags.latest`、`time`、`versions[latest].dependencies`、`engines`）
- `croner@10.0.1` tarball：`dist/croner.js`（`unref` 默认值与校验、`function x` 的 `unref()`、`_checkTrigger` 的 `protect`、`_trigger` 的 `catch`、`_next` 的无补跑、`function g` 的 `Intl.DateTimeFormat` 时区）、README「Options」表与「Pattern」节的 DST 条款
- `node-cron@4.6.0` tarball：`dist/node-cron.d.ts:26-41`（`TaskOptions`）、`:56-77`（`ScheduledTask`）、`dist/node-cron.js`（`unref()` 的 `if (!this.forkProcess) return`）、`dist/_shared.js`（`planBeat`、`DEFAULT_MISSED_EXECUTION_TOLERANCE = 1000`、`heartBeatTimeout.unref()`、`buildDateParts`/`getTimezoneGMT`）、README「Timezones and DST」「Distributed Coordination」
- `node-schedule@2.1.1` tarball：README「Overview」段（「not interval-based scheduling」、推荐 toad-scheduler）、「Unsupported Cron Features」段、`package.json` dependencies

**本仓**

- `src/app/api/notifications/route.ts:13-15`（静默零事件与「没人该收」同形）、`:54-55`（唯一轮询点）
- `src/app/lib/server/services/notifications.ts:83-89`（一期无调度器）、`:98`（`OUTBOX_BATCH = 50`）、`:100`（`SCAN_BATCH = 500`）、`:115-146`（`loadHostFacts`）、`:158-187`（`resolveRecipients`）、`:194-223`（`recipientScopes`）、`:240-260`（`canSeeHost`）、`:309-403`（`insertNotificationEvent`，`:333` 与 `:390-396` 的 `ON CONFLICT`）、`:406-472`（`emitForHost`）、`:774-863`（`consumeOutbox`）、`:851-860`（失败只累加 `attempts`）、`:894-1023`（`scanDueNodes`）、`:934`（`Promise.all`）、`:966-1016`（节点提醒事务）、`:980-1002`（`scheduledDedupeKey` 与 `randomUUID` 的分工）、`:1043-1050`（`pumpNotifications`）
- `src/shared/notification/scan.ts:44`（`SCAN_WINDOW_MAX_DAYS = 365`）、`:69-83`（`pickDueReminders`，`:81` 的等值判定）
- `src/shared/notification/dedupe.ts:8-10`（唯一键 vs 应用层判重）、`:18-20`（scheduled 不含收件人）、`:73-79`（`scheduledDedupeKey`）
- `src/shared/notification/archive-reminder.ts:99-141`（`judgeArchiveReminder`，下界判定）
- `src/shared/time/zh-cn.ts:41`（`BUSINESS_TIMEZONE = "Asia/Shanghai"`）、`:67-76`（`businessDateKey`）、`:79-81`（`businessDaysBetween`）、`:83-92`（`businessDayStartIso`）
- `src/app/lib/server/db/client.ts:30-50`（`max`/`connect_timeout`/`idle_timeout`）、`:57-72`（启动断言）、`:74-97`（懒建池与 `asserted` 复位）、`:99-105`（`closeDb`）
- `src/app/lib/server/db/schema/outbox.ts:9-11`（至少一次）、`:25-45`（表定义与 partial index）
- `next.config.ts:19`（`output: "standalone"`）、`package.json:8`（`node >=22.0.0 <23`）、`:58`（`next ^16.3.6`）、`:59`（`postgres ^3.4.9`）、`.env.example:18`（`PG_POOL_MAX=10`）
- `worker/README.md`（计划形态，含尚未实现的 `withSingleFlight` / `pg_try_advisory_lock`，§6.2③）
# 调度器与单副本部署事实核验（Q-A / Q-B / Q-C）

> 性质：**只核事实，不做决定**。一手来源限定为 `node_modules/next/dist/docs/`（Next 16.3.6 官方文档）与本仓 `docs/`、`CHANGELOG.md`、`AGENTS.md`、`.trellis/spec/`、代码原文。不引用二手博客。
> 术语以仓库根 `GLOSSARY.md` 为准；本文件只涉及工程词汇（调度器 / 单飞 / outbox），不新增业务词汇。
> 已知裁定不再论证：**一期单副本部署**（收益为零：可接受任意停机窗口、无外部"升级不中断"硬约束）。

---

## 1. 结论摘要

1. **Q-A**：一期**不引入 Redis**。它在四类候选职责（分布式锁 / 调度器 / 队列 / 缓存）下**没有一条在"单副本 + 已有 Postgres outbox 表 + `pg_advisory_lock`"前提下成立**；`pnpm-lock.yaml` 中 `redis` / `ioredis` / `bullmq` / `node-cron` **零命中**，唯一的 `@upstash/redis` 是 `drizzle-orm` 的**可选 peer**（未安装）。引入 Redis 解决的具体问题是**零个**，不用它的后果也是**零个**。
2. **Q-B**：Next 16.3.6 **没有任何 cron / schedule / interval 能力**。`instrumentation.ts` 的 `register()` 官方定位是"server instance 启动时执行一次、必须在 server ready 前完成"的启动钩子，`after()` 是**请求后回调**且有路由时长上限；`output: 'standalone'` 只改部署单元形态（产出 `server.js`），不给调度能力。
3. **Q-C**：宿主 crontab 与自建 `worker/` 两条路**都成立**，代价差在"多一个部署件 vs 多一条 crontab 行"。单副本下 advisory lock **不再是功能正确性前提**（没有第二个进程会重复触发），但保留它成本近零、且是二期多副本/滚动发布双实例并存时的唯一护栏——这一点上现有文档措辞需要随裁定更新。

---

## 2. Q-A：一期要不要引入 Redis

### 结论

不引入。四个候选职责逐条被现有机制覆盖，且其中两个（缓存、队列）引入 Redis 会**反向削弱**本仓已有的保证。

### 2.1 逐职责判断

#### (1) 分布式锁 —— 已由 PG advisory lock 覆盖，不成立

| 事实 | 出处 |
|---|---|
| migrator 用 `pg_advisory_lock(hashtext('matternest:migrator'))` 单飞 | `tools/migrate.mjs:24`（`LOCK_KEY`）、`:67-69`（取锁，实测 key `-558534946`，见 `CHANGELOG.md:766`）、`:91`/`:96`（释放） |
| 四件任务（节点提醒扫描 / 规则 4 的 30 天无更新扫描 / outbox 投递 / 云之家在职同步）全部包 `withSingleFlight()`，内部 `SELECT pg_try_advisory_lock(hashtext('matternest:reminder-scan'))`，拿不到锁直接返回 | `.trellis/spec/backend/database-guidelines.md:147-151` |
| 决策原文："比引入 Redis + Redlock 少一个组件、少一类故障面，且天然和事务同生命周期" | `docs/tech-stack-decision.md:222-232`（§3.5） |
| "规模用不着引入 Redis/Redlock" | `docs/tech-stack-decision.md:19`（§1 表格第 4 行） |

一条容易被漏掉但很关键的同址事实：`§12.5` 定了**不引 pgbouncer、连接池 10**，注释明写这"顺带消除了 transaction-mode pooling 与 advisory lock / `SET LOCAL` 的冲突"（`docs/tech-stack-decision.md:479`、`.trellis/spec/backend/database-guidelines.md:153`）。也就是说 PG advisory lock 的可用性在本仓是被显式保障过的；Redis 不需要这个前提，但它换来的是一个新的、要单独配连接池与超时的外部组件。

#### (2) 调度器（定时触发） —— 单副本下增量是零，不成立

单副本意味着不存在"多个进程同时到点"。真正要防的是"上一次没跑完下一次又开始"，而这用一个进程内的 in-flight 标志或一条 advisory lock 就能办，不需要一个独立的调度中间件。BullMQ repeatable jobs 一类的增量在这里是零。

反向代价：引入 Redis 做调度器会新增一类本不存在的故障面——**Redis 不可用时任务不跑**。而 Postgres 不可用时整个系统本来就不跑，Redis 是纯增量故障源。

#### (3) 队列（替代 outbox 表） —— 不成立，且会削弱现有保证

现状是 **Postgres outbox 表 + 至少一次 + DB 唯一键去重**：

- 只扫 `published_at IS NULL`，成功才打时间戳（`src/app/lib/server/services/notifications.ts:764-792`）
- 去重落在 `notification_event.dedupe_key` 唯一键上，`ON CONFLICT (dedupe_key) DO NOTHING`（`notifications.ts:333`；投递行另有 `(event_id, user_id, channel)` 唯一键 `:390-396`）
- 每条 outbox 行**各用一个事务**，"一条坏行不该把整批回滚"，部分成功在至少一次语义下安全（`:771-772`、`:851-860`）
- 文件头第 2 条原话："去重靠 `dedupe_key` 唯一键，不靠应用层判重……重放同一行是正常路径——`ON CONFLICT (dedupe_key) DO NOTHING` 是它成立的唯一前提"（`:75-76`）

换成 Redis 队列会丢三样东西：① **去重与业务事务同生共死**（outbox 行在业务事务里落，Redis 队列要在事务提交后再发，多一个"提交了但没发出去"的窗口）；② **唯一键语义**（Redis 没有，去重要靠 Lua 自己写，而"重放是正常路径"要求去重与事务原子）；③ **坏行隔离**（现有是每行一事务）。`docs/tech-stack-decision.md:239` 也已定性："单体内 outbox + 进程内投递器足够"。

#### (4) 缓存 —— 不成立，且方向相反

`§12.5` 的判据**不是性能而是安全**，原文：

> 本系统每次读取都带行级数据范围谓词，**任何跨用户共享的响应缓存都是泄露面**。因此 HTTP 层缓存、反代缓存、查询结果缓存一律不做。
> —— `docs/tech-stack-decision.md:477`

三处需要缓存的全用现成机制：配置字典与用户权限集走进程内 `Map`（键 `userId:token_version`，版本变更天然失效），列表详情走 react-query 的 `staleTime`（同文件 `:477`）。Redis 作为**跨进程共享缓存**恰好是 §12.5 明确拒绝的那个东西。

Next 官方文档里 Redis 唯一被点名的地方是 cacheHandler：`self-hosting.md:113`（"the Redis `cacheHandler` example"）、`:164`（"save the cached values anywhere, like Redis"）、`:211`（`'use cache: remote'` + 自定义 cache handler）。但本仓 `docs/tech-stack-decision.md:513`（§13.3-3）明令**不许改用 `'use cache'`**，§13.5 部署级 (a) 也要求"不使用 `'use cache'`/跨实例共享缓存"（`:534`）。⇒ **Redis 的这条官方用途在本仓是被禁令关掉的**，不是"还没做"。

### 2.2 依赖核实

- `pnpm-lock.yaml` 中 `redis` / `ioredis` / `bullmq` / `node-cron` / `bee-queue` / `agenda` / `amqp` / `rabbit` 作为**包名零命中**。
- `@upstash/redis` 仅出现 **2 次**，均在 `drizzle-orm@0.45.3` 的 peer 段：`pnpm-lock.yaml:2113`（`'@upstash/redis': '>=1.34.7'`）与 `:2159`；`:2128-2160` 的 `peerDependenciesMeta` 把它标为 `optional: true`。**它不是安装依赖**，lockfile 的 `importers` 段（`:7` 起）与 `packages` 段都没有它。
- `package.json` 的 `dependencies` / `devDependencies` 亦无任何 redis / cron / 队列包。

（旁证：`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverExternalPackages.md:70` 把 **`node-cron` 列进 Next 的"自动不做 Server Components bundling"清单**，`:75` 同时列了 `pg`。官方预期你在自己的进程里用 node-cron + pg，并明确告诉你它不会被 bundling 处理。）

### 2.3 对"引入 Redis 解决什么、不用会怎样"的直接回答

**引入 Redis 解决的具体问题：没有。** 四个候选职责逐一被 `pg_advisory_lock`（锁）、`event_outbox` 表 + `dedupe_key` 唯一键（队列）、进程内 `Map` + react-query `staleTime`（缓存）、单副本本身（无需跨进程调度协调）覆盖。

**不用 Redis 时那个问题的后果：没有后果。** 而**引入** Redis 的后果是确定的：多一个要备份、要监控、要在 SIGTERM 时 drain 的组件，多一类故障面（连接池耗尽、缓存污染、调度中间件单点），以及一份与 `§12.5`「不引任何跨用户缓存」直接冲突的设计债。

---

## 3. Q-B：Next.js 16.3.6 有没有内置的定时/周期任务能力

### 结论

**没有。** 三个被点名的机制逐一核过：`register()` 是启动钩子不是常驻承诺，`after()` 是请求后回调不是调度器，全文档 cron / schedule / interval 与"周期任务"相关的命中为零。`output: 'standalone'` 只改产物形态。

### 3.1 `instrumentation.ts` 的 `register()`

官方原文（两处一字不差）：

> The file exports a `register` function that is called **once** when a new Next.js server instance is initiated, and must complete before the server is ready to handle requests. `register` can be an async function.
> —— `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md:18`（同 `01-app/02-guides/instrumentation.md:19`）

配套的几条限制，都指向"这是 observability 启动钩子"而非"常驻进程入口"：

| 约束 | 出处 |
|---|---|
| 文件必须在项目根（或 `src/` 内），**不能**放 `app/` / `pages/` 里；用了 `pageExtensions` 要同步改文件名 | `02-guides/instrumentation.md:41-44` |
| `register` 在 **Node 与 Edge runtime 都会被调用**，要用 `NEXT_RUNTIME` 分流 | `02-guides/instrumentation.md:72`、`03-api-reference/.../instrumentation.md:127` |
| 官方建议在 `register` **函数体内** `await import(...)` 而非顶层 import，理由是"把 side effect 收在一处、避免顶层 import 的意外后果" | `02-guides/instrumentation.md:66-68` |
| 自托管页对 `register` 的唯一提及：**"You can run code on server startup using the `register` function"** | `02-guides/self-hosting.md:83` |

**关键缺口：文档没有给 `register()` 任何生命周期承诺。** 没有说它在 `next build` 期间是否被调、没有说 `next dev` 下 HMR 重载时的行为、**没有退出回调**（没有 `registerShutdown` / `onShutdown` 之类的对称物）。而同一条 `:18` 说 `register` "must complete before the server is ready to handle requests" ⇒ **`register` 里抛未捕获异常会让整个 server 起不来**。

因此：在 `register()` 里起 `setInterval` 跑 `pumpNotifications()`，在 Node runtime 下大概率能跑，但这是**无文档承诺的副作用**，且把"轮询代码的一个 bug"升级成"全站 502"。方向错了。

### 3.2 `after()` / `unstable_after`

> `after` allows you to schedule work to be executed **after a response (or prerender) is finished**. This is useful for tasks and other side effects that should not block the response, such as logging and analytics.
> —— `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md:6`

它是**请求后回调**，不是调度器，三条硬证据：

- **有执行时长上限**："`after` will run for the platform's default or configured max duration of your route"，可用 `maxDuration` 配（`after.md:50`）。常驻轮询不可能有时长上限。
- **可能在构建期跑**："If it's used within a static page, the callback will execute at build time, or whenever a page is revalidated."（`after.md:40`）
- **可用位置受限**：Server Components（含 `generateMetadata`）、Server Functions、Route Handlers、Proxy（`after.md:8`）；Server Components 内**不能**调 `cookies()`/`headers()`（`:120`、`:166`）。
- **Platform Support**：Node.js server = Yes，Docker = Yes，**Static export = No**，Adapters = 平台相关（`after.md:238-243`）。

Version History（`after.md:300-303`）：`unstable_after` 于 `v15.0.0-rc` 引入，`v15.1.0` 转正为 `after`。本仓 Next 16.3.6 已无 `unstable_` 前缀。

`after()` 对本议题真正有用的是另一条：**官方对优雅停机的要求**——"When stopping the server, ensure a graceful shutdown by sending `SIGINT` or `SIGTERM` signals and waiting. The Next.js server will finish in-flight requests and execute any pending `after()` callbacks before exiting. Platforms should allow a configurable drain period (**10-30 seconds is recommended**)"（`02-guides/self-hosting.md:299`）。这条与本仓 `docs/tech-stack-decision.md:514`（§13.3-4）和 `worker/README.md:6` 是同一件事。

### 3.3 cron / schedule / interval 检索结果

对 `node_modules/next/dist/docs/` 全目录 grep `cron|scheduler|scheduled task|setInterval`，共 **7 处命中，无一与"Next 提供周期任务能力"相关**：

| 命中 | 含义 |
|---|---|
| `03-api-reference/07-edge.md:80`、`:117` | Edge runtime 沙箱里 `clearInterval` / `setInterval` **Web API 可用性表**（说的是运行时有哪些 API，不是 Next 提供调度） |
| `02-guides/prefetching.md:75` | "The scheduler prioritizes likely navigations" —— 指**预取调度器** |
| `03-api-reference/07-adapters/04-testing-adapters.md:21` | 一个注释示例里的 `# - cron: '0 2 * * *'` |
| `02-guides/preserving-ui-state.md:487` | 教程里的 `setInterval(() => setCount(...), 1000)` 例子 |
| `01-app/03-api-reference/05-config/01-next-config-js/serverExternalPackages.md:70`、`02-pages/.../serverExternalPackages.md:70` | **`node-cron` 出现在"自动不做 bundling"清单里** —— 反向证据：官方预期你在自己进程里用它 |

本仓 research 文档独立记了同一条结论，与我的检索一致：

> `/docs/app/guides/cron-jobs` 返回 **Page Not Found**（Next 文档不给该页）；自托管页只提到 `register`（instrumentation，启动时执行一次）与 `after()`（响应后异步）。结论：**Next 自身不提供周期任务**。
> —— `docs/research-nextjs-stack.md:45`（§2.3，标 PARTIAL）

### 3.4 `output: 'standalone'` 对自建进程的影响

`05-config/01-next-config-js/output.md:24-48`：`output: 'standalone'` 产出 `.next/standalone`，"can then be deployed on its own without installing `node_modules`"，并附带一个最小 `server.js` "which can be used instead of `next start`"。两条实操约束：

- `public` 与 `.next/static` **默认不拷贝**，要手动 `cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/`（`:36`、`:40-42`）
- 端口/主机名用 `PORT` / `HOSTNAME` env 注入（`:54`）
- 本仓已启用：`next.config.ts` 有 `output: "standalone"`

**它只改部署单元形态，不给任何调度能力。** 对自建 worker 的实际影响是二选一：

1. **独立进程**：worker 有自己的 entrypoint / Dockerfile / compose service（`worker/README.md:7` 的 `docker compose run worker --task <name>` 就是这条）。
2. **同进程**：在 `server.js` 或 `register()` 里 `require` worker —— 但这就退回 §3.1 的"无生命周期承诺"问题，且 `output.md:69-78` 提醒 monorepo 追踪根与 `outputFileTracingRoot` 的坑（本仓是单 app，不触发）。

---

## 4. Q-C：宿主 cron vs 自建 worker 的真实代价

### 4.1 现状原文核实

**`pumpNotifications()` 的存在与读驱动形态**（与被告知事实一致）：

- 文件头：「## 一期没有调度器，消费靠"表 + 轮询"」/「单副本部署、不引 Redis（技术栈裁定）。所以 `pumpNotifications()` 由通知中心的读请求触发：先抽干待投递的 outbox，再跑一遍节点到期扫描。两件事都**幂等**——前者靠 `dedupe_key`，后者靠"同目标同业务日"的 scheduled key，所以"每次读都跑一遍"不会产生第二条通知，只是白跑几次索引扫描（两张节点表各一次）。」
  —— `src/app/lib/server/services/notifications.ts:83-88`
- 函数注释：「一期没有调度器（单副本、不引 Redis），所以由通知中心的读请求触发。幂等由 `dedupe_key` 保证，所以重复触发只是白跑几次索引扫描。系统动作没有 `actor`：规则以 `operator = SYSTEM` 执行（权限草案 §8），而本函数不写审计、不读用户范围，所以拿不到 actor 也不影响正确性。」
  —— `notifications.ts:1035-1042`
- **两个触发点**：`src/app/api/notifications/route.ts:54`（`await pumpNotifications();` 后接 `:55` `await scanArchiveIncomplete();`）与 `src/app/api/notifications/unread-count/route.ts:16`。
- 两个端点都包在 `withActor` 里，**拿不到 actor 直接 401**（`src/app/lib/server/http.ts:185-190`）。⇒ 任何外部触发都必须先通过登录态，这是"宿主 cron curl"方案的硬约束。

**路由注释里已经把 cron 端点这条退路点名并否掉了**（原文，`:22-23`）：

> 把轮询放在一个独立的 cron 端点上会更"干净"，但一期没有 cron——**一个没人调用的端点等于没有消费者**，而通知中心是**唯一**会因此变空的地方。

同一处 `:45-46` 还有一条对新增扫描器的硬要求：「⚠ **新增一个扫描器时，必须加在这个函数里**，否则它会变成"写好了但没人调用"，而那种形态与"没人该收"在库里长得一模一样（零事件）。」

**`CHANGELOG.md:533` 原文核实**（与被告知一致）：

> 定时任务从"框架内置 cron"改为**自建 worker 进程**（`node-cron` + `pg_try_advisory_lock` 单飞 + SIGTERM drain）；多副本结论：C1 的锁由"必须"继续是"必须"，理由从 per-process croner 变成"自己起的进程同样多副本"。

⚠ **一处需要澄清的措辞**：这条里的"框架内置 cron"指的是 **Nuxt/Nitro 的 scheduled tasks**，不是 Next。证据链：`docs/tech-stack-decision.md:39`（§2 表格"定时任务"行 `~~Nitro scheduled tasks~~ ⚑ → 独立 worker 容器 + node-cron + PG pg_try_advisory_lock 单飞（Next 无内置调度器）`）、`:447`（C1 "Nitro 调度器是 **per-process croner**，N 副本 = 触发 N 次（源码级确认）"）。**Next 从来没有内置 cron**（§3.3 已核）。所以"改回宿主 cron"不构成推翻 v5 裁定，只是换了"谁来触发"这一个变量。

**`worker/` 现状**：只有 `worker/README.md`（10 行，零实现）。README 内容：第 3 行「独立进程（技术选型 §5）：`node-cron` 跑四件——节点提醒扫描、规则 4 的 30 天无更新扫描、outbox 投递、云之家在职同步」；第 5 行 advisory lock 是"多副本下的功能正确性前提"；第 6 行 SIGTERM 10–30s drain；第 7 行 `docker compose run worker --task <name>`；第 10 行「内容在 W0-5（进程与 compose）与 W5-1（三件任务）进来。」`docs/implementation-plan-v1.md:175` 把 **W5-1 标为「审」票**（需人审设计条目再放行）。

**部署件现状**：全仓（排除 `node_modules`）**没有 Dockerfile、没有 docker-compose、没有 nginx 配置**。`deploy/` 只有一个 `README.md`（10 行），第 3 行规划「`docker-compose.yml`、`nginx.conf`、MinIO 桶策略、备份脚本、migrator 一次性服务（技术选型 §6、落地方案 W0-5）」，并注明"仍待做"（`implementation-plan-v1.md:81` 明确列了"nginx conf 与 worker 容器、compose 里的 migrator 服务定义"为未完成项）。

### 4.2 两条路对比

#### 路线 1：宿主 crontab 定时 curl 一个内部端点

| 维度 | 实况 |
|---|---|
| **实现量** | 一个内部 route handler（复用 `pumpNotifications()` + `scanArchiveIncomplete()`，与 `notifications/route.ts:54-55` 逐字相同）+ 一条 crontab 行 + 一个 token env。约半天。<br>⚠ 硬约束：现有两个端点都走 `withActor`（`http.ts:185-190`），cron 没有 session。必须**新开** `POST /api/internal/pump`，用 bearer token 校验（如 `MN_INTERNAL_TOKEN`），不读 DB session、不写 actor。<br>⚠ **不要**把长生命周期 session cookie 写进 crontab——那是一把永不过期的登录态落在明文配置文件里。 |
| **失败形态** | ① **crontab 没配 / 容器重建后丢失 ⇒ 静默不跑**。形态与"没有待投递事件"在库里一模一样（零 outbox 未投递行 + 零扫描命中），**不可观测**。这是它最贵的代价，也正是 `notifications/route.ts:22-23` 点名的那个坑。<br>② app 挂 ⇒ curl 失败 ⇒ 本轮不跑；恢复后 `published_at IS NULL` 自然重扫，**积压自愈**（这条是好的）。<br>③ curl 超时/被杀 ⇒ 半批。`consumeOutbox` 每条行各一个事务（`:771-772`），部分成功在至少一次语义下安全。<br>④ 端点暴露面：多一个"能无条件触发全量扫描"的 HTTP 口子，必须只监听 docker 内网 + 带 token + nginx 不暴露 `/api/internal/*`。 |
| **对部署件要求** | 宿主要有 crontab，或 app 容器内跑 cron 进程。`deploy/README.md` 已在规划 compose + nginx，加一条 cron service 或在宿主配。**当前没有任何 Dockerfile/compose 存在**，所以这条路的"部署件"成本暂时无法量化到具体文件。 |
| **advisory lock 是否必要** | **不必要**（一个 cron、一个 app 进程，不会并发触发）。但注意 `consumeOutbox` 本身**无锁**（`agent-work/smoke-notifications.mjs:376` 原话"消费是'至少一次'、无锁（去重靠 `dedupe_key` 唯一键）"）—— 若手工补跑与 cron 撞上，会有两个并发消费；去重靠 `dedupe_key` 唯一键兜住（`:333`、`:390-396`），**不会双发**，只是 `merge_count` 变大（该脚本 `:374-390` 专门论证了这一点，并把断言上界写成 `2 × attempts − 1` 而非写死 `=== 1`）。 |

#### 路线 2：自建 `worker/` 进程（node-cron + advisory lock + SIGTERM drain）

| 维度 | 实况 |
|---|---|
| **实现量** | README 已规定三件（node-cron / `withSingleFlight()` / SIGTERM drain），再加进程入口、compose service、日志。**约 1–2 天**，且含一个未核 spike：`docs/research-nextjs-stack.md:47` 明写"**调度器选型本身未经一手核验**，spike 要实测 `node-cron` 与 graceful shutdown（自托管页要求 SIGTERM 后留 10–30s drain）"。`implementation-plan-v1.md:175` 把 W5-1 列为「审」票。 |
| **失败形态** | ① worker 进程崩 ⇒ 与路线 1 的 crontab 丢失同构（静默不跑，库里看不出）。**但它比 crontab 多一个可观测点**：compose `restart` 策略 + 容器健康检查能把"进程不在"变成显性故障。<br>② SIGTERM 时正在投递 ⇒ 必须留 10–30s drain，否则 outbox 投递被掐断（`worker/README.md:6`、`docs/tech-stack-decision.md:514`、Next 官方 `self-hosting.md:299` 同一条要求）。<br>③ 多一个要在意"启动顺序 + DB 就绪"的进程：`CHANGELOG.md:153-155` 记过一次真实故障——"服务端在 DB 隧道不可用时启动、连接池没自愈（`ECONNREFUSED 30432`）"，结论带进部署件（"健康检查不能只打静态壳、`depends_on` + 就绪探测、**worker 同病**"）。 |
| **对部署件要求** | 一个新容器/进程 + Dockerfile + compose service + restart 策略 + drain 配置 + 健康检查。与 `deploy/README.md:3` 已规划的 migrator 一次性服务同类。 |
| **advisory lock 是否必要** | 单副本下**不是功能正确性前提**（只有一个 worker 进程，没有第二个进程会重复触发）。但保留它成本一条 SQL，且是二期上多副本、以及**滚动发布期双实例并存**时（`docs/tech-stack-decision.md:226`："app 是单实例部署，但**滚动发布期会双实例并存**，届时提醒会发两遍"）的唯一护栏。**建议保留**，但文档理由需改写（见 §5）。 |

#### 路线 3：维持读驱动（现状，零改动）

| 维度 | 实况 |
|---|---|
| **实现量** | 0。 |
| **失败形态** | ① **没人打开通知中心就不消费。** 这不是理论风险，`notifications/route.ts:22-23` 自己承认了。十人企业 + 内网系统，周末/假期无人登录时 outbox 会积压，直到有人点开通知中心才一次性爆发。<br>② 节点到期扫描的语义是"今天该发今天发"（`scanDueNodes` + `businessDateKey`，`notifications.ts:894-905`；去重键 `scheduledDedupeKey` 含 `dateKey`，`:980-984`）。延迟到下周一看意味着"3 天前到期的节点"与"今天到期的节点"同时弹出来。<br>③ 积压越多越容易撞 `SCAN_BATCH = 500`（`:100`，`:931` `limit(SCAN_BATCH)`）与 `OUTBOX_BATCH = 50`（`:98`）的上限——撞上限会漏掉窗口外的节点。<br>④ 读请求现在要额外承担 `consumeOutbox`（≤50 行 × 每行一事务）+ `scanDueNodes`（两张节点表各一次扫描）：十人规模下延迟无所谓，但它把"用户等一个列表"和"系统跑批"绑在同一个请求上。 |

### 4.3 一张表

| | 宿主 cron | 自建 worker | 读驱动（现状） |
|---|---|---|---|
| 新增实现量 | ~0.5 天 | ~1–2 天（含未核 spike） | 0 |
| 新增部署件 | 0（一条 crontab 行） | 1 个容器 + Dockerfile + compose service + 健康检查 | 0 |
| 调度源消失时的形态 | **静默**，需靠心跳发现 | **显性**（restart + 健康检查） | 不可能（没有调度源） |
| app 挂了 | curl 失败，恢复后 outbox 自然补跑 | 同样 | 用户根本进不来 |
| 跑批中途被杀 | 每行独立事务，部分成功安全 | 需 10–30s drain 才安全 | 同样 |
| 并发重复触发 | 去重靠 `dedupe_key`，不双发 | lock 挡掉 | 两个用户同时打开通知中心就会并发，已靠 `dedupe_key` 兜住 |
| 新增 HTTP 暴露面 | 有（带 token 的内部端点） | 无 | 无 |
| advisory lock 必要性 | 不必要（保留作保险） | 单副本下不必要（保留作保险） | 无锁，靠唯一键 |
| 无人登录时的行为 | 照常跑 | 照常跑 | **不跑** |

---

## 5. 与我被告知的事实相矛盾之处

**未发现矛盾。** 逐条核过：

| 被告知事实 | 核实结果 |
|---|---|
| 全仓 `src/` 对 `use server` / `useActionState` / `useFormStatus` / `<form action=` 零命中 | ✅ 成立。三者均零命中；`<form` 原生元素零命中（仓内所有 `Form` 都是 antd 的 `<Form>`，如 `src/app/(auth)/login/login-form.tsx:78`）。**补一个复核细节**：宽 grep `action=` 会数出 **14 处假阳性**，全部是自定义组件 `StateBlock` 的 `action={<Button .../>}` prop（例：`src/app/(desk)/notifications/notifications-view.tsx:133`、`src/app/(desk)/archive/archive-view.tsx:197`、`src/app/(desk)/matters/matters-view.tsx:269`、`src/app/(desk)/parties/parties-view.tsx:193` 等）。结论不变。 |
| `worker/` 只有 README.md，一行实现都没有 | ✅ 成立（`worker/README.md`，10 行） |
| 没有 Dockerfile / docker-compose / nginx 配置 | ✅ 成立（全仓排除 `node_modules` 零命中；`deploy/` 仅一个 `README.md`） |
| `tools/migrate.mjs` 已用 `pg_advisory_lock(hashtext('matternest:migrator'))` 做 migrator 单飞 | ✅ 成立（`tools/migrate.mjs:24`、`:67-69`、`:91`、`:96`；`CHANGELOG.md:766` 记实测 key `-558534946`）。**补一个细节**：migrator 用的是**阻塞式** `pg_advisory_lock`（`migrate.mjs:66` 注释"阻塞式锁：拿不到就一直等，等到的那个才改表"），而调度任务的规格是**非阻塞** `pg_try_advisory_lock`（`database-guidelines.md:149`，"拿不到锁直接返回"）。两者语义不同但都正确（migrator 应该等，扫描应该让位），不要互相"统一"。 |
| Next 16.3.6 / Ant Design 6 / Drizzle / Postgres / `output: 'standalone'` / 内网私有化 / 十人企业 / 运维=开发者本人 | ✅ 与 `package.json`（`next ^16.3.6`、`antd ^6.6.5`、`drizzle-orm 0.45.3`、`postgres ^3.4.9`）、`next.config.ts`（`output: "standalone"`）、`docs/tech-stack-decision.md:16`（"用户数十到一两级"）、`:477`（§12.5 标题"20 人规模"）一致 |

### 5.1 一处需要随"一期单副本"裁定更新的措辞（不是矛盾，但是过强的表述）

两处文档把 advisory lock 写成**无条件的正确性前提**：

> - 每条任务必须包 `withSingleFlight()`（内部 `pg_try_advisory_lock`）。**这不是保险，是多副本下的功能正确性前提**：outbox 双派＝双发通知（C1，经 §13.2 继承）。
>   —— `worker/README.md:5`

> 拿不到锁直接返回。**这不是"保险起见"，是多副本下的功能正确性前提**（outbox 双派＝双发通知，技术选型 C1 经 §13.2 继承）。
>   —— `.trellis/spec/backend/database-guidelines.md:151`

在**一期单副本**裁定下，这句话描述的是"滚动发布期双实例并存 / 二期多副本"时的性质（`docs/tech-stack-decision.md:226` 明写滚动发布期会双实例并存），对**当前部署形态**是过强的。源流也很清楚：它源自 Nuxt 的 C1（`:447` "Nitro 调度器是 per-process croner，N 副本 = 触发 N 次（源码级确认）"），经 `:499` 继承到 Next 路线（"Next 连内置调度都没有，独立 worker 同样多进程"）。

**建议（属文档修订，不属本次事实核验范围）**：改成"单副本下是廉价保险；多副本与滚动发布双实例并存时才是功能正确性前提"。这不改变"必须包 `withSingleFlight()`"的动作要求（保留锁仍然是对的），只改理由的适用范围。

---

## 6. 对 Q4 的推荐方案

### 推荐：宿主 cron + 带 token 的内部端点，并把"发现失败"做进部署件

**理由**：一期单副本 + 可接受任意停机窗口 + 运维=开发者本人。收益最大的动作是"让节点到期提醒在正确的时间发出、让 outbox 不积压"，而不是"多一个常驻进程"。自建 worker 的全部增量收益（进程崩溃可观测、compose restart 自动拉起、drain）在单副本下可以用"cron 打点 + 一条健康查询"拿到七八成，成本差约 1–1.5 天 + 一个新容器。

**具体形态**：

1. **`POST /api/internal/pump`**：bearer token 校验（env `MN_INTERNAL_TOKEN`），**不复用 `withActor`**、不读 DB session、不写 actor（`pumpNotifications` 本身不需要 actor，理由见 `notifications.ts:1040-1041`）。函数体两行，与 `notifications/route.ts:54-55` 逐字相同：
   ```ts
   await pumpNotifications();
   await scanArchiveIncomplete();
   ```
   返回体带 `{ outbox: { scanned, published, failed, events, merged }, scan: { scanned, events, merged } }`（这两个形状已是现成的返回类型，`:774-780`、`:894-898`）。
2. **网络面**：只监听 docker 内网；nginx 不暴露 `/api/internal/*`（`deploy/README.md:9` 的请求体上限同址配置）。
3. **crontab 一条**。频率需产品拍（文件没有规定"节点到期提醒"的时效要求）：保守取每 5 分钟，或取每天一次（若只要求"当天发出"）。
4. **可观测（这条不可省）**：把上面那个返回体落日志，或回写一个心跳行。**否则失败形态与"没有待投递事件"在库里不可区分**——这正是 `notifications/route.ts:22-23` 已经点名的坑，也是本方案相对自建 worker 唯一的实质劣势。
5. **手工补跑**：`curl -X POST -H "Authorization: Bearer $MN_INTERNAL_TOKEN" http://app:3000/api/internal/pump`。等价于 `worker/README.md:7` 的 `docker compose run worker --task <name>`，但不需要 worker 镜像。
6. **并发**：单 cron 不会自叠。若手工补跑与 cron 撞上，去重靠 `dedupe_key` 唯一键（`notifications.ts:333`、`:390-396`），不会双发，只是 `merge_count` 变大——这一条已被 `agent-work/smoke-notifications.mjs:374-390` 实测并写进断言上界。**一期不加 advisory lock**；若二期上多副本，在 `pumpNotifications()` 入口补一条 `pg_try_advisory_lock(hashtext('matternest:notification-pump'))`，与 `database-guidelines.md:147-151` 已规定的四件任务同一写法。

### 不推荐：`instrumentation.ts` 的 `register()` 里起 `setInterval`

文档只承诺 `register` "is called **once** when a new Next.js server instance is initiated, and **must complete before the server is ready to handle requests**"（`instrumentation.md:18`），没有任何退出/生命周期承诺；且 `register` 抛错会挡住整个 server ready。把常驻轮询挂在它上面，等于把"轮询代码的一个 bug"升级成"全站 502"，同时换来零部署件节省（cron 方案同样零新增容器）。

### 什么时候改选自建 worker

出现以下任一条，且**只有**那时：
- 副本数 > 1，或滚动发布要求双实例并存（`docs/tech-stack-decision.md:226`）—— 届时 advisory lock 从"保险"变"正确性前提"，且需要一个明确的 drain 策略；
- 任务数量/时长增长到"读请求延迟不可接受"或"需要按任务分别重试/退避"；
- 需要"进程崩溃自动重启"这种显性故障信号，而心跳方案被证明不够。

---

## 附：本文件引用的一手来源清单

**Next.js 16.3.6 官方文档**（`node_modules/next/dist/docs/`）：
- `01-app/02-guides/instrumentation.md`（:19、:41-44、:66-68、:72）
- `01-app/03-api-reference/03-file-conventions/instrumentation.md`（:18、:127）
- `01-app/03-api-reference/04-functions/after.md`（:6、:8、:40、:50、:120、:166、:238-243、:300-303）
- `01-app/02-guides/self-hosting.md`（:83、:113、:164、:211、:297-299）
- `01-app/03-api-reference/05-config/01-next-config-js/output.md`（:24-48、:54、:69-78）
- `01-app/03-api-reference/05-config/01-next-config-js/serverExternalPackages.md`（:70、:75）
- `01-app/01-getting-started/17-deploying.md`（:6-11、:29、:44、:52）
- `01-app/03-api-reference/07-edge.md`（:80、:117）

**本仓**：
- `docs/tech-stack-decision.md`（§1 `:16`/`:19`；§2 `:39`；§3.5 `:222-232`；§3.6 `:239-240`；§5 `:282-283`；§6 `:302-308`；§12.2 C1 `:447`；§12.5 `:475-481`；§13.2 `:499-502`；§13.3-3 `:513`；§13.3-4 `:514`；§13.5 部署级 (a)(b) `:534`）
- `docs/research-nextjs-stack.md`（§2.3 `:43-47`、`:116-117`、`:135`）
- `docs/implementation-plan-v1.md`（:28、:80-81、:175）
- `CHANGELOG.md`（:153-155、:532-533、:766）
- `.trellis/spec/backend/database-guidelines.md`（:147-153）
- `worker/README.md`（:3、:5-7、:10）
- `deploy/README.md`（:3-10）
- `src/app/lib/server/services/notifications.ts`（:75-76、:83-88、:98、:100、:333、:390-396、:764-792、:771-772、:851-860、:894-905、:931、:980-984、:1035-1042）
- `src/app/api/notifications/route.ts`（:16-23、:45-46、:54-55）
- `src/app/api/notifications/unread-count/route.ts`（:11-12、:16）
- `src/app/lib/server/http.ts`（:182-190）
- `tools/migrate.mjs`（:24、:66-69、:91、:96）
- `next.config.ts`、`package.json`、`pnpm-lock.yaml`（:2113、:2159、:2128-2160）
- `agent-work/smoke-notifications.mjs`（:374-390）

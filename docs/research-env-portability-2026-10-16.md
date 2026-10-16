# 研究 · 「只在开发机上成立」全仓扫描（MATT-88）

> throwaway 件：本分支只作发现快照，**永不合并、不开 PR**。结票答案写在 MATT-88 评论，这里保留可复现证据与逐类审计轨迹。
> 扫描方式：主代理直读（两次委派子代理均中断）。每条都指向 `文件:行号`，判定用「换环境/换 TZ 再跑一遍」，不是只 grep。

## 背景

CI 首跑抓到四处「本地全绿、别的环境必红」的缺陷，全部已修：
① `zh-cn.spec.ts` 依赖本机时区（cf59271）② `verify:all` 用 Unix env 前缀（cf59271，现为 `cross-env`）③ `migrate`/`db-check`/`wait-heartbeat` 把「有 `.env`」当硬前提（2992704）④ `MN_OWN_COMPANY_NAMES` 声明了却从未注入 CI（已补，见 ci.yml:68）。

票面四类判据逐类扫。结论：**① 有 1 处新真实漂移（见下 A，它同时是③的根因）；②④ 在四处已修之后扫干。**（曾疑心的 `worker` 缺 pepper 一条，核实 `worker/` 零 `process.env` 读取、三把密钥由 compose 注入 app 服务——不成立，已剔除，见文末「一度写错的一条」。）

---

## 类别①：读 `process.env` 却假设来自 `.env` / 声明了却没注入

### A（新发现·真实漂移）— `PG_SESSION_TIMEZONE` 声明了但全仓没人读，真正的时区前提落在「库外手工 ALTER ROLE」上

- `.env.example:22` 列了 `PG_SESSION_TIMEZONE=UTC`；`ci.yml:46`、`docker-compose.yml:55` 都注入了它。
- 但**没有任何代码读它**（全仓 grep 零消费点，只有声明与注入）。它是个**装饰性变量**。
- 真正的会话时区前提由**库侧角色级设置**兜：`db/client.ts:63 assertSessionConventions` 起池即断言 `current_setting('timezone')==='UTC'`，不 UTC 就抛；`db-check.mjs` 的 **C4** 同样读 `SHOW timezone`。
- CI 侧：`postgres:16-alpine` 服务用 `UTC` initdb 默认 + `ci-provision-role.mjs` 建的 `mn_app` **没有** `SET timezone`（`provisionSql` 内零 `timezone`/`ALTER ROLE`）⇒ CI 里 C4 能绿，是因为 **alpine 镜像默认就是 UTC**，不是因为有人显式钉了它。
- 风险：换一台 **服务端默认 timezone = PRC(+08)** 的机器（`.env.example:19-20` 明说共享 dev 机就是这副样子），`mn_app` 继承服务器默认 → 会话非 UTC → `client.ts:63` 抛、`db:check` C4 红。修法（`ALTER ROLE … SET timezone='UTC'`）此刻**只在共享库上被人工执行过**，CI/新机器上没有任何一步替它做。
- **这同时把那个装饰变量变成陷阱**：它让读 `.env.example`/`ci.yml` 的人以为「时区已由这个变量管住」，实际它不驱动任何东西。
- 复现：`docker run postgres:16` 起一个 `--tz=PRC` 的库，跑 `tools/migrate.mjs` → `pnpm db:check`，看 C4 红；再 `ALTER ROLE <user> SET timezone='UTC'` → 转绿。
- 置信度 **High**。建议（本票只登记方向，不在 throwaway 分支动）：把 `SET timezone='UTC'` 落进 `ci-provision-role.mjs` 与部署/迁移路径，让时区前提由代码拥有而非人工；`PG_SESSION_TIMEZONE` 要么接上真消费者、要么删掉别当假覆盖。

## 类别②：本机时区 / locale / 路径分隔符 — **扫干（已修项之外无新实例）**

- 应用层时区口径已**集中**：`shared/time/zh-cn.ts:41 BUSINESS_TIMEZONE="Asia/Shanghai"` 是全项目唯一业务时区出口；`instrumentation-node.ts:281` 显式把 croner 的 `timezone` 指到它（注释 275-279 明写这是为「Windows 开发机与 Linux 容器同构」）。⇒ 触发时刻不依赖容器 `TZ`。**不是缺陷**，是已收口的正确形态。
- 其余 `new Date(...)` 一律 `.toISOString()`（UTC），无裸本地日期串。`toLocale*`/`Intl.*` 在 src 下**零命中**（grep 已证）。
- 时区敏感断言（`zh-cn.spec.ts`、`notification.spec.ts`）都已用 `process.env.TZ="UTC"` 包裹并在 finally 复原——正是①的修法，已在。
- 路径分隔符：`tools/*.mjs` 未见 `split('/')`、硬编码 `/` 或 `\` 的拼路（grep 无命中）；跨平台靠 `node:path`。

## 类别③：依赖「共享库被人手工修过」的状态 — **1 处形态（并入 A 看）**

- 见 **A**：会话 UTC 的实际来源是共享 dev 库上的一次 `ALTER ROLE`，代码/CI/部署都不重放它 ⇒ 这是「手工修过的库状态」被当成可移植前提的**同一处根因**。
- 迁移/seed 自身已自洽：`ci.yml:167-170` 在流水线里跑 `pnpm db:migrate` + `db:seed`，CI 不依赖手工 seed。冒烟脚本对 PG* 缺失会**响亮失败**（探库那步），非静默依赖。

## 类别④：Unix shell 语法 — **扫干（已修项之外无新实例）**

- `package.json` 全部 scripts 复查：`verify:all` 已是 `cross-env MN_DB_CONFIRM=…`（②的修复，`cross-env@^10.1.0` 在 devDependencies）；其余脚本无 `VAR=x cmd` 裸前缀、无只在 bash 下成立的写法。
- `ci.yml` 里 `if [ "$n" -ne 3 ]`、`seq`、`>/tmp/…` 属**GitHub Actions ubuntu runner**，本就是 Linux——不是「Windows 跑不了」那类，合规。
- `agent-work/*.mjs` 的 `/tmp/next-dev.log`（`probe-matt74-*`、`wait-heartbeat`）是**探针可选路径**，缺失即优雅回落，且不在 CI 门禁路径上。

---

## NEW 风险排序

| 级别 | 编号 | 会不会真红 | 说明 |
|---|---|---|---|
| 1 | **A** | 换非-UTC 默认库会**响亮抛/红**（C4、client.ts:63），但**新克隆/新库上没有任何一步替它设 UTC** | 最该成票：把 `ALTER ROLE SET timezone` 落进 `ci-provision-role.mjs`/迁移路径；顺带处置装饰变量 `PG_SESSION_TIMEZONE` |
| — | ②④ | 无新实例 | 四处已修之外扫干，可审计 |

## 一度写错的一条（留作诚实轨迹，别再当发现读）

初稿把「`worker/` 读 `MN_SESSION_PEPPER` 但 compose 没注入」列为发现 B。核实后**不成立**：`worker/` 下无任何 `process.env` 读取（grep 零命中），`compose:26-27` 明写一期不引调度进程，而三把密钥（含 `MN_SESSION_PEPPER`，compose:66/67/81）由 compose 注入 **app** 服务。已删。这恰是本票的元教训——「以为」不是「代码事实」，所以每条都要落到 `文件:行号`。

## 我查过哪些（审计轨迹）

`.env.example`(全 78 行) · `.github/workflows/ci.yml`(全 226 行) · `package.json` 全部 scripts · `tools/{migrate,db-check,wait-heartbeat,ci-provision-role,keys,run-smokes,board-drift}.mjs` · `src/app/lib/server/{db/client,auth/auth,crypto/field-crypto,services/parties}.ts` · `src/shared/time/zh-cn.ts` · `src/shared/ids/snowflake.ts` · `src/instrumentation{,-node}.ts` · `src/app/api/internal/pump/route.ts` · `deploy/{docker-compose.yml,verify-deploy.mjs}` · `worker/`。

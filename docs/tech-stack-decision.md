# MatterNest 第一期技术选型（T1）v4

> 状态：**v4 —— 路线为全栈 Nuxt + 纯 shadcn-vue；认证为云之家 + 本地密码双通道（我方适配云之家）**。§3.3 已按 Vue 现实重写，§5 拓扑已改单 app，§12.3 禁令扩到八条。
> 核验依据：`research-nuxt-fullstack-nitro.md`（Nuxt 4.5.2 / nitropack 2.13.4 / drizzle-orm 0.45.3）与 `research-nuxt-table-vue-ui.md`（表格与组件能力）。
> 版本沿革：v1 定 NestJS + Drizzle + React/AntD；v2 补 NestJS 并发与数据库版本管理的实质论证（§3.1b、§3.2b），前端改 AntD 5 与 Tailwind/shadcn 混用（§3.3），新增快速上线切法（§9），并就 Nuxt 全栈改判（§11）；v3 以核验结果定稿路线（§12）；**v4（2026-09-26）三项改判**——认证改双通道并定"适配云之家"口径（§3.4/§6/§7 C–F）、前端由 Element Plus 改判为**纯 shadcn-vue**（§2/§3.3/§7 D/§11.4 S3 重定义）、仓库拓扑与 OpenAPI 等四处自相矛盾修平（§5/§10）。
> 本文是决策记录，不是教程。T2 阶段把 `.trellis/spec/` 的 12 个空模板按本文填成项目约定。

---

## 1. 这个系统的形态（选型判据从这来）

四条事实决定技术权重，先摆出来：

| 事实 | 权重影响 |
|---|---|
| 单一律所内部使用，用户数十到一两级、年案件量万级 | **不需要**分库分表、ES、微服务、消息队列中间件 |
| 法律文档涉密 + 当事人身份证 + 刚性期限 | 私有化部署、字段加密、审计、期限计算精度是**一级需求** |
| 四份设计文档的共同特征是：跨切约束（数据范围、审计、附件鉴权）+ 大量结构化列表表单 | 框架要能**收敛横切逻辑的落点**，否则每条规则散在几百个 handler 里 |
| 有定时扫描（节点提醒、规则 4）+ outbox 派发 | 需要**单飞保证**，但规模用不着引入 Redis/Redlock |

不满足这四条的选项，后面都不看。

---

## 2. 决定

| 轴 | 选定 | 关键理由 |
|---|---|---|
| 语言 | **TypeScript 全栈** | 枚举与 DTO 在前后端共用一份（枚举表 §5.1 的单一事实源要求），这是唯一能让 33 项枚举取值（枚举表 E01–E36）不出现两份实现的方案 |
| 运行时 | Node.js 22 LTS（当前机器 24 可跑，CI 锁 22） | 部署基线用 LTS；开发机不必降版本 |
| 后端框架 | ~~NestJS 10 + Fastify 适配器~~ ⚑ **已被 §12 取代：Nitro（Nuxt 4.5.2 内置，`server/api/**`）** | 见 §3.1（保留其"横切约束要有唯一落点"的诉求，实现改显式 `withScope()` 包装 + `server/middleware`，理由见 §11.1） |
| ORM / 查询 | **Drizzle ORM** + `postgres`(pg) 驱动 | 见 §3.2 |
| 迁移 | **drizzle-kit 生成 + 手写 SQL 补丁段**，SQL 文件进版本库 | 见 §3.2 |
| 校验/契约 | **Zod**，schema 定义在 `shared/schema` | 一处定义 → DTO 校验、前端表单规则、OpenAPI 三方复用（原写 `packages/domain`，随 §5 单 app 拓扑改路径） |
| 前端 | ~~React 18 + Vite + Ant Design 5 与 Tailwind/shadcn 混用~~ ⚑ **已被 §12 取代：Nuxt 4 SPA（`ssr:false`）+ 纯 shadcn-vue + Tailwind v4 + 自封装 `DataTable`（`@tanstack/vue-table`）** | 见 §3.3（本节已按 Vue 现实重写；"密集表格与动态表单最重"这个判断不变，变的是它们改成自封装） |
| 服务端数据 | **TanStack Query 5** ⚑ Vue 侧为 `@tanstack/vue-query`，用法与 `staleTime` 口径不变（见 §12.5） | 列表分页/筛选/详情缓存是本项目的主战场，手写缓存必然出错。**加分项**：表格用的 `@tanstack/vue-table` 与它同族，状态层同源 |
| 认证 | **双通道**：云之家登录（授权码换 eid/openId → 绑定本所账号）+ 本地用户名密码；会话统一走服务端 session 表 + httpOnly cookie | 见 §3.4 |
| 对象存储 | **MinIO**（S3 兼容）自建 | 法律文件不出内网；后端签 60s URL，不直暴 MinIO |
| 定时任务 | ~~`@nestjs/schedule`~~ ⚑ **Nitro scheduled tasks（`nitro.experimental.tasks`）+ PG `pg_try_advisory_lock` 单飞** | 见 §3.5 与 §12.2 C1（N 副本 = 触发 N 次，锁是正确性前提） |
| ID | 应用层雪花，`shared/ids` | 与设计的 `bigint` 主键一致 |
| 测试 | Vitest + supertest + Playwright；权限矩阵用 `test.each` 参数化生成 | 权限草案 §10 的组合数按 **角色数 × 对象类数 × 入口数** 生成（现为 5 × 3 × 7 = 105 例，且会随入口增减而变），**不要在文档里钉死常数**，手写更不可能 |
| 仓库 | **pnpm workspaces 单仓** | 见 §5 |
| 部署 | **Docker Compose 单机**：app + postgres + minio | 见 §6 |

---

## 3. 关键取舍的展开

### 3.1 NestJS 而不是 Fastify 裸写

NestJS 更重，这里换的是**三件横切东西有唯一落点**：

```text
权限草案 §4  ScopeResolver + 禁止裸表访问  → Guard + Repository 基类
权限草案 §7.3 附件签名前逐条判可见性        → 同一个 Guard 复用
修订稿 §6.3  activity_log 审计             → Interceptor（写操作成功后落日志）
枚举表 §5.1  特权开关判定                  → 自定义装饰器 @RequirePrivilege('can_unarchive')
```

设计文档里那些"必须经 ScopedQuery 构造""默认拒绝"这类约束，在裸 handler 架构下只能靠 code review 兜——而 review 恰好是最不可靠的一环。用 DI 容器 + Guard 链可以把它们变成结构性约束。

> ⚑ **本节的落点词已随 §12 改判过期**：上面的 `Guard` / `Interceptor` / `@RequirePrivilege()` 是 Nest 的实现形式，Nuxt 路线下分别换成 `withScope()` 显式包装、服务层单点写入、`requirePrivilege(event, …)` 辅助函数。**这张表要读的是右列的诉求（横切约束必须有唯一落点），不是左列的关键字**；权威映射看 §4 对应表。

代价说清楚：装饰器与隐式依赖让新人上手慢一档，且 Nest 的版本升级偶有 breaking。第一期接受。

### 3.1b 并发能力：真实瓶颈不在框架

Node 是单线程事件循环，所以**NestJS 的"并发"是 I/O 并发，不是 CPU 并行**。对这个系统来说 I/O 并发完全够用——数十到一两级用户、CRUD 为主、单请求 CPU 开销（Guard 链 + Drizzle 查询构造 + Interceptor）在 1–3ms 量级，几千并发连接也不是这个体量会遇到的事。

**真正会出事的是三类 CPU 活把事件循环占住**，而这个设计里恰好三处都有：

| 风险点 | 出处 | 为什么卡 | 处理 |
|---|---|---|---|
| 当事人字段加解密 | 权限草案 §7.3、枚举表 §7 | 列表页一次 100 行 × 3 个加密列，AES-GCM 逐行同步解工会让整条请求队列停住 | 走 `worker_threads` 批处理，或列表页只回掩码值、**明文只在单条详情按需解**（本来就要 `can_read_plain`） |
| 附件 sha256 + 大小/类型校验 | 修订稿 §7.1 | 50MB 文件同步 hash 直接冻结进程 | 上传用 stream，hash 在管道里增量算；校验放 worker |
| 导出（含脱敏与逐条重判） | 权限草案 §7.3 | 导出天然量大 | 异步任务 + 轮询/下载链接，不在请求内做完 |

另两条与并发直接相关的约束：

```text
连接池   pgbouncer(transaction mode) 或应用侧 pool 10–20
         注意：事务内 SET LOCAL / advisory lock 与 transaction-mode pooling 冲突，
         用 session-mode 或给扫描任务单独直连
多核    Node 单进程吃不满多核 → cluster 模式或 2–3 容器副本 + nginx
         本设计已为此留好前提：定时扫描靠 pg_try_advisory_lock 单飞（§3.5），
         多副本不会重复发提醒；outbox 投递器同理
```

结论：**NestJS 的并发对这个系统不构成风险，也不构成优势**——它是中性的。优势在 §3.1 说的横切落点。如果哪天出现重 CPU 需求（比如卷宗 OCR），那块单独拆一个 worker 服务即可，不影响主架构。

> 顺带一句诚实的比较：真要论 CPU 并行吞吐，Spring Boot（尤其 Java 21 虚拟线程）确实比 Node 单进程强。但这个体量下决定上线速度的是 CRUD 的开发效率，不是吞吐上限。

### 3.2 Drizzle + SQL 优先的迁移，而不是 Prisma

本项目的设计文档大量依赖 **PG 专有特性**：

| 设计出处 | 需要的特性 |
|---|---|
| 修订稿 §2.1 | partial unique index（`WHERE is_enabled`） |
| 修订稿 §8.2 | 部分索引（`WHERE NOT is_deleted AND NOT is_archived`） |
| 修订稿 §6.1 | `generated always as (...) stored` 生成列 |
| 枚举表 §5.2 | 表级 `CHECK` |
| 转案件 §4.1 | outbox 部分索引 + `ON CONFLICT` |
| 转案件 §4.2 | `SELECT … FOR UPDATE`、`pg_try_advisory_lock` |

Prisma 的 schema DSL 表达不了 partial unique index 和 `FOR UPDATE`，只能退回 `@@ignore` 的手写迁移，等于两套真相。**Drizzle 的 schema 就是 TS，能声明 CHECK 与生成列**；partial index 它不表达，就在同一条迁移的尾部追加手写 SQL——关键是**同一份迁移文件**，不另起一套工具。

> 硬规则：**不允许为了迁就 ORM 而砍设计要求**。哪个特性 Drizzle 表达不了，就写 SQL 补，不允许"这个索引先不加"。

### 3.2b 数据库版本管理：Nest 与迁移工具是解耦的

先明确一点，因为它常被误读成"NestJS 支持不支持 migration"：**Nest 本身不管迁移**。它是 DI 容器 + HTTP 框架，数据库版本管理由 ORM/CLI 承担，任何工具都能配。TypeORM 看起来"更搭"，只是因为它内置 `DataSource` + migration CLI 和 `migrationsRun` 启动钩子；换 Drizzle 就是 package.json 里两条脚本的差别。

落地方案：

```text
schema 真相    packages/db/schema/*.ts        （Drizzle，供类型安全查询）
迁移真相       packages/db/migrations/*.sql   （编号文件，进版本库，可 review）
生成           drizzle-kit generate 产初稿 → 人审 → 需要时尾部追加手写 SQL 补丁
应用           部署前 `drizzle-kit migrate`（CI/CD 或 compose one-shot 服务）
               不在应用启动时自动跑
```

三条硬规定，都是踩坑换来的：

1. **共享环境禁用 `drizzle-kit push`**，也禁用任何 schema sync。`push` 是"按当前 schema 直接改库"，多分支并行会静默丢列；只有编号迁移文件能 review、能回滚、能审计。
2. **迁移文件是唯一事实**，不是 `schema.ts` 的产物快照。出现漂移时改迁移，不反向同步。
3. **seed 是数据迁移，不是手点 SQL 控制台**：5 张配置表 + 5 角色 + 5 规则 + 7 模板写成幂等 `INSERT ... ON CONFLICT (code) DO NOTHING`，新环境一条命令拉起，测试库复用同一份。

有一处实现细节需要你安排在 T7 之前拍掉：Drizzle 的 schema DSL 对 **partial index（`WHERE is_enabled`）、表级 `CHECK`、生成列** 的支持程度随版本变化，我不替你断言。安排 **0.5 天 spike**：拿三张最难的表实跑一次 `drizzle-kit generate`——`automation_rule`（partial unique）、`matter_node`（生成列 + CHECK）、`status_config`（三个条件唯一索引）。**若产出明显残缺，就退到纯 SQL-first**（`node-pg-migrate` 或 umzug 手写 .sql，Drizzle 只当查询器）。这个决定越早越便宜，它会连带改变 §5 的 `packages/db` 结构。

### 3.2c 迁移的执行方案（与框架无关，两条路线通用）

```text
时机     不在 app 启动时跑
         deploy/compose 增加一次性服务：
           migrator: command: npx drizzle-kit migrate , restart: "no"
           app:      depends_on: { migrator: { condition: service_completed_successfully } }
         → 多副本抢跑迁移的问题结构性消失
并发保护 migrator 入口先 SELECT pg_advisory_lock(<固定常量>) 再执行
         手工在多主机上重复执行时也只会有一个赢家，其余等锁后见空库即返回
分类     schema 迁移：drizzle-kit 生成 + 尾部手写 SQL 补丁
         数据迁移：seed 与回填，手写编号 SQL，幂等 ON CONFLICT DO NOTHING
         两类同目录、编号连续、按文件名序执行；数据迁移必须在自己编号段内可重放
命名     drizzle-kit 产出的是内容哈希文件名，不利 review。
         不改名（改名会破坏 _journal 映射），改为在 docs/migrations.md 记
         「编号 → 意图 → 影响的表」，review 看这份索引而不是看哈希
回滚     第一期只随附 down 脚本、不自动执行；线上问题一律 forward-fix
         （理由：自动回滚会连带回滚数据迁移，而数据迁移常常不可逆）
一致性 CHECK 取值与 packages/shared 的值数组由一条集合比较测试把关
         （枚举表 §5.1 已把 codegen 改为手写 + 测试）
```

### 3.3 前端：纯 shadcn-vue + Tailwind（v4 重写）

> 本节在 v2 时论证的是"AntD 5 与 Tailwind 混用"，v3 改判全栈 Nuxt 后一直没重写，甚至留着"不采用 Nuxt 的三条理由"。路线已定，这次按 Vue 现实整体重写。**判断里仍然成立的部分我保留了**，见本节末。

**先认这条路线买到了什么**：组件源码复制进仓库、没有黑盒 API，agent 能读能改；Tailwind 是模型写得最熟的样式语言；不受组件库版本天花板约束；无障碍（键盘导航、焦点管理、aria）由无样式原语兜住，不必自研必定做错的那部分。这几条正是本项目"由 agent 大量实现"前提下的主要收益。

**"纯 shadcn"与"要不要用 TanStack Table"不是选择题。** shadcn/vue 的 Data Table 页明写它是 "built using TanStack Table"——TanStack Table 是 **headless 状态层**（只管排序/分页/筛选/选择/列模型，不管长什么样），用它不构成引入第二套视觉体系。所以"纯 shadcn"落到 Vue 侧就是：`shadcn-vue + Tailwind v4 + @tanstack/vue-table 自封装 DataTable`。真正会破坏"纯"的只有一个动作：**为某个缺件去引一套带样式的组件库**（Element Plus / AntD Vue / Vuetify），这条由 §12.3 禁令 ⑦ 关掉。

一手核验与缺口清单见 `research-nuxt-table-vue-ui.md`（含 VERIFIED / PARTIAL / 未证实 分级）。本项目最重的四件：

| 件 | Vue 侧现成度 | 落地方式 |
|---|---|---|
| 密集表格（案件/事项/当事人/我的关注/通知 5 张 + 详情内嵌表） | 半现成 | 以 Data Table 为底，**自封装一张 `DataTable.vue`**：受控分页参数、筛选模型、批量选择、列显隐统一收口。**禁止客户端全量排序**（万级数据 + 行级权限，权限草案 §4） |
| 转案件动态表单（N 个案件卡片 + 跨卡复制 + 每卡 10+ 字段联动校验） | 要自写 | Form 底层官方给三条：VeeValidate / TanStack Form / Formisch —— **钉死一个，全项目不得混用**；数组字段与跨卡复制自管；id 类字段不参与复制（映射矩阵 §3） |
| 附件上传（预签名 PUT 直传 + 进度 + 白名单 + 多文件） | **清单里没有，唯一确认的空白件** | 自封装 `FileUpload.vue`。因为 C3 已把后端中转砍掉，逻辑面窄：**1–2 天**，不是无底洞 |
| 日期与法律期限（含"剩 N 天"） | 半现成 | 有 Calendar / Date Picker / Range Calendar；**中文 locale 未证实，spike 实测**；期限计算仍走 `shared/time`，`date` 与 `timestamptz` 的边界不因组件库改变 |

**成本口径变更**：v2 里"+1~1.5 周"是待拍的假设 D，现在是**已接受的确定成本**，具体去处就是上表四件。压缩手段只有一条有效的：**先把 `DataTable.vue` 封好**，它一张覆盖 5 个列表页，是全项目复用率最高的一块；其余按需补，不要提前做通用组件库。

**样式体系约定（替换原 preflight 那条）**：原来的 `corePlugins: { preflight: false }` + AntD 走 `ConfigProvider` 令牌，是为两套体系共存打的补丁——现在只有一套，**整段作废**。新约定三条，原样进 T2 的 frontend guideline：① 间距与色彩只用 Tailwind 令牌，不留第二套刻度；② 覆盖组件默认样式一律走 `cn()` 合并，禁止行内 style 与 `!important`；③ 业务组件不得直接依赖原语包（`reka-ui`/`radix-vue`，包名待 spike 定），一律经 `components/ui/` 那层封装，将来换原语只改一层。

**仍然成立的两条旧判断**（v2 论证里不是全错）：
1. **shadcn 在数据密集后台确实是短板** —— 上面的成本表就是这条的兑现，不是被推翻。
2. **admin 模板帮不上本项目的难题** —— 它给的是菜单/路由可见性，而本项目难在**行级数据范围**（三档 + ScopeResolver + 不可见返 404 而非 403，权限草案 §4）。这条打的是"套别人模板"，不是打 Nuxt，所以改判后依然作数：**我们不套 admin 模板，组件全自己拿**。

### 3.4 session 表 + 双通道登录（云之家 / 本地用户名密码）

**会话机制不变**：权限草案 §8 要求"角色/权限变更下一次请求即生效"，靠 `app_user.token_version` 做失效判定。用 JWT 的话这个校验只能在签名有效期内被动等待；session 存 PG 则可以**主动删行**，语义更直白，也不引入 Redis 依赖（内部系统并发量用不着）。`token_version` 用途收窄为：session 内缓存的权限集以它为键，版本不一致即重解析。

> 2026-09-26 决策：第一期就要**云之家登录 + 用户名密码**两条通道。本节取代 v3 的"第一期只做本地账号"，§7 假设 C 随之作废。

**云之家通道的形态**（身份键与 token 换取方式按本地 SY-YunAgent 的既有一手经验对齐：`eid`/`openId` 为人档主键，服务端用企业应用 token 调人档接口）：

```text
登录   前端跳云之家授权 → 回调带 code → 服务端换 accessToken → 取 eid/openId
绑定   按 (provider='yunzhijia', external_id=eid) 查 app_user_external_identity → 命中即签发 session
在册   定期用应用 token 拉成员/通讯录，比对 external_id：所内已不可见 → is_enabled=false
       + 删其全部 session + token_version++
边界   只取"在职与否 + 姓名/手机"，**不落部门、不参与任何权限判定**——第一期无组织维度
       这条是硬约束，否则通讯录同步会顺手把 dept 带进模型，权限草案 §9 的代价表就白写了
```

**离职回收的降级方案（若云之家不提供成员列举接口）**：上面的"在册"扫描依赖开放平台能列出在职成员。若实际只给"按 `eid` 查单人"，则退化为两条一起用——① **登录时校验**：每次签发 session 前查一次人档，查不到即拒绝并置 `is_enabled=false`（准确但只覆盖"还会来登录的人"）；② **长期未登录告警**：`auth_session` 最末活跃 > 30 天的账号进管理页待处理列表，由 `can_manage_user` 人工停用。这条组合不是"自动回收"，所以**必须在 master §6.2 与 §7 里显式登记为已接受的残余风险**，不能写成已具备离职即失效。云之家真实接口能力确认后二选一，本条即为分叉点。

**表结构增量**（不改 `app_user` 的认证语义，认证凭据一律外挂）：

| 表 | 关键列 | 说明 |
|---|---|---|
| `app_user_external_identity` | (provider, external_id) UK、user_id FK、synced_at、sync_status | provider 取值 `yunzhijia`（第一期唯一外部源）；`eid`/`openId` 存这里，不塞进 `app_user` |
| `app_user_credential` | user_id UK、password_hash、updated_at、failed_attempts、locked_until | **1:0..1**：没有这行 = 该账号不能用密码登录。避免在 `app_user` 上堆一串互相矛盾的可空认证列 |
| `auth_session` | token_hash、user_id、auth_via(`local`/`yunzhijia`)、expires_at、revoked_at | `auth_via` 供审计与差异化失效策略 |

**两条必须现在就定的失效规则**：云之家不控制我方 session 生命周期，所以 ① 云之家会话的 session 要有绝对过期（建议 12h）+ 每次权限解析时校 `sync_status` 新鲜度（>24h 未同步则降级为只提示管理员，不静默放行）；② 本地密码账号没有"离职即失效"的自动回收，**所以密码通道能给的账号越少越好**（见 §7 假设 E）。

**成本修正**：原估"OIDC code flow + 保留 session 表 = +2~3 天"，加上通讯录在职同步、绑定冲突处理、密码凭据表与失败锁定，实际 **+3~5 天**；另涉及云之家开放平台的应用注册（appId/appSecret）、回调地址、内网可达。

> **口径（2026-09-26 定）**：**以云之家的设计为准，我们这边适配**。云之家侧不改造——免登/授权的凭证形态、能给的字段、回调与域名要求、token 有效期，全部按开放平台现状接。落地前先做一件小事：拿你手上那个云之家应用的文档与实调结果，把 §3.4 上面那段流程逐步替换成真实接口名（`eid`/`openId` 的取得方式、人档字段、限流、有效期），本文不替云之家编端点。
>
> 这条口径带来一个必须现在想到的连带后果：**"我们按云之家来"意味着云之家给不了的能力，就得由我们自己兜**。第一项要兜的就是离职自动回收，见下条。

### 3.5 定时任务单飞用 PG advisory lock

需要跑三件事：节点提醒扫描（跨两张节点表）、规则 4 的 30 天无更新扫描、outbox 投递。

app 是单实例部署，但**滚动发布期会双实例并存**，届时提醒会发两遍。解法是一条 SQL：

```sql
SELECT pg_try_advisory_lock(hashtext('matternest:reminder-scan'))
```

拿不到锁直接返回。比引入 Redis + Redlock 少一个组件、少一类故障面，且天然和事务同生命周期。

### 3.6 明确不做（第一期）

| 项 | 为什么 |
|---|---|
| Elasticsearch / 全文检索 | 案例模块已移出第一期，第一期无检索需求；中文分词还要额外扩展 |
| 消息队列（Kafka/RabbitMQ） | 单体内 outbox + 进程内投递器足够 |
| Redis | session 在 PG，缓存只有权限集一处且量小 |
| 微服务拆分 | 用户量与领域耦合度都不支持这个成本 |
| ORM 软删除插件 | 设计已定 `is_deleted` + 部分索引，语义要显式控制，不能让插件偷偷改写查询 |
| 前端 SSR/Next.js | 内部后台，无 SEO 需求，SSR 只增加部署与鉴权复杂度 |
| monorepo 构建缓存（turborepo/nx） | 3 个 app、5 个 package 规模下收益不明显，先裸 pnpm |

---

## 4. 设计文档 → 技术落点的对应表

这张表是 T2 填 spec 时的目录，也是验收时的索引：

| 设计约束 | 落在哪 |
|---|---|
| 枚举单一事实源（枚举表 §5.1） | `shared/enums/*` 导出值数组 + TS 类型；`CHECK` **手写进迁移 SQL**，由一条集合比较测试把关（本行原写"迁移期由值数组生成 `CHECK`"是枚举表 v2 之前的旧口径，已同步纠正） |
| ScopeResolver + 禁止裸表访问 | `server/db` 仓储基类断言 + 显式 `withScope(event, handler)` 包装；CI 检查无裸 `select()`（**原写"Nest Guard"，随 §12 改判失效**） |
| 404 而非 403 | `server/middleware` 统一出口 + 错误映射到 `createError`；一律落 `/api/**` 保证返回 JSON（§12.3 禁令 5） |
| `activity_log` 自动落审计 | 服务层单点写入包装（写操作成功后落日志）+ 显式 `reason` 参数（偏离路径必填那类走服务层校验）。**原写"Interceptor"，Nuxt 无此概念** |
| 特权开关 | 统一鉴权辅助函数 `requirePrivilege(event, 'can_unarchive')`，读 `role` 四布尔（**原写 `@RequirePrivilege()` 装饰器**，装饰器是 Nest 的落点） |
| outbox 至少一次 + 去重 | `server/tasks` 投递器循环 + `notification_event.dedupe_key` 唯一键冲突即跳过；全程包 `withSingleFlight()` |
| `scope_key` 归一化 8 条向量（枚举表 §4.4） | `shared/automation/scope-key.spec.ts`，逐向量断言 |
| 字段加密 + HMAC 索引列 | `shared/crypto`，密钥从 env 注入，不入库 |
| 期限计算（`date` vs `timestamptz`） | `shared/time`，禁止业务层裸用 `Date` |
| **前端唯一组件体系（§3.3 / §12.3 禁令 7）** | 只有 `app/components/ui/`（shadcn-vue 复制件 + 自封装 `DataTable.vue`、`FileUpload.vue`）；业务组件不得直接 import 原语包，不得引入第二套带样式组件库 |
| **表格强制服务端分页（§12.3 禁令 8）** | `DataTable.vue` 只接受 `page/pageSize/sortBy/sortDir/filters` 受控参数并打 `/api/**`；**禁止客户端全量排序**——那等于绕过 ScopeResolver 读到自己无权的数据 |
| 双通道登录（§3.4） | `server/api/auth/*` 两组端点（`/local`、`/yunzhijia/callback`）+ 同一个 `auth_session` 签发口；在职同步挂 scheduled task 并包 `withSingleFlight()`（C1） |
| 外部身份映射（§3.4） | `app_user_external_identity` + 唯一键 `UK(provider, external_id)`；**禁止**把 `eid` 写进 `app_user` 或前端可读的 DTO |

---

## 5. 仓库拓扑

```text
MatterNest/                     单 Nuxt 4 应用（v3 定稿后不再有 apps/server + apps/web 两个 app）
├─ app/                         页面层（srcDir=app/；ssr:false + spa-loading-template.html）
│  ├─ pages/ · composables/
│  ├─ components/ui/            shadcn-vue 复制进来的组件 + 自封装件（DataTable.vue · FileUpload.vue）
│  │                            —— 业务组件只准依赖这一层，不得直接 import 原语包（§12.3 禁令 7）
├─ server/                      Nitro 后端
│  ├─ api/                      一律落 /api/**（禁令 5）：auth/ · matters/ · risk-matters/ · settings/ …
│  ├─ middleware/               会话解析 + 404 兜底（每请求执行，含 404 路径）
│  ├─ tasks/                    节点提醒 / 规则 4 / outbox 投递 / 云之家在职同步 —— 全部包 withSingleFlight()
│  ├─ db/                       Drizzle schema、仓储、ScopeResolver（= 旧构想的 packages/db）
│  └─ utils/                    服务端专用（可 import Node API）
├─ shared/                      ⚑ 前后端唯一共用层，**纯 TS**：enums(E01–E37) · Zod schema · ids · time · crypto
│  └─ （禁令 1：不得 import Vue / Nitro runtime / Node API；只有 shared/utils、shared/types 自动导入）
├─ deploy/                      compose、minio 桶策略、备份脚本、migrator 一次性服务
├─ docs/                        7 份文档（基线 / master / 修订稿 / 枚举 / 权限 / 转案件 / 技术选型）+ research
├─ CHANGELOG.md
└─ .trellis/                    工程配置（spec 待 T2 填充）
```

依赖方向单向：`app/** → shared/**`，`server/** → shared/**` 与 `server/** → server/db`，`shared/**` 不依赖任何一层、且**不得**出现 `#server` 或 Vue 导入（这条是结构性约束，违反即 CI 失败——两侧 bundle 独立是 Nuxt 官方行为，不是风格问题）。

> 本文件 §4 对应表里写的 `packages/domain/*`、`packages/db` 是 Nest+React 时代的旧路径，按上图读作：`packages/domain/*` → `shared/*`，`packages/db` → `server/db`。§11.3 列的切换成本之一就是这层重命名，别再照旧路径建目录。

`.trellis/config.yaml` 的 `packages` 段需按此填（当前全在注释里），否则 Trellis 的包上下文检测拿不到东西。

---

## 6. 部署形态

```text
docker compose (单主机，律所内网)
  app      : apps/server 产物，2 副本以内
  postgres : 15+，pg_dump 每日 + WAL 归档到异地
  minio    : 单盘 + 桶版本化；仅 app 网络内可达，不对公网开
  nginx    : TLS 终结 + 反代，只暴露 /api 与静态资源
```

四个部署期必须落地的安全项，都来自设计文档而非通用建议：
- 密钥（AES-GCM 主密钥、HMAC 密钥）从 env/secret 注入，**两把密钥分离**，`key_version` 列先留（修订稿 §6.3）。
- 云之家应用凭据（appId/appSecret）同样从 env 注入、不入库不进镜像；回调地址要在开放平台登记，且**登记规则以云之家侧为准**（§3.4 口径：我们适配云之家，不改造它），所以**部署域名必须在联调之前定死**，改域名要重走一次登记。另需一条明确口径：云之家侧不可达时，保留哪些账号能走本地密码登录（建议至少留一个 `sys_admin`），否则整所会一起被锁在门外。
- 当事人身份证明文导出与 `SENSITIVE_FIELD_READ` 日志必须同链路，导出走脱敏 DTO 而非前端遮罩。
- `activity_log` 留存期与备份策略要按所内合规要求定，属 G 组未决（§10）。

---

## 7. 假设与裁定（七条）

原先这节标题写"四处假设"但表里已有六行、且 D 行被中间那段散文挤出了表格块——一并修正，现补 G 共七行。现状：**A/B 仍待确认，C–F 已裁定，G 为本次新定**。

| # | 假设 | 依据 | 若不成立 / 裁定结论 |
|---|---|---|---|
| A | **团队是 TS/Node 背景** | 你在 SY-YunAgent 是 npm scope 的 monorepo，本机 Node 24 | 换 **Spring Boot 3 + MyBatis 或 JPA + Flyway(SQL-first) + 同一套前端**。设计文档全部不受影响，只有 §3.1/§3.2/§3.1b 与仓库拓扑要重做 |
| B | **单所内部使用、无跨所隔离** | 本轮已定"不引入组织维度" | 若将来多分所，权限模型重写（转案件 §5、权限草案 §9 已记录该代价） |
| C | ~~第一期不接 SSO/IdP~~ | **已作废**（2026-09-26 裁定）：第一期即做云之家登录 + 本地密码双通道，见 §3.4 | 工作量已并入 §3.4 的 +3~5 天；外部依赖（应用注册、回调登记、内网可达）见 §6 |
| D | ~~前端取"AntD + Tailwind 混用"而非纯 shadcn~~ **已裁定（2026-09-26）** | 路线已是全栈 Nuxt（§12），AntD 混用这条比较对象随之消失 | **取纯 shadcn-vue + Tailwind v4 + `@tanstack/vue-table` 自封装 DataTable**；"双库混用"选项作废。代价（前端 +1~1.5 周）转为**已接受的确定成本**，去处与压缩手段见 §3.3；核验见 `research-nuxt-table-vue-ui.md` |
| E | ~~本地密码通道给多大范围~~ **已裁定（2026-09-26）** | **只留少数兜底账号**：`sys_admin` 与运维/兜底账号可设密码，其余一律云之家登录。`app_user_credential` 无行的账号天然不能密码登录，不需要额外开关 | 密码账号没有离职自动回收，每多一个可密码登录账号就多一个人工管理的长期凭据 |
| F | ~~云之家首登是否自动建号~~ **已裁定（2026-09-26）** | **自动建号但落"待开通"态**，管理员在待批队列一键批准并当场选角色。新列 `app_user.activation_status`（枚举 E37：`pending`/`active`），批准动作写 `USER_ACTIVATED` | 若改回"预建再绑定"，需要额外做账号批量导入与外部身份预挂界面（+1~2 天）；若改回"首登即可用"，等于取消管理员闸门 |
| G | **一期只做 PC 浏览器**（2026-09-26 定） | 系统重头是密集表格与转案件动态表单，窄屏下这两件的形态完全不同 | 窄屏/移动端响应式列二期。若将来要手机查阅，最小集是"我的关注 / 通知 / 案件详情 / 评论"四屏，**不含建案与转案件** |

**两条与 E/F 绑定的实现口径**（避免各写各的）：`activation_status` 与 `is_enabled` 语义正交——前者只表达"要不要让他进来"（首登自动建号即 `pending`，登录返回「等待管理员开通」），后者表达"停用/离职"（`false` 即吊销 session）。**两者都不参与数据范围判定**，判定只看 `role.data_scope` + 特权 + 护栏。其次：**登录成功/失败不写 `activity_log`**（会灌表且不是业务动作），走 `auth_session` + 结构化应用日志；只有 `USER_ACTIVATED`、`ROLE_CHANGED`、`is_enabled` 变更这三类进业务审计。

另有一条口径冲突要定：`.trellis/spec/` 模板结尾写着 "All documentation should be written in **English**"，而 `docs/` 现有 9 份文档（7 份设计 + 2 份 research）全是中文。T2 填 spec 前先定：**约定文档英文、设计文档中文**，还是统一到一种。

---

## 8. 下一步

T1 定稿后依次：
1. **F（0.5 天，最先做）** 前端装配 spike：`shadcn-vue init` 后的真实原语依赖与版本、一张服务端分页的表、动态数组表单、自写上传件、中文 locale —— 验收标准写在 `research-nuxt-table-vue-ui.md` §5。它决定组件层，做晚了整片页面返工。
2. ~~S0（0.5 天）Drizzle spike~~ **已完成**：`research-nuxt-fullstack-nitro.md` §5 用 `drizzle-kit@0.31.11` 实跑过 `generate`，结论是可表达，代价是 `.where()` 只用 `sql` 模板、pg 侧无 `.stored()`、开发期禁用 `push`（已全部进 §12.3 禁令）。
3. **T2** 填 `.trellis/spec/` 12 个模板（内容取自本文 §4 对应表 + 枚举表 §5 + §12.3 八条禁令 + §3.3 样式三条），并填 `.trellis/config.yaml` 的 packages 段。
4. **T7** 生成迁移与 seed（schema + SQL 补丁 + 幂等 INSERT）。
5. **T3** 删除语义（B8），然后才轮到 T5 原型与 T8 API 契约。

---

## 9. 快速上线切法（你要求的"快"，代价在这几刀）

按"上线后律所同事能不能开始用它管案件"来切，而不是按模块完整度切。

| 波次 | 内容 | 为什么这么切 |
|---|---|---|
| **P0 上线必带** | 风险事项、案件、节点、进展、评论、附件；三档数据范围 + 审计；`FX/AJ` 编号生成；转案件（含 outbox + `risk_converted`）；归档与偏离确认；**前端两件前置封装：`DataTable.vue` 与 `FileUpload.vue`** | 缺任何一项，主流程就不闭合：能建案但转不了，或转了但没人看得到。前端这两件是 P0 的地基——`DataTable` 一张覆盖 5 个列表页（案件/事项/当事人/我的关注/通知），`FileUpload` 是 shadcn-vue 唯一确认没有现成件的一块（核验见 `research-nuxt-table-vue-ui.md` §4），都要在写业务页之前先落 |
| **P1 可推后 2 周** | **自动化规则的配置页与通用引擎**。P0 阶段把「节点到期提醒」「结案通知关注人」两条按内置定时任务硬编码实现，规则表结构与 seed 照常建好 | 规则引擎是全套设计里最贵的子系统（5 触发 × 5 动作 × scope_key 唯一性 × 冲突检测 × 聚合去重），而第一期真正要跑的行为只有 2–3 条。表结构先建、UI 与引擎后补是**只加不改**，不会返工 |
| **P1 同批** | 自定义提醒 `custom_reminder`（重复规则、多渠道）、关注 feed 的未读计数、导出 | 有替代路径（未读=肉眼看列表；导出=手工汇总），不阻塞主流程 |
| **建议移出第一期** | 邮件渠道、批量导入、全局搜索 | 每一项都要额外基础设施（SMTP 送达与退信、导入模板与冲突处理、检索方案），收益却是个别的 |

**登录通道的切法**：开发期与端到端联调先用**本地密码**跑通（不依赖外部平台，不阻塞别人），云之家登录并行推进。**注意口径（§3.4）：我们适配云之家，不改造它**——所以应用注册与回调登记不是"等对方审批"，而是"我们按它的登记规则去配"，其中最早要定的动作是**部署域名**（改一次域名要重走一次登记）。但 **P0 正式上线时两条通道都必须在**，因为所内同事的日常入口就是云之家，只留密码等于把新系统挂在"大家得记一个新密码"上，G1 登记率第一个月就会塌。在职同步任务可以晚两天，但 `is_enabled=false` 的 session 吊销必须在 P0 就位，否则离职后仍能访问是要出安全事故的。

规则 7（转案件→归档）**不能推到 P1**：它依赖的 outbox 与 `conversion_status` 已在 P0，且它是"事项转完还挂在进行中"这个体验问题的唯一解。

这条切法带来的额外好处是 P0 可以直接用 T1 的技术栈跑通端到端，不必等规则引擎与通知模板全部对齐——这也是我把它写进决策文档而不是排期文档的原因。

---

## 10. 请你评审的具体条目

不要通读，逐条拍就行：

1. **§7 A**：是不是 TS/Node 团队。（否 → 后端整块换，其余不动）**仍待你确认**
2. ~~**§7 D**：前端混用 vs 纯 shadcn~~ → **已裁定（2026-09-26）**：纯 shadcn-vue + Tailwind v4 + 自封装 `DataTable`（`@tanstack/vue-table`）。Element Plus 选项作废，§3.3 已按此重写。剩余待做的不是决策而是核验：`research-nuxt-table-vue-ui.md` §5 的 F spike（原语包名与版本、装配、四件封装）。
3. **§3.2b 规定 1**：共享环境禁用 `drizzle-kit push`，只走编号 SQL 迁移。有没有现存流程冲突。（§12.3 禁令 4 已把这条扩到开发期，实测依据见 research §5）
4. **§3.1b 表格**：三类 CPU 阻塞活（逐行解密、大文件 hash、导出）是否接受"worker 线程 + 异步导出"这个处理强度，还是第一期就把导出砍到 P1（我在 §9 已放到 P1）。注意 §12.4：`worker_threads` 在 Nuxt+Nitro 下是**待 spike 项**，不是已定方案。
5. **§9 切法**：把自动化规则配置页推到 P1、只硬编码 2 条内置提醒，能不能接受。这是本期最大的省时间来源。（按今天的裁定，那两条对应规则 5/6 与规则 2，硬编码时要按新口径写）
6. **§3.1b 连接池那条**：如果部署要上 transaction-mode pgbouncer，advisory lock 与 `SET LOCAL` 都得改走 session-mode 直连。**§12.5 已定为不引 pgbouncer、连接池 10**，此条随之一并关闭。
7. ~~**§11 路线选择**~~ → **已按 §12 定稿全栈 Nuxt**。原先挂在 S3 上的"路线级风险"已经换掉：S3 不再问"Element Plus 表格够不够"（该库已出局），改问 **shadcn-vue 在 Nuxt 4.5 能否装配、四件重活能否自封装**，即 §8 第 1 项的 F spike。退路也不再是"退回 Nest + React"（那要跟已裁定的唯一体系打架），而是"缺件继续自封装 + 砍非必要表格交互 + 如实补记工时"。

---

## 11. 备选路线：Nuxt 全栈（改判推荐）

### 11.1 先把反对理由逐条结算，别让错论证进决策

| 原理由 | 结算 |
|---|---|
| ① 多一个 SSR 运行时是纯成本 | **撤回**。`ssr:false` 或按路由关，成本不成立 |
| ② 换 Nuxt 实质是换 Vue 生态，不比现方案省 | 成立，但**不是缺点**：Element Plus 的 Table/Form/Upload/DatePicker 与 AntD 同档 |
| ③ admin 模板的权限是菜单级，帮不上行级数据范围 | 成立，但打的是**模板**，不是 Nuxt。Nuxt 全栈 ≠ 套别人的 admin 模板 |
| 对 Nest 的偏好："横切约束有唯一落点" | **说过满**。显式 `withScope(event, handler)` 同样可强制、可 grep，agent 读起来比装饰器 + 隐式 DI 更直白 |

### 11.2 真实差异

| 轴 | Nest + React 双 app | Nuxt 全栈 |
|---|---|---|
| 部署单元 | 2 个：dev 代理、CORS、同域 cookie 都要配 | 1 个：同源，session cookie 天然成立 |
| 枚举/DTO 单一事实源 | 跨 package，需 workspace + 构建链 | `shared/` + `#shared` 两侧直接可用（需 Nuxt ≥3.14，列入 spike S1） |
| 定时任务 | `@nestjs/schedule` | Nitro scheduled tasks（进程内 cron）+ advisory lock |
| 横切约束 | Guard / Interceptor 装饰器 | 显式包装函数 + `server/middleware` |
| OpenAPI | `@nestjs/swagger` 从装饰器推 | 需从 Zod 生成（`zod-openapi`） |
| DI 与单测脚手架 | 容器注入，成熟 | 函数式自组织，靠显式传参 |
| 团队心智 | "企业后端"预期，交接顺 | 前后端同在一人名下，小团队快 |
| 前端生态 | React，agent 语料更多 | Vue，Element Plus 的 admin 范式成熟 |

### 11.3 推荐

**若"快速上线 / agent 实现 / 单或小团队"的权重高于"未来大团队交接"，选 Nuxt 全栈。** 我判断本项目落在这个区间，故改判。§2 的表格在路线定目前维持 Nest+React 原样，避免文档自相矛盾。

切换成本诚实列出：

- §3.1 与 §3.3 **均已重写完成**（§3.3 现按 Vue 现实写"纯 shadcn-vue + 自封装"，原先那段"AntD 混用 + 不采用 Nuxt 的三条理由"已删）；Trellis spec 的 backend/frontend 边界从"两个 app"变成"同一 app 的 `server/` 与 `app/`"（§5 拓扑已改）。
- 前端目前零投入，**当时是成本最低的切换时点**，之后只会更高。
- 失去 `@nestjs/swagger` 自动 OpenAPI，T8 的 API 契约改由 Zod 生成。

### 11.4 三个前置 spike（拍路线前必跑，合计约 1 天）

| # | 验什么 | 不通的后果 |
|---|---|---|
| S1 | `shared/` 与 `#shared` 在你的 Nuxt 版本能否被 `server/api` 直接 import | 枚举单一事实源要退回跨 package 手工同步，Nuxt 的主要优势削掉一半 |
| S2 | Nitro scheduled task 内能否拿到与主应用同一套 PG 连接、并在多副本下靠 advisory lock 单飞 | 扫描与 outbox 需要独立进程跑，"一个部署单元"的优势也随之削掉 |
| S3 | ~~Element Plus Table 是否满足受控分页 + 服务端排序 + 多筛选 + 批量选择 + 列配置~~ **已随组件库改判重定义**：改问 **shadcn-vue + Tailwind v4 + `@tanstack/vue-table` 在 Nuxt 4.5 能否装配，以及四件重活（DataTable / 动态数组表单 / 上传 / 日期 locale）能否自封装** | 原结论"不通就退回 AntD React"随之作废（那等于否掉整条 Nuxt 路线）。新退路：缺件继续自封装、砍非必要表格交互、如实补记工时；只有"表格与动态表单根本做不出来"这种级别才重开路线讨论 |

S3 曾是胜负手——这个系统的重心就是那张密集的表格与转案件动态表单。**能力层面已核到**：TanStack Table 官方支持 Vue 适配器，列固定/伸缩/受控分页都在（见 `research-nuxt-table-vue-ui.md` §2.1），所以胜负点从"库够不够强"移到了"**我们的封装成本与装配细节**"，即 §8 第 1 项的 F spike。

---

## 12. 全栈 Nuxt 路线（S1/S2 已核，S3 重定义后待 F spike）

一手核验结果见 `research-nuxt-fullstack-nitro.md`（531 行，版本基线 Nuxt 4.5.2 / nitropack 2.13.4 / h3 1.15.11 / drizzle-orm 0.45.3 / drizzle-kit 0.31.11）与 `research-nuxt-table-vue-ui.md`（前端表格与 shadcn-vue 能力）。**本节取代 §2 的框架行与 §3.1 的结论**；§3.3 已按 Vue 现实重写、§5 拓扑已改单 app；§3.2b、§3.2c、§3.4、§3.5、§3.6、§6、§9 全部继续有效。

### 12.1 核验后的路线判定

Nuxt 全栈成立，不阻塞。7 项主张：VERIFIED 5 项、PARTIALLY 2 项、NOT SUPPORTED 2 项（都不是阻塞项）。**S3 的状态要如实说**：它当时没被核验（原文称"仍然待验"），且当时它问的是 Element Plus；组件库已改判纯 shadcn-vue，所以 S3 现在问的是"装配 + 四件自封装"，能力层面的核验已完成（TanStack Table 官方支持 Vue、含列固定/伸缩与受控分页），**尚缺的是半天 F spike 的实机验证**（见 §8 第 1 项与 `research-nuxt-table-vue-ui.md` §5）。

### 12.2 由核验强制产生的四项设计变更

| # | 发现 | 变更 |
|---|---|---|
| C1 | Nitro 调度器是 **per-process croner**，N 副本 = 触发 N 次（源码级确认）；且 tasks 仍挂在 `nitro.experimental.tasks` 后 | §3.5 的 `pg_try_advisory_lock` 从"保险起见"升级为**功能正确性前提**（outbox 双派 = 双发通知）。所有 task 必须包在 `withSingleFlight()` 内，不允许裸挂 cron |
| C2 | `nitro run-task` 实为 `nitro task run` 且 **dev-only**，`/_nitro/tasks*` 同样只在 dev | 运维补跑路径要自建：鉴权后的 `server/api/tasks/[name].post.ts` → `runTask()`，或 one-off 容器命令。不得假设框架给了生产手动触发口 |
| C3 | `readMultipartFormData` **全量 `Buffer.concat` 进内存**，且 Nitro/h3 层无任何 body size 限制 | **改附件上传方案**：客户端向服务端申请 **MinIO 预签名 PUT** 直传，服务端只登记元数据 + 事后异步校验 hash。这反而比原设计更干净——后端不再中转 50MB 文件流，§7.1 的"签 60s URL"保留，多一条"签 PUT URL" |
| C4 | Nuxt/Nitro **无第一方 session 模块**（`nuxt-session` 停更于 2018）；h3 `useSession` 只做密封 cookie，不管吊销与枚举 | §3.4 的自建 session 表维持不变。文档与 spec 里禁止出现"用 Nuxt 官方 session"这类表述 |

### 12.3 必须写进 `.trellis/spec/` 的八条禁令

1. **`shared/` 只放纯 TS**：不得 import Vue、Nitro runtime、Node API（Nuxt 官方明写两个独立 bundle）；且只有 `shared/utils`、`shared/types` 会被自动导入，子目录需显式配 `imports.dirs` + `nitro.imports.dirs`。
2. **Drizzle partial index 的 `.where()` 只用 `sql` 模板，禁用 `eq()/and()`**——0.45.3 实测会生成非法的 `$1`（open issue #4790）。锁 `drizzle-orm`/`drizzle-kit` 精确版本，升级时复验。
3. **生成列写法**：`generatedAlwaysAs(sql\`…\`)` 或回调形式，**pg 侧没有 `.stored()`**（会抛 TypeError）；PG 只有 STORED，生成列不可进 PK/FK/unique、不可引用其他生成列。
4. **schema 演进只用 `generate` + `migrate`，开发期也不用 `push`**——官方 FAQ 明写 `push` 检测不到已有索引的 `.where()`/表达式变化，而软删 partial unique 正是权限模型骨架，用 push 会出现"代码改了、库没改、CI 还绿"的静默漂移。
5. **所有 API 落 `/api/**`**：Nitro 的错误 payload 形状不是已保证的稳定契约，且 `/api/**` 才确定走 JSON（其余按 `Accept`/`User-Agent` 可能返回 HTML）；权限模型依赖"不可见一律 404"，必须是可编程解析的 JSON。
6. **`ssr:false` 需补 `app/spa-loading-template.html`**，并明确"鉴权跳转只发生在客户端"——SPA 首屏无服务端内容，未登录时不存在服务端重定向。
7. **前端只允许一套组件体系：shadcn-vue + Tailwind。** 禁止为单个控件引入第二套带样式的组件库（Element Plus / AntD Vue / Vuetify 等）；清单里没有的件（**已确认缺：文件上传**）一律自封装进 `components/ui/`。业务组件不得直接 import 原语包（`reka-ui`/`radix-vue`，包名待 F spike 定），必须经 `components/ui/` 那层，换原语时只改一层。
8. **表格一律经 `components/ui/data-table/DataTable.vue` 封装，且强制服务端分页/排序/筛选**（每页上限 100）。理由不是性能而是权限：客户端全量拉取再本地筛等于绕过 `ScopeResolver`（权限草案 §4）。表单库三选一（VeeValidate / TanStack Form / Formisch）**只能钉死一个**，日期同理；校验规则一律由 `shared/` 的 Zod schema 单源产出，组件内不得自带第二套规则。

### 12.4 未证实项（不得当作既有能力写进设计）

- `node:worker_threads` 在 Nuxt+Nitro 文档中**零命中**，只确认 `node-server` preset 是普通 Node 进程。§3.1b 里"逐行解密/大文件 hash 放 worker 线程"因此是**待 spike 项，不是已定方案**。缓解：C3 落地后，50MB 文件的 hash 与解密压力本身已大幅下降。
- Nitro 升到 3（当前 beta）会同时改变包名、`defineTask` 导入路径、h3 1.x→2.x 的 body/session API。届时 `readMultipartFormData`、`createError` 字段、prod error payload、`scheduledTasks` 四项需重新核验。
- **原语库当前包名与版本未定**（radix-vue 还是 reka-ui）：官方文档不同页说法不一，且 `reka-ui.com` 本轮一个 404、一次 fetch failed，`npmjs.com/package/reka-ui` 返回 403 —— 未从官方域名钉死。**F spike 第 1 项**用 `init` 后的 `package.json` 实测。
- **shadcn-vue 的 Data Table 未演示列固定与列宽拖拽**（能力在 TanStack Vue，见研究文档 §2.1/⑨），接不进就第一期放弃这两项交互。
- **中文 locale 未证实**：Calendar / Date Picker 的月份、星期、周起始配置法没取到官方说明；本项目有法律期限计算，必须实测（含 `date` 与 `timestamptz` 边界，修订稿 §12.2）。
- **`ui.shadcn.com` 是否把 Vue 列为一等实现：未证实**。首页未明列、`/docs/frameworks` 404；先前"官方已列 Vue"的说法已撤回。
- **来源卫生**：本轮有若干抓取结果来自签名代理对象（`*.aliyuncs.com`）而非官方站点，本会话早前同类来源里出现过伪造的 System Instruction。**凡只有代理来源支撑的结论一律记为未证实**，详见 `research-nuxt-table-vue-ui.md` §0。

### 12.5 缓存：20 人规模不引入任何缓存组件

判据不是性能，是安全：本系统每次读取都带行级数据范围谓词，**任何跨用户共享的响应缓存都是泄露面**。因此 HTTP 层缓存、反代缓存、查询结果缓存一律不做。需要缓存的三处全用现成机制：配置字典与用户权限集走进程内 `Map`（权限以 `userId:token_version` 为键，版本变更天然失效），列表详情走客户端 `@tanstack/vue-query` 的 `staleTime`（Vue 侧等价物，见 §2「服务端数据」行）。

连接池设 10，**不引入 pgbouncer**——顺带消除了 §3.1b 提到的 transaction-mode pooling 与 advisory lock / `SET LOCAL` 的冲突。

将来触发加缓存的可观测信号：单查询 p95 > 200ms 且 `EXPLAIN` 显示索引已最优；副本 > 2 且出现必须跨进程共享的状态；附件需要 CDN（那时加在对象存储侧，仍不是 Redis）。

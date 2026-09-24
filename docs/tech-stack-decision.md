# MatterNest 第一期技术选型（T1）v2

> 状态：**v2，待你评审**。v1 定 NestJS + Drizzle + React/AntD；v2 按你的三点意见调整——补 NestJS 并发与数据库版本管理的实质论证（§3.1b、§3.2b），前端改为 **AntD 5 与 Tailwind/shadcn 混用**（§3.3），并新增「快速上线切法」（§9）。
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
| 语言 | **TypeScript 全栈** | 枚举与 DTO 在前后端共用一份（枚举表 §5.1 的单一事实源要求），这是唯一能让 28 项枚举不出现两份实现的方案 |
| 运行时 | Node.js 22 LTS（当前机器 24 可跑，CI 锁 22） | 部署基线用 LTS；开发机不必降版本 |
| 后端框架 | **NestJS 10 + Fastify 适配器** | 见 §3.1 |
| ORM / 查询 | **Drizzle ORM** + `postgres`(pg) 驱动 | 见 §3.2 |
| 迁移 | **drizzle-kit 生成 + 手写 SQL 补丁段**，SQL 文件进版本库 | 见 §3.2 |
| 校验/契约 | **Zod**，schema 定义在 `packages/domain` | 一处定义 → DTO 校验、前端表单规则、OpenAPI 三方复用 |
| 前端 | **React 18 + Vite** + **Ant Design 5 与 Tailwind/shadcn 混用** + React Router 6 | 见 §3.3 |
| 服务端数据 | **TanStack Query 5** | 列表分页/筛选/详情缓存是本项目的主战场，手写缓存必然出错 |
| 认证 | 服务端 **session 表 + httpOnly cookie**，第一期本地账号 | 见 §3.4 |
| 对象存储 | **MinIO**（S3 兼容）自建 | 法律文件不出内网；后端签 60s URL，不直暴 MinIO |
| 定时任务 | `@nestjs/schedule` + **PG `pg_try_advisory_lock`** 单飞 | 见 §3.5 |
| ID | 应用层雪花，`packages/domain/ids` | 与设计的 `bigint` 主键一致 |
| 测试 | Vitest + supertest + Playwright；权限矩阵用 `test.each` 参数化生成 | 权限草案 §10 的 216 例不能手写 |
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

### 3.3 前端：AntD 与 Tailwind/shadcn 混用

你这个意见戳到一个真实矛盾：**shadcn/Tailwind 对 agent 友好，但它在数据密集的后台管理页恰好是短板**。两者拿不了满分，所以按控件分类切，而不是整体选一边。

先认 shadcn 的优势，它们成立：源码复制进仓库、没有黑盒 API，agent 能读能改；Tailwind 是 LLM 生成最熟练的样式语言；不受组件库版本天花板约束；Radix 原语把键盘导航、焦点管理、aria 这些自研必定做错的部分兜住了。

代价也真实。本系统是"筛选列表 + 详情多 Tab + 密集表单 + 上传 + 日期/级联"，纯 shadcn 下这几块要自己接线：

| 控件 | AntD 现成 | 纯 shadcn 要自己做 |
|---|---|---|
| 可配列 + 服务端分页/排序/多筛 + 批量选择的表格 | `Table` 全包 | TanStack Table 全手接（本项目最重的一块） |
| 转案件表单：N 个案件卡片、卡片间"复制上一个"、每卡 10+ 字段联动校验 | `Form.List` | RHF + 手写数组字段管理 |
| 上传：进度、类型白名单、50MB 上限、多文件 | `Upload` | 手写 |
| 日期/范围 + 中文 locale + 法律期限"剩 N 天" | `DatePicker` + dayjs | 手写（日期边界最容易埋 bug） |

**决定：AntD 5 与 Tailwind 混用。**

```text
用 AntD 的四件   Table · Form(含 Form.List) · Upload · DatePicker/Cascader
                 —— 这四件占后台工期约 60%，且 agent 对它们的 API 也很熟
其余全部 Tailwind + shadcn  布局 · 卡片 · 详情信息区 · 状态徽标
                            · 空态/加载态 · 一切差异化视觉
```

混用有一处冲突必须处理：Tailwind 的 preflight 会重置元素样式并盖掉 AntD。约定 **`corePlugins: { preflight: false }`**，AntD 间距一律走 `ConfigProvider` 主题令牌，不与 Tailwind 间距体系混写；同一段代码只用一套间距单位。这条要原样进 T2 的 frontend guideline，否则 agent 会在同一页面里混着写。

**不采用 Nuxt / Nuxt admin 模板，三条具体理由**：

1. 后端已是 NestJS，再上 Nuxt 就多一个 SSR 运行时和一套鉴权转发链路；内部系统无 SEO 需求，这是纯成本。
2. 换 Nuxt 实质是换到 Vue 生态（Element Plus 等）。它同样能给出 batteries-included 的后台件，所以"Nuxt dashboard"并不比 React + AntD 更省，只是把栈整体换了一遍。
3. admin 模板提供的"权限"是**菜单/路由可见性**，本项目的难点是**行级数据范围**（三档 + ScopeResolver + 不可见返 404 而非 403，权限草案 §4）。模板在最难这件事上帮不上，却会带来一坨要拆掉的内建 auth store 和它自己的 401/403 约定——拆的时间通常多于省下的。

若你更看重"一套体系、agent 全量生成、视觉不被组件库定型"，纯 shadcn + TanStack Table + RHF 也是正当选择，代价我量化出来：前端比混用方案多约 **1–1.5 周**，主要在表格与转案件表单。这是 §7 假设 D，评审时一并拍。

### 3.4 session 表而不是 JWT

权限草案 §8 要求"角色/权限变更下一次请求即生效"，靠 `app_user.token_version` 做失效判定。用 JWT 的话这个校验只能在签名有效期内被动等待；session 存 PG 则可以**主动删行**，语义更直白，也不引入 Redis 依赖（内部系统并发量用不着）。

`token_version` 列保留，用途收窄为：session 内缓存的权限集以它为键，版本不一致即重解析——与设计原文一致，不改设计。

第一期不接 IdP。预留 `auth_provider` 判别列即可，不做插件化。

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
| 枚举单一事实源（枚举表 §5.1） | `packages/domain/enums/*` + 迁移期由值数组生成 `CHECK` |
| ScopeResolver + 禁止裸表访问 | `packages/db` 仓储基类断言 + Nest Guard；CI 检查无裸 `select()` |
| 404 而非 403 | 全局 exception filter 统一映射 |
| `activity_log` 自动落审计 | Interceptor + 显式 `reason` 参数（偏离路径必填那类走服务层校验） |
| 特权开关 | `@RequirePrivilege()` 装饰器，读 `role` 四布尔 |
| outbox 至少一次 + 去重 | 投递器循环 + `notification_event.dedupe_key` 唯一键冲突即跳过 |
| `scope_key` 归一化 8 条向量（枚举表 §4.4） | `packages/domain/automation/scope-key.spec.ts`，逐向量断言 |
| 字段加密 + HMAC 索引列 | `packages/domain/crypto`，密钥从 env 注入，不入库 |
| 期限计算（`date` vs `timestamptz`） | `packages/domain/time`，禁止业务层裸用 `Date` |

---

## 5. 仓库拓扑

```text
MatterNest/
├─ apps/
│  ├─ server/            NestJS：路由、Guard、Interceptor、定时任务
│  └─ web/               React + Vite + AntD
├─ packages/
│  ├─ domain/            枚举、Zod schema、雪花 id、时间/加密工具（无 IO）
│  ├─ db/                Drizzle schema、迁移 SQL、仓储
│  └─ config/            tsconfig / eslint / prettier 共享预设
├─ deploy/               compose、minio 桶策略、备份脚本
├─ docs/                 4 份设计文档 + 本文件
└─ .trellis/             工程配置（spec 待 T2 填充）
```

依赖方向单向：`apps/* → packages/{db,domain}`，`packages/db → packages/domain`，`domain` 不依赖任何一层。违反这个方向是 review 阶段的一票否决项。

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

三个部署期必须落地的安全项，都来自设计文档而非通用建议：
- 密钥（AES-GCM 主密钥、HMAC 密钥）从 env/secret 注入，**两把密钥分离**，`key_version` 列先留（修订稿 §6.3）。
- 当事人身份证明文导出与 `SENSITIVE_FIELD_READ` 日志必须同链路，导出走脱敏 DTO 而非前端遮罩。
- `activity_log` 留存期与备份策略要按所内合规要求定，属 G 组未决（§10）。

---

## 7. 需要你确认的四处假设

前三条是我推的，第四条是本轮你给的新方向下我做的折中，推错了代价大：

| # | 假设 | 依据 | 若不成立 |
|---|---|---|---|
| A | **团队是 TS/Node 背景** | 你在 SY-YunAgent 是 npm scope 的 monorepo，本机 Node 24 | 换 **Spring Boot 3 + MyBatis 或 JPA + Flyway(SQL-first) + 同一套前端**。四份设计文档全部不受影响，只有 §3.1/§3.2/§3.1b 与仓库拓扑要重做 |
| B | **单所内部使用、无跨所隔离** | 本轮已定"不引入组织维度" | 若将来多分所，权限模型重写（转案件 §5、权限草案 §9 已记录该代价） |
| C | **第一期不接 SSO/IdP** | 律所内网、无外部身份源描述 | 需要的话 §3.4 改为 OIDC code flow + session 表保留，工作量 +2~3 天 |
| D | **前端取"AntD + Tailwind 混用"而非纯 shadcn** | 你的两个诉求（agent 友好 / 快速上线）在纯 shadcn 下互相冲突，混用同时拿八成 | 选纯 shadcn：视觉与代码风格完全由 agent 掌控、无组件库天花板，代价是前端 +1~1.5 周，且表格与转案件表单要手写（§3.3 表） |

另有一条口径冲突要定：`.trellis/spec/` 模板结尾写着 "All documentation should be written in **English**"，而现有 5 份设计文档是中文。T2 填 spec 前先定：**约定文档英文、设计文档中文**，还是统一到一种。

---

## 8. 下一步

T1 定稿后依次：
1. **S0（0.5 天，最先做）** §3.2b 的 Drizzle spike。它决定 `packages/db` 的形态，做晚了返工面大。
2. **T2** 填 `.trellis/spec/` 12 个模板（内容取自本文 §4 对应表 + 枚举表 §5），并填 `.trellis/config.yaml` 的 packages 段。
3. **T7** 生成迁移与 seed（schema + SQL 补丁 + 幂等 INSERT）。
4. **T3** 删除语义，然后才轮到 T5 原型与 T8 API 契约。

---

## 9. 快速上线切法（你要求的"快"，代价在这几刀）

按"上线后律所同事能不能开始用它管案件"来切，而不是按模块完整度切。

| 波次 | 内容 | 为什么这么切 |
|---|---|---|
| **P0 上线必带** | 风险事项、案件、节点、进展、评论、附件；三档数据范围 + 审计；`FX/AJ` 编号生成；转案件（含 outbox + `risk_converted`）；归档与偏离确认 | 缺任何一项，主流程就不闭合：能建案但转不了，或转了但没人看得到 |
| **P1 可推后 2 周** | **自动化规则的配置页与通用引擎**。P0 阶段把「节点到期提醒」「结案通知关注人」两条按内置定时任务硬编码实现，规则表结构与 seed 照常建好 | 规则引擎是全套设计里最贵的子系统（5 触发 × 5 动作 × scope_key 唯一性 × 冲突检测 × 聚合去重），而第一期真正要跑的行为只有 2–3 条。表结构先建、UI 与引擎后补是**只加不改**，不会返工 |
| **P1 同批** | 自定义提醒 `custom_reminder`（重复规则、多渠道）、关注 feed 的未读计数、导出 | 有替代路径（未读=肉眼看列表；导出=手工汇总），不阻塞主流程 |
| **建议移出第一期** | 邮件渠道、批量导入、全局搜索 | 每一项都要额外基础设施（SMTP 送达与退信、导入模板与冲突处理、检索方案），收益却是个别的 |

规则 7（转案件→归档）**不能推到 P1**：它依赖的 outbox 与 `conversion_status` 已在 P0，且它是"事项转完还挂在进行中"这个体验问题的唯一解。

这条切法带来的额外好处是 P0 可以直接用 T1 的技术栈跑通端到端，不必等规则引擎与通知模板全部对齐——这也是我把它写进决策文档而不是排期文档的原因。

---

## 10. 请你评审的具体条目

不要通读，逐条拍就行：

1. **§7 A**：是不是 TS/Node 团队。（否 → 后端整块换，其余不动）
2. **§7 D**：前端混用 vs 纯 shadcn。（我推荐混用，纯 shadcn 多 1–1.5 周）
3. **§3.2b 规定 1**：共享环境禁用 `drizzle-kit push`，只走编号 SQL 迁移。有没有现存流程冲突。
4. **§3.1b 表格**：三类 CPU 阻塞活（逐行解密、大文件 hash、导出）是否接受"worker 线程 + 异步导出"这个处理强度，还是第一期就把导出砍到 P1（我在 §9 已放到 P1）。
5. **§9 切法**：把自动化规则配置页推到 P1、只硬编码 2 条内置提醒，能不能接受。这是本期最大的省时间来源。
6. **§3.1b 连接池那条**：如果部署要上 transaction-mode pgbouncer，advisory lock 与 `SET LOCAL` 都得改走 session-mode 直连，需要你确认部署形态。

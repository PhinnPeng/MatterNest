# MatterNest 第一期技术选型（T1）

> 状态：**推荐定稿，含 3 处需你确认的团队假设（§7）**。
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
| 前端 | **React 18 + Vite + Ant Design 5** + React Router 6 | 见 §3.3 |
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

### 3.3 Ant Design 而不是 shadcn/Tailwind 自研

系统的页面构成是：多条件筛选列表 + 详情多 Tab + 表单密集 + 文件上传 + 日期选择 + 树/级联选择（案由、当事人）。AntD 的 `Table`（受控分页/排序/行选择）、`Upload`、`DatePicker`、`Form`（含校验联动）直接对上四份文档里的 4.1–4.4 原型。自研这套的工期会全部花在键盘导航、无障碍、中文 locale、日期选择器边界上，而这些都是律所用户的日常高频操作。

设计文档里几处具体依赖：转案件表单的"N 个案件卡片 + 复制上一个案件字段"（转案件 §3）需要动态表单数组，AntD `Form.List` 原生支持；当事人编辑时"被 N 个案件引用"的确认弹窗是标准 `Modal.confirm`。

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

## 7. 需要确认的三处团队假设

这三条是我推的，推错了代价大，请逐条否决或确认：

| # | 假设 | 依据 | 若不成立 |
|---|---|---|---|
| A | **团队是 TS/Node 背景** | 你在 SY-YunAgent 是 npm scope 的 monorepo，本机 Node 24 | 换 **Spring Boot 3 + MyBatis-Flyway(SQL-first) + 同一套前端**。四份设计文档全部不受影响，只有 §3.1/§3.2 与仓库拓扑要重做 |
| B | **单所内部使用、无跨所隔离** | 本轮已定"不引入组织维度" | 若将来多分所，权限模型重写（转案件 §5、权限草案 §9 已记录该代价） |
| C | **第一期不接 SSO/IdP** | 律所内网、无外部身份源描述 | 需要的话 §3.4 改为 OIDC code flow + session 表保留，工作量 +2~3 天 |

另有一条需要你定的口径冲突：`.trellis/spec/` 模板结尾写着 "All documentation should be written in **English**"，而现有 5 份设计文档是中文。T2 填 spec 前得先定：**约定文档写英文、设计文档保持中文**，还是统一到一种。

---

## 8. 下一步

T1 定稿后依次：
1. **T2** 填 `.trellis/spec/` 12 个模板（内容直接取自本文 §4 对应表 + 枚举表 §5），并填 `.trellis/config.yaml` 的 packages 段。
2. **T7** 生成迁移与 seed（Drizzle schema + SQL 补丁 + INSERT，可直接跑）。
3. **T3** 删除语义，然后才轮到 T5 原型与 T8 API 契约。

# Database Guidelines

> ORM、迁移、schema 演进、软删与索引、枚举 CHECK、编号与加密。
> 来源：`docs/tech-stack-decision.md` §13.5 禁令②③④、§3.2/§3.2b/§3.2c、§12.2 继承行；`docs/PRD-phase1-enums-and-schemas.md` §5；`docs/PRD-phase1-design-revision-r1.md` §12；`docs/PRD-phase1-permission-design-draft.md` §5（`*_staff` 是权限主表）；索引清单在 `docs/PRD-phase1-design-revision-r1.md` §8.2。

---

## Stack

`drizzle-orm` + `postgres`(postgres.js) 驱动 + PostgreSQL **15+**；`drizzle-kit` 产迁移 SQL。**版本锁精确值**（禁令②要求升级时复验）。不引入 Redis、不引入 pgbouncer、不引入任何缓存组件（技术选型 §12.5、§3.6）。

---

## 开发库现状与 `pnpm db:check`（2026-09-27 实测）

一期开发库**已经开通并验证**，写 W0-4/W0-5 之前先跑一次 `pnpm db:check`，不要靠"参数照抄同级项目"的假设。

- **实例**：共享 dev 机 PostgreSQL **16.13**（Alpine/linux-musl）。经 GameViewer 端口映射暴露，**本机连 `127.0.0.1:30432`**——映射只监听回环，连 `172.16.70.100:30432` 必然超时（这条曾让我误报"共享机不可达"）。
- **角色与库**：`dev_matternest`（role 兼 DB owner，`LOGIN CREATEDB`，**非超级用户**）。role 级默认 `timezone='UTC'` + `client_encoding='UTF8'`，所以"会话固定 UTC"是**库侧强制**，不依赖每个 handler 记得 `SET`。
- **凭据位置**：`.env`（已 gitignore，禁提交）；模板 `.env.example`。脚本全程不打印密码，且**拒绝连非 `dev_*` 库**（C8 会跑 DDL 探针）。
- **断言（12 项）**：C1 连通 / C2 版本 ≥15 / C3 库名+角色名符合预期且 `rolsuper=false` / C4 `SHOW timezone=UTC` / C5 UTF8 / C6 跨零点时刻 `::date` 与 `AT TIME ZONE 'Asia/Shanghai'` 结果不同（即"禁 `current_date`/`now()::date` 当 `day_key`"的实机证据）/ C7 bigint 服务端往返 + C7b 驱动的 int8 解析类型 / C8 事务内 temp DDL 可回滚 / C9 第一条迁移已应用 / C10 三个条件唯一索引 + 表级 CHECK + 生成列**真撞过一次**（跑在回滚事务里）/ C11 seed 八状态齐（每宿主 `init=1,arch=1`）。
- **C10 的写法坑（踩过）**：PG 里事务内任一语句报错后整个事务进入 aborted 态，后续语句全废 —— 所以每个"预期失败"必须单独包 `tx.savepoint(...)`；且**探针要自己清空探测域**（`delete … where host_type='matter'` 后再插两条初始态），否则空库时测不出冲突、seed 过后又误报冲突，测的其实是数据而不是约束。
- **不进 `pnpm verify`**：verify 必须离线全绿，`db:check` 是显式命令。
- **已实测的驱动事实**：postgres.js 把 `int8` 解析成 **JS `string`**（不是 `BigInt`、不是丢精度的 `number`）。P1-19「bigint id 在 DTO 里出 string」因此天然满足一半，但**写侧仍要显式传 string/`::text`**，且别让 `useNumberId` 之类的隐式转换进代码。

**未验项**：C4/C6 的反向路径（把 role 时区改回 `PRC` 应当变红）需要超级用户执行 `ALTER ROLE`，本次未实机触发——依据只有 provisioning 前同一角色读到 `timezone = PRC` 的实测记录。其余失败路径已实跑变红：C1（错密码 / 端口不通）、C3、C9/C10/C11（把库 drop 到空再跑一次，见下节"端到端验过的一轮"）、非 `dev_*` 库直接拒。


---

## 迁移：SQL 文件是唯一事实

1. **只用 `generate` + `migrate`。开发期也禁止 `drizzle-kit push`。**
   禁令④（§13.5，逐字）：`push` 检测不到已有索引 `.where()`/表达式变化，而软删 partial unique 是权限模型骨架，用 push 会出现"代码改了、库没改、CI 还绿"的静默漂移。共享环境同样禁（§3.2b 规定 1）。
2. 迁移产物**必须人审**：编号 SQL 文件按顺序入库；`migrator` 作为一次性服务跑，配 `pg_advisory_lock`（技术选型 §3.2c、落地方案 W0-4）。
   已落地形态：`pnpm db:generate` → `MN_DB_CONFIRM=<库名> pnpm db:migrate`（`tools/migrate.mjs`）。它先 `pg_advisory_lock(hashtext('matternest:migrator'))`（实测 key=-558534946），再走 drizzle 的 `migrate()`（整体包在一个事务里，C8 已证这台库支持事务内 DDL 回滚）；ledger 落在 **`drizzle.__drizzle_migrations`**（drizzle 默认自建 `drizzle` schema，不在 public）。
   **`MN_DB_CONFIRM` 是硬闸门不是仪式**：共享实例上同时挂着别的项目的库（实测 `dev_sy_identity` 与 `dev_matternest` 同端口），不给或给错都直接拒跑（两条红路径已实跑）。
3. 每张**同构表对**（`matter_*` / `risk_matter_*`）放**同一个迁移文件**，配一条"两表列集合 diff 为空"的契约测试（修订稿 §12.2 末行、§11 遗留风险 2）。
4. 手动 SQL 补丁写在 `generate` 产物的**尾部同一文件**，不要另起未编号文件——否则迁移不再是稳定产物（枚举表 §5.1 注）。
5. 修订稿 §12.2 末行"迁移工具建议 pt/Flyway"是**技术选型定稿前的旧建议**，本仓不采：迁移工具固定 `drizzle-kit generate` + `migrate`（技术选型 §3.2/§3.2b）。那条"框架与迁移工具解耦"的论证仍成立，但落点已定。
6. seed 清单以修订稿 §2.3 为准：**5 配置表 + 8 状态 + 8 条预置规则 + 7 通知模板 + 5 角色（含 4 个特权开关）**，全部 `ON CONFLICT (code) DO NOTHING` 幂等可重放。技术选型 §3.2b 第 3 条里那句"5 规则"是旧值，已就地标注过期。规则引用 `code`/`template_code` 而**不是雪花 id**，这样 seed 才能跨环境重放（修订稿 §2.4 末行）。
   > **`ON CONFLICT (code)` 这句按表不成立（2026-09-27 实测）**：`status_config` 的唯一索引是 `ux_status_code (host_type, code)`——`matter` 与 `risk_matter` 各有一套同名 code（§3.2 八行 = 4 语义 × 2 宿主），单列 `code` 上不存在唯一索引，写 `ON CONFLICT (code)` 会被 PG 直接拒。落地写法见 `db/seed/0000_status_config.sql`：**按该表的实际唯一键写冲突目标**。另两条实测口径：生成列不能出现在插入列清单里；seed 用预留低号段（1–8）而不是雪花值，因为它要跨环境逐字重放。
7. **seed 每次全量重放、不记账本**（`pnpm db:seed`）。记账本会让"改了 seed 没生效"变成静默失败；重放则当场报错。前提是每条 seed 都真的幂等。
8. **没有 down：一期口径 = 前滚 + 备份恢复。** `drizzle-kit` 0.31.10 的命令清单只有 `generate / migrate / introspect / push / studio / up / check / drop / export`，**没有 down/rollback**（`drop` 是删未应用的迁移文件，不是回滚库）。所以 §3.2b 那句"编号迁移文件…能回滚"只能这样兑现：
   - 迁移文件头部必须写 `-- DOWN: <手写反向 SQL>` 或 `-- IRREVERSIBLE: <原因>`（人审与事故恢复时看得懂丢了什么）；
   - 真要退回去靠 `pg_dump` 恢复（W0-5 部署期补备份脚本），**不承诺库内自动回滚**；
   - `db:check` 的 C8 保证的是另一件事：单个迁移批次在事务里失败会自动整体回滚，不留半改状态。

---

## Drizzle 写法的三条硬约束（+ 2026-09-27 spike 实测的四条 API 事实）

**禁令②**（§13.5，逐字）：Drizzle partial index 的 `.where()` **只用 `sql` 模板，禁用 `eq()`/`and()`**——`drizzle-orm@0.45.3` 实测会生成非法的 `$1`（open issue #4790）。锁 `drizzle-orm`/`drizzle-kit` 精确版本，升级时复验。

> 本轮**现场复现**了这条（不只是引用 issue）：`.where(and(eq(t.isEnabled, true)))` 产出的 DDL 是
> `CREATE UNIQUE INDEX … WHERE "automation_rule_bad"."is_enabled" = $1`，PG 报 **`there is no parameter $1`**，
> 整条语句被拒。⇒ 同一道理适用于**任何 DDL 位置**：CHECK、索引 WHERE、DEFAULT 都不能带参数占位符，
> 从 TS 常量数组拼值进 DDL 必须用 `sql.raw()`（并校验取值只含 `[a-z0-9_]`），见 `db/schema/status-config.ts` 的 `sqlInList`。

**禁令③**（§13.5，逐字）：生成列写法 `generatedAlwaysAs(sql\`…\`)` 或回调形式，**pg 侧没有 `.stored()`**；PG 只有 STORED，生成列不可进 PK/FK/unique、不可引用其他生成列。

实测补充（0.45.3 / drizzle-kit 0.31.10）：

1. `check()` 只有 **`check(name, sql\`…\`)` 两参形式**；`check(name).sql\`…\`` 会直接 `TypeError: check(...).sql is not a function`。
2. 表级 FK 只有 **`foreignKey({ name, columns, foreignColumns })` config 形式**，`.columns().references()` 链式已移除；被引用表必须在同一模块里**先定义**（无 lazy），两张互引的表要拆出先后。
3. FK 产出的 SQL 把目标表**写死成 `"public"."xxx"`**。所以一期**所有业务表必须落在 `public`**；将来要迁 schema 时，FK 段必须人审改手写补丁。
4. **未知选项会被静默丢弃**：`timestamp("t", { withTimeZone: true })`（大小写错一位）产出的是**无时区的 `timestamp`**，不报错、不告警。§12.2 要求一律 `timestamptz`，所以每条迁移人审时要 grep 产出的列类型（`db:check` 目前不覆盖这一项）。

另两条被 spike 支撑的结论：partial index 的 `.where()` 表达式**变化**能被 `generate` 看见（会产出 `DROP INDEX` + `CREATE INDEX` 的增量迁移），所以"迁移文件是唯一事实"这条站得住；生成列、三个条件唯一索引、表级 CHECK、`text[]`/`integer[]` 默认值、`jsonb` 默认 `{}` 全部由 DSL 正确产出 —— **技术选型 §3.2b 末尾那条"若产出明显残缺就退 SQL-first"的退路不需要启用**。

```ts
// 目标形态：partial unique（一期规则唯一性的骨架）
index("uk_rule_scope").unique()
  .where(sql`${automationRule.isEnabled} AND ${automationRule.isDeleted} = false`)  // ✅ sql 模板
  // .where(and(eq(automationRule.isEnabled, true)))                                 // ❌ 禁令②：产出 $1，DDL 直接被 PG 拒
```

---

## 枚举与 CHECK：单一事实源

- 取值**权威源**是 `docs/PRD-phase1-enums-and-schemas.md`（E01–E37，其中 34 项为真实取值）。落地在 `src/shared/enums/`（枚举表 §5.1 的目录按现行拓扑读作此路径），每个文件同时导出 **TS 联合类型 + 值数组 + 中文名字典**。
- **CHECK 手写进迁移 SQL**，不做 codegen 管线（枚举表 §5.1 已把原"由值数组生成"改判为"手写 + 一条一致性测试"）。
- **必配测试**：读值数组与迁移文件里的 `CHECK` 取值做集合比较，不一致即 CI 失败（M0 退出条件之一，落地方案 §2）。
  已落地：`src/app/lib/server/db/schema/status-config.spec.ts` —— 它**读迁移 SQL 而不是读 TS**（迁移才是唯一事实；有人直接在迁移尾部改 CHECK，测试会立刻红），并顺带断言三个 partial unique 的 `WHERE` 还在、生成列没被塞进任何索引。反向验证做过：往 `STATUS_SEMANTICS` 里加一个 `'converted'` → 该测试红，撤掉即绿。
- 类型用 `varchar + CHECK`，**不用 PG `enum` 类型**（修订稿 §8.3/§12.2：加值要 `ALTER TYPE` 且受事务/逻辑复制限制）。
- 加值 / 废值规则（枚举表 §5.3）：新增值＝改常量 + 迁移 `DROP`/`ADD CONSTRAINT`（全表扫，一期数据量可接受）；**禁止从 CHECK 里删值**（历史行会违反约束），废弃值常量保留标 `@deprecated`；需要运营自助加值＝判断错了，按枚举表 §6 升格为配置表，**不要**放宽成无约束 `varchar`。
- 三条 CHECK 模板见枚举表 §5.2，其中节点时间的 `ck_node_time_shape`（range 必须有起止、point 禁填 `end_time`、双 NULL＝待定时间）必须逐条落地。

---

## 软删与 FK：删除语义

修订稿 §12.4 已定 **DB 层**调（可直接实现）：

| 表类 | 删除方式 | FK 动作 |
|---|---|---|
| 业务表 `matter` / `risk_matter` / `party` | 只软删 `is_deleted` | DB 层一律 `ON DELETE RESTRICT`，级联由服务层显式执行并写 `activity_log` |
| 从属明细 `*_staff` / `*_tag` / `*_party` | 随宿主硬删 | `ON DELETE CASCADE`（无独立审计价值） |
| `node` / `progress` / `expense` / `attachment` | 软删（有业务与审计含义） | 节点：§12.4 明写 `RESTRICT`。**progress / expense / attachment 三张的 FK 动作规格件未写**，按同族（同为有审计含义的软删表）推 `RESTRICT` —— **推断，待 B8 一并签字** |

**仍开放＝门禁 G2（B8）**：用户可见的删除入口、软删记录能否恢复、被引用父行删除时子表怎么处理（修订稿 §10 :593）。这三问未拍前**不要写删除类接口与恢复语义**，也不要把上面表格的任何一行当"已签字"扩散到测试里。

**禁止 ORM 软删除插件**（技术选型 §3.6）：语义要显式控制，不能让插件偷偷改写查询。

---

## 索引

- 列表查询恒带"未删 + 未归档"过滤 → 用 **partial index**（`WHERE NOT is_deleted …`），这是修订稿 §12.1 列的四条 PG 依赖之一（另三条：规则 partial unique、数组列 GIN、`ON CONFLICT` 单语句取号）。
- 索引清单以修订稿 §8.2 为准；`ix_staff_user`（`*_staff` 上的用户维索引）是**权限必需**，不是性能优化（权限草案 §5、落地方案 W1-5）。
- 数组列（`next_status_codes`、`remind_days`、`notify_channel[]`）用 `text[]`/`integer[]` + GIN（§12.1）。
- 规则唯一性用 partial unique index `WHERE is_enabled`（§2.1），`scope_key` 归一化的 8 条必过向量见枚举表 §4.4，落成 `src/shared/automation/scope-key.spec.ts`。

---

## ID、时间与编号

- id：`bigint`，**雪花由应用侧生成**，DB 不设 `IDENTITY`（避免双序列冲突，修订稿 §12.2）。
- 时间：一律 `timestamptz`(UTC)；`date` 只用于"当事人可见的日历日期"（`discover_date`/`filing_date`/`progress_date`）。**日历日期用 `timestamptz` 会跨时区漂一天，法律期限直接算错**（§12.2，本节自己标了"最容易被忽略"）。期限计算一律走 `src/shared/time`，业务层禁止裸用 `Date`（技术选型 §4「期限计算」行）。
- 编号 `FX/AJ/AL-YYYYMMDD-XXX`：`code_seq(day_key, prefix)` + `INSERT … ON CONFLICT … DO UPDATE … RETURNING` 单语句原子取号。**日界用业务时区 `Asia/Shanghai`**（已定稿 2026-09-26），SQL 口径即 `date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')::date`。
- **会话固定 UTC（连接池参数 + 启动断言）**：`SET TIME ZONE 'UTC'`。**注意理由与规格件原文不同**——2026-09-27 在共享 dev 机（PG 16.13，服务端默认 `timezone = PRC`）实测：上面那条 `AT TIME ZONE 'Asia/Shanghai'` 的日界**与会话时区无关**（PRC/UTC 两跑同为 09-27），真正会漂的是**隐式转换**：同一跨零点时刻 `::date` 在 PRC 会话给 09-27、UTC 会话给 **09-26**，`current_date` 同理。钉 UTC 的目的是让隐式转换与文本往返确定，不是“防编号偏 8 小时”（修订稿 §12.3 已同步更正）。
- 序号溢出 999 → **扩为 4 位**（`AJ-20261015-1000`），不报错；号可跳不可复（§12.3）。
- 金额 `numeric(18,2)`，禁 `float`。

---

## 加密与敏感字段

- 敏感字段：AES-GCM 密文列 + **HMAC 索引列**（用于查重与等值检索），落在 `src/shared/crypto`。
- **两把密钥分离**（AES 主密钥 / HMAC 密钥），从 env 或 secret 注入，**不入库、不进镜像**；`key_version` 列先留（技术选型 §4「字段加密 + HMAC 索引列」行、§6 第 1 条）。
- 明文导出与 `SENSITIVE_FIELD_READ` 审计**必须同链路**，导出走脱敏 DTO 而不是前端遮罩（技术选型 §6 第 3 条、权限草案 §7.3）。
- 密钥托管与轮换方案属 **B7 未决**（修订稿 §10），不得自行编一套。

---

## 并发与定时任务

- 需要单飞的四件：节点提醒扫描、规则 4 的 30 天无更新扫描、outbox 投递、云之家在职同步。全部包 `withSingleFlight()`，内部一条 SQL：
  ```sql
  SELECT pg_try_advisory_lock(hashtext('matternest:reminder-scan'))
  ```
  拿不到锁直接返回。**这不是"保险起见"，是多副本下的功能正确性前提**（outbox 双派＝双发通知，技术选型 C1 经 §13.2 继承）。
- outbox：至少一次投递 + `notification_event.dedupe_key` 唯一键冲突即跳过（技术选型 §4「outbox 至少一次 + 去重」行、修订稿 §7.2、矩阵 §4.1）。
- 连接池设 **10**，不引入 pgbouncer（§12.5）——顺带消除 transaction-mode pooling 与 advisory lock / `SET LOCAL` 的冲突。

---

## 认证相关表（不改 `app_user` 的认证语义，凭据一律外挂）

| 表 | 关键列 | 依据 |
|---|---|---|
| `app_user_external_identity` | UK(provider, external_id)、user_id FK、synced_at、sync_status | 技术选型 §3.4；`eid`/`openId` 存这里，**禁止**进 `app_user` 或前端可读 DTO（§4 末行） |
| `app_user_credential` | user_id UK、password_hash、updated_at、failed_attempts、locked_until | **1:0..1**：无此行＝该账号不能用密码登录（§3.4） |
| `auth_session` | token_hash、user_id、auth_via(`local`/`yunzhijia`)、expires_at、revoked_at | `auth_via` 供审计与差异化失效（§3.4） |

**没有第一方 session 可用**：Next/Nuxt 都不给，禁止在任何文档或代码里写"用官方 session"（C4，经 §13.2 继承）。`sync_status` 的 `unknown` 是**故障安全位**——同步失败不得推断为离职（枚举表 §7 末行）。

---

## 常见错误（派单时逐条对照）

1. 用 `drizzle-kit push` 建开发库 → 禁令④。
2. `.where(eq(...))` 写 partial index → 禁令②，生成非法 SQL。
3. 把枚举值抄进第二个文件（前端另写一份、测试里再硬编码一份）→ 破坏 §5.1 单一事实源。
4. 从 CHECK 里删掉废弃取值 → 历史行违反约束。
5. 用 `timestamptz` 存日历日期，或业务层 `new Date()` 算期限 → 期限算错。
6. 用 `current_date` 或 `now()::date` 当 `day_key` → 会话钉 UTC 后，上海 0–8 点的立案会被归到**前一天**（实测：同一时刻 PRC 会话 09-27 / UTC 会话 09-26）。`day_key` 只能是显式 `AT TIME ZONE 'Asia/Shanghai'` 形式。
7. 给业务表配 `ON DELETE CASCADE` → 抹掉审计链（§12.4）。

# Database Guidelines

> ORM、迁移、schema 演进、软删与索引、枚举 CHECK、编号与加密。
> 来源：`docs/tech-stack-decision.md` §13.5 禁令②③④、§3.2/§3.2b/§3.2c、§12.2 继承行；`docs/PRD-phase1-enums-and-schemas.md` §5；`docs/PRD-phase1-design-revision-r1.md` §12；`docs/PRD-phase1-permission-design-draft.md` §5（`*_staff` 是权限主表）；索引清单在 `docs/PRD-phase1-design-revision-r1.md` §8.2。

---

## Stack

`drizzle-orm` + `postgres`(postgres.js) 驱动 + PostgreSQL **15+**；`drizzle-kit` 产迁移 SQL。**版本锁精确值**（禁令②要求升级时复验）。不引入 Redis、不引入 pgbouncer、不引入任何缓存组件（技术选型 §12.5、§3.6）。

---

## 迁移：SQL 文件是唯一事实

1. **只用 `generate` + `migrate`。开发期也禁止 `drizzle-kit push`。**
   禁令④（§13.5，逐字）：`push` 检测不到已有索引 `.where()`/表达式变化，而软删 partial unique 是权限模型骨架，用 push 会出现"代码改了、库没改、CI 还绿"的静默漂移。共享环境同样禁（§3.2b 规定 1）。
2. 迁移产物**必须人审**：编号 SQL 文件按顺序入库；`migrator` 作为一次性服务跑，配 `pg_advisory_lock`（技术选型 §3.2c、落地方案 W0-4）。
3. 每张**同构表对**（`matter_*` / `risk_matter_*`）放**同一个迁移文件**，配一条"两表列集合 diff 为空"的契约测试（修订稿 §12.2 末行、§11 遗留风险 2）。
4. 手动 SQL 补丁写在 `generate` 产物的**尾部同一文件**，不要另起未编号文件——否则迁移不再是稳定产物（枚举表 §5.1 注）。
5. 修订稿 §12.2 末行"迁移工具建议 pt/Flyway"是**技术选型定稿前的旧建议**，本仓不采：迁移工具固定 `drizzle-kit generate` + `migrate`（技术选型 §3.2/§3.2b）。那条"框架与迁移工具解耦"的论证仍成立，但落点已定。
6. seed 清单以修订稿 §2.3 为准：**5 配置表 + 8 状态 + 8 条预置规则 + 7 通知模板 + 5 角色（含 4 个特权开关）**，全部 `ON CONFLICT (code) DO NOTHING` 幂等可重放。技术选型 §3.2b 第 3 条里那句"5 规则"是旧值，已就地标注过期。规则引用 `code`/`template_code` 而**不是雪花 id**，这样 seed 才能跨环境重放（修订稿 §2.4 末行）。

---

## Drizzle 写法的三条硬约束

**禁令②**（§13.5，逐字）：Drizzle partial index 的 `.where()` **只用 `sql` 模板，禁用 `eq()`/`and()`**——`drizzle-orm@0.45.3` 实测会生成非法的 `$1`（open issue #4790）。锁 `drizzle-orm`/`drizzle-kit` 精确版本，升级时复验。

**禁令③**（§13.5，逐字）：生成列写法 `generatedAlwaysAs(sql\`…\`)` 或回调形式，**pg 侧没有 `.stored()`**；PG 只有 STORED，生成列不可进 PK/FK/unique、不可引用其他生成列。

```ts
// 目标形态：partial unique（一期规则唯一性的骨架）
index("uk_rule_scope").unique()
  .where(sql`${automationRule.isEnabled} AND ${automationRule.isDeleted} = false`)  // ✅ sql 模板
  // .where(and(eq(automationRule.isEnabled, true)))                                 // ❌ 禁令②
```

---

## 枚举与 CHECK：单一事实源

- 取值**权威源**是 `docs/PRD-phase1-enums-and-schemas.md`（E01–E37，其中 34 项为真实取值）。落地在 `src/shared/enums/`（枚举表 §5.1 的目录按现行拓扑读作此路径），每个文件同时导出 **TS 联合类型 + 值数组 + 中文名字典**。
- **CHECK 手写进迁移 SQL**，不做 codegen 管线（枚举表 §5.1 已把原"由值数组生成"改判为"手写 + 一条一致性测试"）。
- **必配测试**：读值数组与迁移文件里的 `CHECK` 取值做集合比较，不一致即 CI 失败（M0 退出条件之一，落地方案 §2）。
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

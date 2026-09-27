# Logging Guidelines

> 两类日志不要混：**业务审计 `activity_log`（入库、同事务）** 与 **应用日志（结构化输出，供运维）**。
> 来源：`docs/PRD-phase1-enums-and-schemas.md` §3（动作闭集）、§5.4；`docs/tech-stack-decision.md` §7 末两条实现口径、§6；`docs/PRD-phase1-permission-design-draft.md` §7.3。

---

## 一、`activity_log`：业务审计

### 闭集取值

`action varchar(40)`，取值**只在枚举表 §3 那一份里**，分四组：

| 组 | 载荷 | 代表动作 |
|---|---|---|
| §3.1 实体 CRUD | `field_diffs` | `MATTER_CREATED/UPDATED/DELETED`、`NODE_*`、`PROGRESS_*`、`EXPENSE_*`、`PARTY_*`、`COMMENT_*`、`ATTACHMENT_UPLOADED/DELETED` |
| §3.2 状态与归属 | `field_diffs` + `reason` | `STATUS_CHANGED`、`ARCHIVED`、`UNARCHIVED`、`OWNER_CHANGED`、`CONVERTED_TO_CASE`、`UNCONVERT`、`NODE_COMPLETED`、`NODE_CANCELLED` |
| §3.3 授权与安全 | 结构化 | `STAFF_CHANGED`、`ROLE_CHANGED`、`USER_ACTIVATED`、`SENSITIVE_FIELD_READ`、`ACCESS_DENIED_WRITE` |
| §3.4 自动化与提醒 | 结构化 | `AUTO_RULE_EXECUTED/SKIPPED/FAILED`、`REMINDER_*` |

四条容易写错的口径，逐条来自枚举表：

1. `*_UPDATED` **只在业务字段变化时写**。`updated_at` 与派生列（`deadline_time`、`is_archived`、`converted_case_count`）不触发日志。
2. `reason` 必填位：`ARCHIVED`、`UNARCHIVED`、`UNCONVERT`、`NODE_CANCELLED` 一律必填；`STATUS_CHANGED` 在**偏离推荐路径**时必填（修订稿 §3.3 第 3 条）。必填由服务层校验，不靠调用方自觉。
3. `UNCONVERT` 是后补的——原清单漏登而映射矩阵 §5.1 已在用它写审计。**新增动作必须先回枚举表**，不得在代码里造新值。
4. `SENSITIVE_FIELD_READ` 的载荷是 `{target_type,target_id,fields:[]}`，**不含值**——审计表本身不能变成明文存放处。
5. `ACCESS_DENIED_WRITE` 只记写操作被拒；**读拒绝不记**，否则案号枚举探测会反向灌满日志表。

### 结构与事务

- 表除 `field_diffs` 外还有 `payload jsonb`（枚举表 §5.4）：`field_diffs` 只存字段差异（`{"level":{"from":"中","to":"高"}}`），结构化载荷进 `payload`。**不要**把结构化结果塞回 `field_diffs`——那是 §3.6 记过的"语义污染"。
- 审计写与业务写**同一事务**（落地方案 §4-5）：状态变更、参与人变更、授权变更、转案件与撤销必须同批落。
- 写入点收敛在**服务层单点包装**（写操作成功后落日志），不是框架 Interceptor/Guard（技术选型 §4 行 4）。

### 明确不进 `activity_log` 的

**登录成功/失败不写**——会灌表且不是业务动作（技术选型 §7 末段）。走 `auth_session`（含 `auth_via`）+ 应用日志。进业务审计的只有三类：`USER_ACTIVATED`、`ROLE_CHANGED`、`is_enabled` 变更。

`activity_log` 的**留存期与备份策略未决**（属合规输入，master G 组 / 落地方案 W7-2）。不要自行写保留策略或定期清理任务。

---

## 二、应用日志

- **结构化输出**（key-value / JSON），带 `requestId`、`userId`、`targetType`、`targetId`、耗时。文本拼接的日志无法在派单后被检查。
- 级别：`error`＝需要人看（投递失败、事务意外回滚、advisory lock 拿不到却本应拿到）；`warn`＝预期内的拒绝与降级（云之家同步失败落 `sync_status='unknown'`）；`info`＝任务边界与计数（一次扫描处理 N 条、outbox 投递 N 条）；`debug` 默认关。
- worker 的四件任务每条都要打：开始、拿到/没拿到锁、处理条数、耗时。没拿到锁是**正常路径**，不要用 `error`。

### 日志脱敏（硬性）

- **禁止**输出：明文敏感字段（当事人证件号、手机号原值）、`password_hash`、session token / `token_hash`、云之家 `appId`/`appSecret`、AES 与 HMAC 密钥、`eid`/`openId` 的批量列表。
- 需要定位问题时打 **id + 字段名**，不打值（与 `SENSITIVE_FIELD_READ` 同一口径）。
- 不要把密钥 echo 进日志"确认已加载"——打印是否存在即可。
- 云之家不可达时告警要说明走的是哪条降级路径（登录时校验 / 长期未登录告警），这是 P1-16 已接受风险的可观测面。

---

## 三、权限缓存与失效

- 权限集在**进程内 `Map`** 缓存，键为 `userId:token_version`；版本变更天然失效（技术选型 §12.5）。
- 除此之外**不引入任何跨用户共享缓存**（HTTP 层、反代、查询结果都不行）——本系统每次读取都带行级谓词，共享缓存＝泄露面（§12.5 原话）。
- 同理禁止使用 Next 的 `'use cache'` 做跨请求/跨用户缓存（§13.3-3）。默认每实例一份的缓存与"不引跨用户缓存"决定天然一致，但不要主动扩大它。

---

## 常见错误

1. 用 ORM 插件/拦截器"自动"写审计，结果派生列也记日志。
2. `ARCHIVED` 不填 `reason`，事后无法回溯。
3. 登录失败写进 `activity_log`，把业务审计表当访问日志。
4. 在日志里打完整手机号/证件号"便于排查"。
5. 为提速加一层 Redis/HTTP 缓存 → 直接绕过行级数据范围。

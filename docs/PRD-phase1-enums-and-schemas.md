# MatterNest 第一期设计交付物 — 枚举与结构登记表（B6）

> 状态：**定稿**。闭合 `PRD-phase1-design-revision-r1.md` §10 的 B6 项，并一并关掉 §11 遗留风险 1（`scope_key` 归一化）与 §6.3 各行的"枚举闭合"占位。
> 本文件是**取值权威源**。另两份文档中的枚举与本表冲突时，以本表为准并回改本表以外的文件。

---

## 0. 配置表 vs 硬编码：分界原则

判据只有一条：**运营/管理员会不会需要在不发布版本的前提下改它**。

| 归类 | 清单 | 载体 |
|---|---|---|
| **配置驱动** | 状态、节点类型、费用项目、风险等级、标签 | 5 张配置表 + 后台单页 |
| **硬编码** | 本表其余全部 | 代码常量 + DB `CHECK` |

> 本表新增若干枚举（风险类型、案件类型、审级、诉讼地位、证件类型…），PRD 原文把它们写成"配置读取"，但**不升格为配置表**，理由是：这些取值参与代码分支（转案件字段映射、审级推荐节点模板、案由展示），改一个值要跟着改逻辑；做成可配会制造"配置能选但代码不认"的错配。配置表数量封在 5 张，每加一张就多一套 CRUD + 权限 + 引用校验。
>
> **例外**：若后续出现"按所调整案由/风险类型"的真实诉求，走 §6 的升级路径，不改本表结构。

**存储约定**：`varchar(32)` + `CHECK (col IN (...))`；**不使用 PG `enum` 类型**（加值需 `ALTER TYPE`，且在事务块/逻辑复制下受限）。取值一律 `snake_case` 英文，中文名只出现在前端字典。`CHECK` 与代码常量由同一份 seed 生成，避免双份漂移。

---

## 1. 主体与关系

| # | 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|---|
| E01 | `app_user.status` 类 | — | — | 无此列，用 `is_enabled boolean` |
| E02 | `role.data_scope` | `all` `participating` `owned` | `participating` | 权限草案 §1。**无 L4** |
| E03 | `target_type` | `matter` `risk_matter` `matter_node` `risk_matter_node` `matter_progress` `matter_expense` | — | 修订稿 §1.0.2。禁止缩写 `risk`；`case_study` 随模块移出 |
| E04 | `*_staff.staff_role` | `owner` `co_owner` `follower` | — | 除 `owner` 外可多行 |
| E05 | `user_watch.watch_type` | `follow` `favorite` | — | `follow` 由 staff 同步生成；`favorite` 仅本人 |
| E06 | `*_party.party_role` | 见 E12 | — | 复用诉讼地位取值 |
| E07 | `*_party.represented` | `true` `false` | — | 是否我方代理。**与 party_role 正交**：同一案件可有多个 `represented=true` 的当事人，角色各异（本诉原告 + 反诉被告） |
| E08 | `status_config.host_type` | `matter` `risk_matter` | — | |
| E09 | `status_config.semantics` | `open` `in_progress` `closed` `archived` `custom` | `custom` | 修订稿 §3.1。**新建状态只能选 `custom`**，四个内置语义由 seed 持有且不可授予 |
| E10 | `node_type_config.host_type` | `matter` `risk_matter` | — | 取代原 `applicable_type` 三值 |
| E11 | `node_type_config.time_type` | `point` `range` | `point` | 时间点 / 时间段 |

## 2. 业务分类

| # | 字段 | 取值 | 必填 | 说明 |
|---|---|---|---|---|
| E12 | `matter.litigation_role` / `*_party.party_role` | `plaintiff` `defendant` `third_party` `applicant` `respondent` `appellant` `appellee` `petitioner` `respondent_petition` `executant` `other` | 是 | 原告/被告/第三人/申请人/被申请人/上诉人/被上诉人/再审申请人/被申请人/被执行人/其他 |
| E13 | `matter.case_type` | `civil_commercial` `criminal` `administrative` `non_litigation` | 是 | 民商事/刑事/行政/非诉 |
| E14 | `matter.procedure` | `first_instance` `second_instance` `retrial_review` `retrial` `arbitration` `execution` `execution_objection` `bankruptcy` `other` | 是 | 取代原文"…等"的开放表述 |
| E15 | `risk_matter.type` | `contract` `labor_dispute` `ip` `corporate_governance` `debt` `compliance` `litigation_derived` `other` | 是 | 合同/劳动争议/知识产权/公司治理/债权债务/合规/诉讼衍生/其他 |
| E16 | `risk_matter.source` | `business_report` `customer_complaint` `lawyer_letter` `internal_check` `other` | 否 | 业务报备/客户投诉/律师函/内部检查/其他 |
| E17 | `party.type` | `natural_person` `legal_person` `unincorporated_org` | 是 | 决定 E18 与 `id_number` 的校验规则 |
| E18 | `party.id_type` | `id_card` `unified_social_credit` `passport` `hk_mo_tw_permit` `military_id` `foreign_residence` `other` | 否 | `type=natural_person` 时期望 `id_card`/`passport`/…；法人时期望 `unified_social_credit` |
| E19 | `matter_progress.progress_type` | `routine` `court_action` `counterparty` `client_feedback` `internal_decision` `material_filing` | 是 | 日常推进/法院动作/对方动作/客户反馈/内部决议/材料提交 |
| E20 | `matter_expense.status` | `pending_pay` `paid` `void` | 是 | 第一期**无审批流**，不含 `approved` |
| E21 | `matter_node.status` / `risk_matter_node.status` | `not_started` `in_progress` `completed` `cancelled` | `not_started` | 修订稿 §3.5 生命周期 |
| E22 | `*_node.source_kind` | `manual` `preset` `rule` | `manual` | 对应修订稿 §4 的 P1/P2 两路径。原命名 `preset_p1`/`rule_p2` 简化为本值，路径由 `source_ref` 区分 |
| E23 | `custom_reminder.status` | `pending` `sent` `cancelled` `failed` | `pending` | 取代原 `is_sent boolean`（无法承载 `repeat_type`） |
| E24 | `custom_reminder.repeat_type` | `none` `daily` `weekly` `monthly` `yearly` | `none` | 有值时 `next_remind_time` 由发送成功后按此推进 |
| E25 | `notify_channel` | `in_app` `email` | `in_app` | 第一期仅两个。企微/钉钉留 E25 扩展位，不进 CHECK |
| E26 | `attachment.category` | `evidence` `complaint` `judgment` `contract` `internal_doc` `other` | 否 | 证据/起诉状/判决书/合同/内部文书/其他。第一期不做配置表 |
| E27 | 通用 `currency` | `CNY`（唯一值） | `CNY` | `char(3)`。列先留、值锁死，避免日后加币种时改 `numeric` 精度 |
| E28 | `risk_matter.conversion_status` | `0` 未转案件 `1` 已转案件 | `0` | `smallint`，非枚举语义。修订稿 §3.4 |

---

## 3. `activity_log.action` 完整清单

`action varchar(40)`，取值闭合如下。**这是唯一一份允许写入 `field_diffs` 以外载荷的表**。

### 3.1 实体 CRUD（载荷：`field_diffs`）

```text
MATTER_CREATED          MATTER_UPDATED          MATTER_DELETED
RISK_CREATED            RISK_UPDATED            RISK_DELETED
NODE_CREATED            NODE_UPDATED            NODE_DELETED
PROGRESS_CREATED        PROGRESS_UPDATED        PROGRESS_DELETED
EXPENSE_CREATED         EXPENSE_UPDATED         EXPENSE_DELETED
PARTY_CREATED           PARTY_UPDATED           PARTY_DELETED
COMMENT_CREATED         COMMENT_UPDATED         COMMENT_DELETED
ATTACHMENT_UPLOADED     ATTACHMENT_DELETED
```

`*_UPDATED` 只在**业务字段**变化时写；`updated_at`、派生列（`deadline_time`、`is_archived`、`converted_case_count`）不触发日志。

### 3.2 状态与归属（载荷：`field_diffs` + `reason`）

| action | `reason` | 备注 |
|---|---|---|
| `STATUS_CHANGED` | 偏离推荐路径时**必填** | 修订稿 §3.3 第 3 条 |
| `ARCHIVED` | 必填 | 归档动作本身单记一条，便于回溯"谁在何时归的档" |
| `UNARCHIVED` | 必填 | 需 `can_unarchive` |
| `OWNER_CHANGED` | 选填 | 与 `*_staff.owner` 同事务 |
| `CONVERTED_TO_CASE` | 选填 | 转案件确认，载荷含 `case_ids[]` |
| `NODE_COMPLETED` | 选填 | |
| `NODE_CANCELLED` | 必填 | 取消原因已在列 `cancel_reason`，日志与列同值 |

### 3.3 授权与安全

| action | 载荷 | 说明 |
|---|---|---|
| `STAFF_CHANGED` | `{added:[],removed:[],role}` | 修订稿 §6 / 权限草案 §6 |
| `ROLE_CHANGED` | `{role_id, old:{}, new:{}}` | **唯一允许记录范围类旧值的 action** |
| `SENSITIVE_FIELD_READ` | `{target_type,target_id,fields:[]}` | **不含值**。权限草案 §7.3 |
| `ACCESS_DENIED_WRITE` | `{target_type,attempted_action}` | 只记写操作拒绝；读拒绝不记（否则案号枚举探测会反向灌满日志表） |

### 3.4 自动化与提醒

| action | 载荷 |
|---|---|
| `AUTO_RULE_EXECUTED` | `{rule_id, rule_name, action_type, target_ids:[], event_id}` |
| `AUTO_RULE_SKIPPED` | 同上 + `skip_reason`（冲突唯一键 / 冷却期 / 收件人不可见） |
| `AUTO_RULE_FAILED` | 同上 + `error` |
| `REMINDER_SENT` | `{reminder_id, channel}` |
| `REMINDER_FAILED` | 同上 + `error` |

> 修订稿 §3.6 原把规则结果塞进 `field_diffs`，现改用 `payload jsonb` 列（见 §5.4），`field_diffs` 回归"字段差异"本义。

---

## 4. 自动化规则的结构定义

### 4.1 `trigger_config`（按 `trigger_type` 一对一）

```jsonc
// status_changed —— 触发实体 = 宿主
{ "status_code": "closed" }

// time_no_progress —— 触发实体 = 宿主；比较基准见修订稿 §6.4 last_progress_at
{ "days": 30 }

// node_before_start —— 触发实体 = 节点表
{ "days": 3 }

// node_before_end —— 触发实体 = 节点表；仅 time_type=range 且 end_time 非空
{ "days": 3 }

// event_occurred —— 第一期唯一事件
{ "event": "risk_converted" }
```

校验：未知键拒绝；`days` 为 `1..365` 整数；`status_code` 必须存在于当前启用配置且不被停用（修订稿 §2.2）。

### 4.2 `extra_condition`（第一期能力边界）

```jsonc
{ "op": "and",
  "conditions": [
    { "field": "level",  "op": "in",  "value": ["high"] },
    { "field": "amount", "op": "gt",  "value": 1000000 }
  ] }
```

| 约束 | 值 |
|---|---|
| 嵌套 | 仅 1 层：根 `and`，子条件不可再含 `op` |
| 逻辑算子 | 只有根节点 `and`。**不支持 `or` / 取反 / 子查询 / 聚合** |
| 比较算子 | `eq` `ne` `in` `not_in` `gt` `lt` `is_empty` `not_empty` |
| 字段白名单 | 案件：`level` `case_type` `procedure` `litigation_role` `owner_id` `tag_ids` `amount` `court`<br>事项：`level` `type` `source` `owner_id` `tag_ids` `amount` |
| 字段名解析 | 存 `code` 不是列名，白名单外的 key 直接拒绝保存 |

> 规则 4「30 天无更新」的"无更新"判断**不在此表达**，内置在动作实现里（修订稿 §2.5）。这是第一期把引擎限定为"5 种内置触发 + 可配参数"的直接后果，需在配置页对用户明示。

### 4.3 `action_config`（按 `action_type` 一对一）

```jsonc
// archive            —— 无参；语义 = 置为本宿主 semantics='archived' 的状态
{}

// notify
{ "receivers": ["owner", "follower"],          // owner|co_owner|follower|custom
  "template_code": "case_closed",
  "custom_user_ids": [],                        // 仅 receivers 含 custom 时允许非空
  "once_per_target": false,
  "cooldown_days": 0 }                          // once_per_target=true 时必须 >=1

// create_node        —— 按 template_code 展开为多行
{ "template_code": "matter_in_progress",
  "offset_days_from": "status_changed_at",      // 唯一值；节点 start_time = 变更时间 + 该类型偏移
  "offset_days": 0 }

// assign_staff
{ "staff_role": "co_owner",
  "user_ids": [123, 456],
  "mode": "append" }                            // append|replace

// update_field       —— 不含 status；不含人员类字段（owner_id/role/…，避免与 assign_staff 重叠，修订稿 D4）
{ "field": "level", "value": "high" }
```

`update_field.field` 白名单：`level` `source` `cause` `court` `remark`。**排除**：`status`（禁止）、`owner_id`/`co_owner_ids`/`follower_ids`（走 `assign_staff`）、`id`/`code`/`internal_code`/`case_no`/`created_*`（不可变或审计列）、`is_archived`/`deadline_time`/`converted_case_count`（派生列）。

### 4.4 `scope_key` 归一化（关闭修订稿 §11 遗留风险 1）

```text
scope_key = base32_hex( sha1( normalized ) ) [0:12]

normalized := trigger_type + "|" + trigger_target_type + "|" + canon(trigger_config)

canon(json):
  1. 递归按键名 ASCII 升序排列
  2. 丢弃值为 null / [] / {} / "" 的键
  3. 数组：标量数组先升序排序（["b","a"] -> ["a","b"]）；对象数组保序并递归 canon
  4. 标量统一 str()：布尔 -> true/false；整数不带前导零；金额用原始字符串
  5. 数值键（days / offset_days / cooldown_days）取 int()，忽略 "3" 与 "03" 与 3.0 的字面差异
  6. 引用类字段的值必须是 code 字符串；解析到 id 的一律先转 code 再入串
  7. 序列化结果去除全部空白字符
```

**单测向量（实现必须逐条通过；这是唯一性约束不漂移的前提）**

| # | 输入 A | 输入 B | 期望 |
|---|---|---|---|
| V1 | `{"status_code":"closed"}` | `{"status_code":"closed"}` | 同 key |
| V2 | `{"days":3}` | `{"days":"03"}` | 同 key（向量 5） |
| V3 | `{"receivers":["owner","follower"]}` | `{"receivers":["follower","owner"]}` | 同 key（向量 3） |
| V4 | `{"status_code":"closed"}` | `{"status_code":"in_progress"}` | 不同 key |
| V5 | `{"days":3,"x":null}` | `{"days":3}` | 同 key（向量 2） |
| V6 | `{"a":1,"b":2}` | `{"b":2,"a":1}` | 同 key（向量 1） |
| V7 | `{"event":"risk_converted"}` | `{"days":30}` 且 trigger_type 相同 | 不同 key |
| V8 | `{"status_code":"closed"}` status 被改名 `name` 但 `code` 不变 | 同配置 | **同 key**——证明约束挂在 code 上 |

---

## 5. 落地方式

### 5.1 单一事实源

```text
packages/domain/enums/
├── targets.ts       # E03
├── status.ts        # E09 + 内置 semantics 行为映射
├── business.ts      # E12–E22, E26–E28
├── notify.ts        # E23–E25 + notification_event.event_type + source_type
├── audit.ts         # §3 action 清单
└── automation.ts    # §4 的 trigger_type / action_type / 算子 / 字段白名单
```

每个文件同时导出 TS 联合类型、值数组、中文名字典。

`CHECK` 约束**在迁移 SQL 里手写**，但配一条一致性测试兜底：读 `role_permission` 式的值数组与迁移文件里的 `CHECK` 取值做集合比较，不一致即 CI 失败。

> 这一条是我改的，原稿写的是"由值数组在迁移生成期产出、不手写 SQL 取值列表"。理由：生成 CHECK 要建一条 codegen 管线（读 TS → 产 SQL → 写进迁移文件），而本表 28 项枚举变更频率极低（一期只增不改），管线收益抵不过成本；同时技术选型 §3.2b 已定"迁移 SQL 文件是唯一事实、须可人审"，生成器往迁移里插内容会让迁移不再是稳定产物。集合一致性测试能抓住同一个错误（枚举与库约束不同步），代价是一个测试文件。

### 5.2 三条约束模板

```sql
ALTER TABLE matter ADD CONSTRAINT ck_matter_case_type
  CHECK (case_type IN ('civil_commercial','criminal','administrative','non_litigation'));

ALTER TABLE matter_node ADD CONSTRAINT ck_node_status
  CHECK (status IN ('not_started','in_progress','completed','cancelled'));

-- range 型必须同时有起止；point 型禁止填 end_time
ALTER TABLE matter_node ADD CONSTRAINT ck_node_time_shape CHECK (
  (time_type = 'range'  AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time >= start_time)
  OR (time_type = 'point' AND end_time IS NULL)
  OR (start_time IS NULL AND end_time IS NULL)   -- 待定时间，修订稿 §6.1
);
```

### 5.3 加值规则

| 情况 | 处理 |
|---|---|
| 新增一个取值 | 改常量 + 迁移 `DROP`/`ADD CONSTRAINT`。PG 的 `ALTER TABLE ... ADD CHECK` 会全表扫，第一期数据量下可接受 |
| 需要运营自助加值 | 说明该项判断错了，按 §6 升格为配置表，**不要**放宽成 `varchar` 无约束 |
| 废弃一个取值 | 常量保留并标 `@deprecated`，前端不再展示；历史数据仍要能反查中文名。**禁止**从 CHECK 里删值（会让历史行违反约束） |

### 5.4 顺带要求：`activity_log` 补一列

```sql
ALTER TABLE activity_log ADD COLUMN payload jsonb;   -- §3 的结构化载荷
-- field_diffs 只存字段差异：{"level":{"from":"中","to":"高"}}
```

---

## 6. 未来才做的升级路径（现在不建表、不留列）

| 触发条件 | 动作 |
|---|---|
| 需要按所定制案由 | 引入 `cause_config(code, name, parent_id)` 树表 + `matter.cause_code`；`matter.cause` 自由文本保留为展示兜底 |
| 需要按所定制风险类型 | E15 升格为 `risk_type_config`，配置表数量 5 → 6 |
| 需要新增通知渠道 | E25 加值 + 一个投递适配器 |
| 规则需要 `or`/聚合 | **不要扩 `extra_condition`**。届时区分"内置规则"与"用户可配规则"两张表，见修订稿 §2.5 |
| 案例模块回归 | 回补 `case_study.status`(`draft`/`published`/`archived`) 与 `E03` 的 `case_study` 值 |

---

## 7. 闭合关系

| 上游占位 | 本表 |
|---|---|
| 修订稿 §10 B6 | 关闭 |
| 修订稿 §11 遗留风险 1（`scope_key` 归一化） | 关闭，§4.4 含 8 条单测向量 |
| 修订稿 §6.3 各"枚举闭合"行 | 取值统一以本表为准，修订稿保留语义说明 |
| 修订稿 §2.5 引擎能力边界 | §4.2 具体化为 schema + 白名单 |
| 修订稿 §3.6 `field_diffs` 语义污染 | §3.4 + §5.4 用 `payload` 分离 |
| 权限草案 §7.3 明文读取 | E `SENSITIVE_FIELD_READ` |

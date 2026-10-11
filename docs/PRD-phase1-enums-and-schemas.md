# MatterNest 第一期设计交付物 — 枚举与结构登记表（B6）

> 状态：**v4（2026-10-10 意图对齐回写）**。闭合 `PRD-phase1-design-revision-r1.md` §10 的 B6 项，并一并关掉 §11 遗留风险 1（`scope_key` 归一化）与 §6.3 各行的"枚举闭合"占位。
> 本文件是**取值权威源**。其余各份文档（修订稿 / 权限草案 / 转案件矩阵 / 基线 / master）中的枚举与本表冲突时，以本表为准并回改本表以外的文件。
> **v2 变更**：补登 E29–E33（通知与 outbox 三个枚举此前只在修订稿散落，权威源反而缺记）；§3.2 补 `UNCONVERT`；E09 的默认值口径与修订稿 §3.1 统一；§4.2 白名单按宿主分列并回改了修订稿 §2.5。
> **v3 变更**（同日）：认证双通道 + 待开通态裁定后补登 **E34–E37**（provider / auth_via / sync_status / activation_status），§3.3 补 `USER_ACTIVATED`，§5.1 新增 `auth.ts`。全表现共 37 行、34 项为真实取值登记。
> **v4 变更**（2026-10-10，意图对齐回写 IQ-1…14 / master §7.4）：**只改取值与注记，表结构、字段矩阵、生成规则一字未动**——E13 删"非诉"、E06/E07/E12 钉企业当事方视角、E16 值名待改 `external_dispute`、E25 `email` 撤出一期、status_config 显示名（已登记/了结/已结案）、§3 追加 `PARTY_MERGED`/`BULK_IMPORT` 与 `SENSITIVE_FIELD_READ` 作废、§0 配置后台改"每类独立功能页"、`AL` 前缀注为一期不实现。作废值与作废行**保留原行并加标注**，不物理删除；代码 `src/shared/enums/` 同步在后。

---

## 0. 配置表 vs 硬编码：分界原则

判据只有一条：**运营/管理员会不会需要在不发布版本的前提下改它**。

| 归类 | 清单 | 载体 |
|---|---|---|
| **配置驱动** | 状态、节点类型、费用项目、风险等级、标签 | 5 张配置表 + **每类独立功能页**（IQ-9 Q38 用户亲拍，2026-10-10 回写；原"后台单页/合并字典页"口径作废） |
| **硬编码** | 本表其余全部 | 代码常量 + DB `CHECK` |

> 本表新增若干枚举（风险类型、案件类型、审级、诉讼地位、证件类型…），PRD 原文把它们写成"配置读取"，但**不升格为配置表**，理由是：这些取值参与代码分支（转案件字段映射、审级推荐节点模板、案由展示），改一个值要跟着改逻辑；做成可配会制造"配置能选但代码不认"的错配。配置表数量封在 5 张，每加一张就多一套 CRUD + 权限 + 引用校验。
>
> **例外**：若后续出现"按企业调整案由/风险类型"的真实诉求，走 §6 的升级路径，不改本表结构。

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
| E06 | `*_party.party_role` | 见 E12 | — | 复用诉讼地位取值。**语义钉（IQ-7/Q24）：指「对方」在该案中的地位，相对我方（本企业）视角——本企业永不入 party 表，我方地位是案件单值 `litigation_role`（见 E12）** |
| E07 | `*_party.represented` | `true` `false` | — | **❌ 软作废（IQ-15，2026-10-10）**：企业口径下我方永不入 party 表，"是否我方代理"语义消失（该判断的旧参照系是律所）。**列保留在库**（不作破坏性迁移，守"迁移唯一事实"），**DTO/服务层/前端不再读写，转案件预填规则同步删除**；历史行不回填。行与编号保留不物理删（`@deprecated`）。若将来确有"同阵营共同诉讼人"诉求，用 `party_role`（第三人/共同被告）表达，不复活本列 |
| E08 | `status_config.host_type` | `matter` `risk_matter` | — | |
| E09 | `status_config.semantics` | `open` `in_progress` `closed` `archived` `custom` | `custom`（**仅 DDL 兜底**） | 修订稿 §3.1。**新建状态只能选 `custom`**，四个内置语义由 seed 持有且不可授予。API 层该字段**保存时必填**，DB 默认值不构成"可以不给 semantics"——两处口径以此为准。**显示名口径（IQ-5/6，2026-10-10 回写；`code` 与 semantics 全部不变，改的只是 `name` 列）**：`pending`→「已登记」（原"待受理"作废，去流程暗示，双宿主同）；事项 `closed`→「了结」，案件 `closed`→保留「已结案」（"结案"是诉讼词，事项侧不用）。seed 八行见修订稿 §3.2 |
| E10 | `node_type_config.host_type` | `matter` `risk_matter` | — | 取代原 `applicable_type` 三值 |
| E11 | `node_type_config.time_type` | `point` `range` | `point` | 时间点 / 时间段 |

## 2. 业务分类

| # | 字段 | 取值 | 必填 | 说明 |
|---|---|---|---|---|
| E12 | `matter.litigation_role` / `*_party.party_role` | `plaintiff` `defendant` `third_party` `applicant` `respondent` `appellant` `appellee` `petitioner` `respondent_petition` `executant` `other` | 是 | 原告/被告/第三人/申请人/被申请人/上诉人/被上诉人/再审申请人/被申请人/被执行人/其他。**语义钉（IQ-6/Q24）：`matter.litigation_role` = 我方诉讼地位（原告/被告/第三人/申请人/被申请人），指本企业在该案中的角色，非"全案角色"；同一套取值复用给 E06 时含义是「对方在该案中的地位」** |
| E13 | `matter.case_type` | `civil_commercial` `criminal` `administrative` `non_litigation` ❌（作废保留，禁止从 CHECK 删值，见 §5.3） | 是 | 民商事/刑事/行政/~~非诉~~。**IQ-6/Q25 裁定：案件 = 正式法律程序（诉讼/仲裁/执行），"非诉"不作案件分类——`non_litigation` 值作废，前端不再展示、后端拒绝新写入；非诉事务归风险事项（E15）。历史行仍要能反查中文名** |
| E14 | `matter.procedure` | `first_instance` `second_instance` `retrial_review` `retrial` `arbitration` `execution` `execution_objection` `bankruptcy` `other` | 是 | 取代原文"…等"的开放表述。**注（IQ-6）：`arbitration`/`execution`（及 `execution_objection`）属正式法律程序，全部保留**——企业口径下仲裁与执行同样是案件，不因非法院诉讼而降格为风险事项 |
| E15 | `risk_matter.type` | `contract` `labor_dispute` `ip` `corporate_governance` `debt` `compliance` `litigation_derived` `other` | 是 | 合同/劳动争议/知识产权/公司治理/债权债务/合规/诉讼衍生/其他 |
| E16 | `risk_matter.source` ⚠ 值名待改（见说明） | `business_report` `customer_complaint` `lawyer_letter` `internal_check` `other` | 否 | 业务报备/客户投诉/律师函/内部检查/其他。**IQ-5 偏差5（律所残留词企业化）**：`customer_complaint` 的中文"客户投诉"是律所代理口径（企业当事方没有客户，见 GLOSSARY「对方当事人」_Avoid_），建议新值名 external_dispute（对外纠纷/投诉）替换它；"律师函"保留、语义标注为**收到对方当事人律师函**。**E16 值名变更待迁移确认，代码 `src/shared/enums/` 同步在后**（走 §5.3 废弃流程：常量保留标 `@deprecated`、禁止从 CHECK 删值、历史行仍可反查中文名） |
| E17 | `party.type` | `natural_person` `legal_person` `unincorporated_org` | 是 | 决定 E18 与 `id_number` 的校验规则 |
| E18 | `party.id_type` | `id_card` `unified_social_credit` `passport` `hk_mo_tw_permit` `military_id` `foreign_residence` `other` | 否 | `type=natural_person` 时期望 `id_card`/`passport`/…；法人时期望 `unified_social_credit` |
| E19 | `matter_progress.progress_type` | `routine` `court_action` `counterparty` `client_feedback` `internal_decision` `material_filing` | 是 | 日常推进/法院动作/对方动作/客户反馈/内部决议/材料提交 |
| E20 | `matter_expense.status` | `pending_pay` `paid` `void` | 是 | 第一期**无审批流**，不含 `approved` |
| E21 | `matter_node.status` / `risk_matter_node.status` | `not_started` `in_progress` `completed` `cancelled` | `not_started` | 修订稿 §3.5 生命周期 |
| E22 | `*_node.source_kind` | `manual` `preset` `rule` | `manual` | 对应修订稿 §4 的 P1/P2 两路径。原命名 `preset_p1`/`rule_p2` 简化为本值，路径由 `source_ref` 区分 |
| E23 | `custom_reminder.status` | `pending` `sent` `cancelled` `failed` | `pending` | 取代原 `is_sent boolean`（无法承载 `repeat_type`） |
| E24 | `custom_reminder.repeat_type` | `none` `daily` `weekly` `monthly` `yearly` | `none` | 有值时 `next_remind_time` 由发送成功后按此推进 |
| E25 | `notify_channel` | `in_app` `email` | `in_app` | **一期仅 `in_app`**：`email` ❌ 撤出一期排期（IQ-8：绝不把 G3 押在无人查看的邮箱上）；云之家消息渠道待 MATT-34 接口摸底后进 E 表（调通则云之家进一期、`email` 永久归二期）。**调研结论出来前 `email` 不得接投递实现**，值域保留只为 CHECK 不返工。企微/钉钉留 E25 扩展位，不进 CHECK |
| E26 | `attachment.category` | `evidence` `complaint` `judgment` `contract` `internal_doc` `other` | 否 | 证据/起诉状/判决书/合同/内部文书/其他。第一期不做配置表 |
| E27 | 通用 `currency` | `CNY`（唯一值） | `CNY` | `char(3)`。列先留、值锁死，避免日后加币种时改 `numeric` 精度 |
| E28 | `risk_matter.conversion_status` | `0` 未转案件 `1` 已转案件 | `0` | `smallint`，非枚举语义。修订稿 §3.4 |
| E29 | `notification_event.event_type` | `status_changed` `node_due_start` `node_due_end` `stale_30d` `mention` `new_comment` `risk_converted` | — | 7 值。原 `expense_added` 已删（2026-09-26 裁定第一期不做费用通知）。修订稿 §7.2 |
| E30 | `notification_event.source_type` | `node_remind` `custom_reminder` `auto_rule` | — | 三条投递来源，去重与排障按它分流 |
| E31 | `notification_delivery.status` | `pending` `sent` `failed` `void` | `pending` | **与 E23 不同**：投递层用 `void`（收件人不可见而静默丢弃，权限草案 §8），提醒任务层用 `cancelled`（用户主动撤销）。不要合并成一套 |
| E32 | `event_outbox.event_type` | `risk_converted` `comment_added` | — | outbox 只承载"提交后派发"的领域事件，与 E33 同值域 |
| E33 | `trigger_config.event`（`event_occurred` 用） | `risk_converted` `comment_added` | — | 第一期两个值；规则 7 / 规则 8 各引一个（修订稿 §2.3） |
| E34 | `app_user_external_identity.provider` | `yunzhijia` | — | 第一期唯一外部身份源。云之家侧身份键是 `eid`/`openId`，存 `external_id`，**不进 `app_user`**（技术选型 §3.4） |
| E35 | `auth_session.auth_via` | `local` `yunzhijia` | — | 只用于审计与差异化失效策略，**不参与权限判定** |
| E36 | `app_user_external_identity.sync_status` | `active` `inactive` `unknown` | `unknown` | `inactive` = 云之家侧已不可见 → 触发 `is_enabled=false` + 吊销 session；同步失败保持 `unknown`，**不得当作 `inactive`**（否则一次网络抖动就把整个企业锁在门外） |
| E37 | `app_user.activation_status` | `pending` `active` | `pending`（仅云之家首登自动建号路径） | 与 `is_enabled` 正交：`pending` = 已建号但管理员未批准（登录返回「等待开通」），`is_enabled=false` = 停用/离职。**两者都不参与数据范围判定**。技术选型 §7 假设 F 裁定 |

> E29–E33 是 2026-09-26 补登：本表 §5.1 早已声明 `notify.ts` 要承载 `notification_event.event_type` 与 `source_type`，但取值一直只在修订稿 §7.2 的表里散落，权威源反而没记——这正是"单一事实源"最容易被绕过的形态。

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
| `UNCONVERT` | **必填** | 撤销转案件关联，载荷含 `case_id` + 剩余 `converted_case_count`。原清单漏登，但映射矩阵 §5.1 已在用它写审计——补上才算"取值闭合" |
| `NODE_COMPLETED` | 选填 | |
| `NODE_CANCELLED` | 必填 | 取消原因已在列 `cancel_reason`，日志与列同值 |

### 3.3 授权与安全

| action | 载荷 | 说明 |
|---|---|---|
| `STAFF_CHANGED` | `{added:[],removed:[],role}` | 修订稿 §6 / 权限草案 §6 |
| `ROLE_CHANGED` | `{role_id, old:{}, new:{}}` | **唯一允许记录范围类旧值的 action** |
| `USER_ACTIVATED` | `{external_id, provider, role_ids:[]}` | 云之家首登自动建号后，管理员批准开通并当场指定角色（E37 `pending → active`）。与 `is_enabled` 变更同批进审计 |
| `SENSITIVE_FIELD_READ` | `{target_type,target_id,fields:[]}` | **不含值**。权限草案 §7.3。**❌ 作废（IQ-12 / Q46′，2026-10-10）：展示层全明文，"显示明文"按钮与逐次读取审计一并取消——本动作一期不写入、前端不展示；行与编号保留不物理删（`@deprecated`，历史行仍需可反查）。明文「导出」改由 `can_read_plain` 把关（开关不删列、语义收窄为仅明文导出），留痕由下表 `EXPORT` 承接。** |
| `EXPORT` | `{target_type,scope,rows,count,plain:boolean}` | **新增（2026-10-10，IQ-12 落实）**：列表/清单导出动作留痕；`plain=true` 仅 `can_read_plain` 可为（草案 §7.3 明文导出两档）。**不含行内容**，只记档位与行数。**迁移与 `audit.ts` 注册在后**（与 `PARTY_MERGED`/`BULK_IMPORT` 同一姿态：文档先行，代码同步属后续票）。曾为 §6.1 引用的空指针，本轮补行闭合。 |
| `ACCESS_DENIED_WRITE` | `{target_type,attempted_action}` | 只记写操作拒绝；读拒绝不记（否则案号枚举探测会反向灌满日志表） |

### 3.4 自动化与提醒

| action | 载荷 |
|---|---|
| `AUTO_RULE_EXECUTED` | `{rule_id, rule_name, action_type, target_ids:[], event_id}` |
| `AUTO_RULE_SKIPPED` | 同上 + `skip_reason`（冲突唯一键 / 冷却期 / 收件人不可见） |
| `AUTO_RULE_FAILED` | 同上 + `error` |
| `REMINDER_SENT` | `{reminder_id, channel}` |
| `REMINDER_FAILED` | 同上 + `error` |

> 基线原文 3.6（规则执行结果一节；基线副本无对应段落，见 `PRD-phase1-baseline-v0.md` §B）原把规则结果塞进 `field_diffs`，现改用 `payload jsonb` 列（见 §5.4），`field_diffs` 回归"字段差异"本义。

### 3.5 意图对齐轮新增（2026-10-10，IQ-7 / IQ-11）

| action | 载荷 | 说明 |
|---|---|---|
| `PARTY_MERGED` | `{surviving_party_id, merged_party_ids:[]}` | F3-9 合并重复对手方档案：载荷记**主记录 id 与被并方 id**（关联改挂主记录、被并方软删）。IQ-7/Q30，PRD 原无此动作 |
| `BULK_IMPORT` | `{host_type, total_rows, imported_rows, error_rows, report_ref}` | F7-4 批量导入的**汇总**日志（一次导入一条，不逐行写审计）：行数与错误数进 `payload`。IQ-11/Q42，导入行本身各写一条 `*_CREATED` |

> 原拟追加的 `MATTER_CLAIMED` 已随 IQ-13-V2 撤销——"变更处理人"沿用既有 `OWNER_CHANGED`，不新造动作。

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

// event_occurred —— 第一期两个事件（E33）
{ "event": "risk_converted" }
{ "event": "comment_added" }
```

校验：未知键拒绝；`days` 为 `1..365` 整数；`status_code` 必须存在于当前启用配置且不被停用（修订稿 §2.2）；`event` 取值限 E33。

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
| 字段名解析 | 存 `code` 不是列名，白名单外的 key 直接拒绝保存。**按宿主分列**：案件含 `litigation_role`/`court` 无 `source`；事项含 `source` 无 `case_type`/`procedure`/`litigation_role`/`court`（修订稿 §2.5 的扁平白名单是旧版，已按本表回改） |

> 规则 4「30 天无更新」的"无更新"判断**不在此表达**，内置在动作实现里（修订稿 §2.5）。这是第一期把引擎限定为"5 种内置触发 + 可配参数"的直接后果，需在配置页对用户明示。

### 4.3 `action_config`（按 `action_type` 一对一）

```jsonc
// archive            —— 无参；语义 = 置为本宿主 semantics='archived' 的状态
{}

// notify
{ "receivers": ["owner", "follower"],          // owner|co_owner|follower|custom
  "template_code": "status_changed",
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
├── notify.ts        # E23–E25 + E29–E32（event_type / source_type / delivery.status / outbox.event_type）
├── auth.ts          # E34–E36（provider / auth_via / sync_status）
├── audit.ts         # §3 action 清单（含补登的 UNCONVERT）
└── automation.ts    # §4 的 trigger_type / action_type / 算子 / 字段白名单 + E33
```

每个文件同时导出 TS 联合类型、值数组、中文名字典。

> **W0-3 落地时的三处补齐（2026-09-27，实际落点 `src/shared/enums/`）**
>
> 1. **上面这张分册表没给 9 行归属**：E01、E02、E04、E05、E06、E07、E10、E11、E37 未被任何一册点名。已按语义裁定：
>    E02/E04/E05 进 `targets.ts`（同属"主体与关系"）、E06/E07/E10/E11 随其值域来源进 `business.ts`、E37 进 `auth.ts`、
>    E01 作为"无此列"占位进 `targets.ts`。**登记为占位而不是省略**，是为了让覆盖性测试能断言"37 行全有着落"——
>    漏登记与故意不登记，在测试结果上必须区分。
> 2. **两处同值域只允许一份实现**：E08 与 E10 的 `host_type` 取值完全相同，值定义住在 `targets.ts`，`status.ts` 再导出；
>    E32 与 E33 同值域，住在 `automation.ts`，`notify.ts` 再导出。一致性测试用"同一个数组引用"断言这一点
>    （两份相等的数组不算单实现——它们会各自漂移）。
> 3. **本表的「取值」列现在是机器核对对象**：`src/app/lib/server/db/enum-check.spec.ts` 逐行解析本表 §1/§2 的第三列，
>    与注册表值集合比对。改这张表等于改代码，改错了 CI 直接红；反过来说，**新增 E 行必须同时补注册表**。
>    例外三行（E01 `—`、E06「见 E12」、E07 布尔）在测试里显式登记，不允许悄悄扩大例外清单。

`CHECK` 约束**在迁移 SQL 里手写**，但配一条一致性测试兜底：读 `role_permission` 式的值数组与迁移文件里的 `CHECK` 取值做集合比较，不一致即 CI 失败。

> 这一条是我改的，原稿写的是"由值数组在迁移生成期产出、不手写 SQL 取值列表"。理由：生成 CHECK 要建一条 codegen 管线（读 TS → 产 SQL → 写进迁移文件），而本表 37 行（E01–E37，其中 34 项为真实取值）变更频率极低（一期只增不改），管线收益抵不过成本；同时技术选型 §3.2b 已定"迁移 SQL 文件是唯一事实、须可人审"，生成器往迁移里插内容会让迁移不再是稳定产物。集合一致性测试能抓住同一个错误（枚举与库约束不同步），代价是一个测试文件。

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
| 案例模块回归 | 回补 `case_study.status`(`draft`/`published`/`archived`) 与 `E03` 的 `case_study` 值。**编号前缀注（2026-10-10，IQ-11）：`AL` 是案例库编号遗留——案例移出第一期后 `AL` 一期不实现，代码 `CODE_PREFIX` 实际只有 FX/AJ 两个值**（详见修订稿 §12.3 前缀语义注记）；若回归，届时再补 `AL` |

---

## 7. 闭合关系

| 上游占位 | 本表 |
|---|---|
| 修订稿 §10 B6 | 关闭 |
| 修订稿 §11 遗留风险 1（`scope_key` 归一化） | 关闭，§4.4 含 8 条单测向量 |
| 修订稿 §6.3 各"枚举闭合"行 | 取值统一以本表为准，修订稿保留语义说明 |
| 修订稿 §2.5 引擎能力边界 | §4.2 具体化为 schema + 白名单 |
| 原文 3.6 `field_diffs` 语义污染（基线副本无此节，指针已纠正） | §3.4 + §5.4 用 `payload` 分离 |
| 权限草案 §7.3 明文读取 | E `SENSITIVE_FIELD_READ`（❌ 2026-10-10 IQ-12 作废：展示层全明文，逐次读取审计取消；草案 §7.3 与 §2.1 的"查看半边"待同步回改，`can_read_plain` 只守明文导出） |
| 映射矩阵 §5.1 `UNCONVERT` 用了未登记动作 | §3.2 补登，含 reason 必填与载荷口径 |
| 修订稿 §6.1 `source_kind=preset_p1/rule_p2` | E22 为 `preset`/`rule`，修订稿已回改 |
| 修订稿 §6.2 / §8.1 `matter_party.role` | E06 为 `party_role`，修订稿已回改（UK 并补 `represented` 说明） |
| 修订稿 §2.3 seed 的 `template:` 键 | §4.3 schema 键为 `template_code`，seed 已回改；`create_node` 亦补齐 `offset_days_from`/`offset_days` |
| 修订稿 §2.5 扁平 `extra_condition` 白名单 | §4.2 按宿主分列为权威，修订稿已回改 |
| 修订稿 §7.2 未登记的 `event_type`/`source_type`/`delivery.status` | E29–E31 补登；`expense_added` 按 2026-09-26 裁定删除 |
| 映射矩阵 §4.1 `event_outbox.event_type` | E32 补登 |
| 修订稿 §2.3 规则 8 的 `event_occurred` 新事件 | E33 + §4.1 校验行 |
| 技术选型 §3.4 双通道登录新增的三组取值 | E34–E36 + §5.1 `auth.ts`。注意 `sync_status` 的 `unknown` 是**故障安全位**：同步失败不得推断为离职 |

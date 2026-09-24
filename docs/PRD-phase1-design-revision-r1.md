# MatterNest 第一期设计修订 R1 — 一致性修订（A1–A9 + C）

> 基线：《PRD 第一期完整设计交付物》（字段定义 / 状态机 / 规则引擎 / 原型 / ER）
> 范围：仅处理评审 A 组 9 项自相矛盾 + C 组关系冗余。**不含** B 组缺失模型的完整设计（权限、通知模板、附件鉴权细则等），B 组仅在此登记接口位。
> 用法：本文件每节标注「替换原文 X.Y」，可直接覆盖。未提及的章节维持不变。

---

## 0. 修订摘要

| 项 | 决策 | 影响章节 |
|---|---|---|
| A1 | 预置规则以配置数据 seed 落地；动作唯一性作用域由「全局」细化为「同触发域内」 | 3.3, 3.4, 3.5, 1.11, 5.2 |
| A2 | 状态改为配置驱动：案件状态可自定义，新增 `semantics` 语义锚点；**「已转案件」不进状态机**，改为事项表独立 `conversion_status smallint` | 1.12, 2.1, 2.2, 1.1, 3.5, 清单#2 |
| A3 | 取消 `status_config.default_node_template`；节点生成拆为「创建时预设」+「状态变更时规则」两条互斥路径 | 1.12, 2.1, 清单#3 |
| A4 | 预置规则「结案自动归档」默认**禁用**；「已结案」为可停留常态 | 3.5, 4.1, 清单#5 |
| A5 | `start_time` 改为可空 + `is_time_confirmed`；派生 `deadline_time` | 1.4, 2.4 |
| A6 | 当事人从「字段必填」降级为「动作校验」；字段表新增「校验时机」列 | 1.1, 1.2 及全部字段表 |
| A7 | 统一 `Attachment` 多态模型；`attachments` 数组字段全部改为反查 | 1.3, 1.5, 1.6, 1.7, 4.2 |
| A8 | 提醒单一来源 + 通知按事件聚合（`event_batch_id` / `dedupe_key`） | 1.4, 1.9, 3.5, 新增 3.7 |
| A9 | 删除 `node_type_config.default_remind_days` | 1.12 |
| C | 定调「**业务从属关系按宿主拆表，横切基础设施保持单一管线**」；消除三重表达；主键集合关系一律中间表 + 真外键，禁止内联数组 | 1.1, 1.2, 1.4, 5.1, 5.2 |

### 0.1 本轮已定基调（覆盖评审时的默认建议）

| 议题 | 决策 | 连带影响 |
|---|---|---|
| 案件/事项是否共用一张从属表 | **拆表，不集中在一个表**。节点/当事人/人员/标签各自成套 | 真外键生效；`host_type` discriminator 从这些表消失；1.12 节点类型的 `applicable_type` 列可删（拆表后由表名承担）；跨"案件或事项"的查询改为 UNION |
| 领域命名 | **不改名**：案件 = `Matter`，事项 = `RiskMatter`；但枚举值一律用全称 `risk_matter`，**禁止 `risk`**。原歧义来自 `{matter, risk}` 并列，拆表 + 全称后自然消解 | 零表名改动；见 §8.3 |
| 数据库 | **PostgreSQL 15+** | 部分唯一索引、`timestamptz`、`integer[]`/`jsonb`、`ON CONFLICT` 序号生成器，见 §12 |
| 案例模块 | **`case_study` 移出第一期**（清单#10 → 第二期） | 删 1.3 字段表、2.3 状态机、`TargetType` 的 case_study 行、§12.5 中文分词整节 |
| 组织维度 | **第一期不引入部门/组织**，权限仅「用户 + 角色」 | 权限草案 v3；`dept_id` 一类占位列一律不留 |
| 「已转案件」表达方式 | **不占状态位**，事项表加 `conversion_status smallint` | 状态机保持案件/事项同构 4 态；规则 7 改用 `event_occurred`；`event_occurred` 从"扩展位"升为第一期必装，见 §3、§2.5 |
| MCP 授权页（4.5） | **移出第一期**，清单#13 改「第二期」 | 删 4.5 原型；外部"案例库服务"随之外移；CaseStudy 第一期只承载内部案例 |

---

## 1. 全局约定（新增，置于第一部分开头）

### 1.0.1 字段表列语义变更（A6）

「必填」列拆成两列，避免"字段可空"与"业务必须有"互相打架：

| 列 | 含义 | 取值 |
|---|---|---|
| 存储约束 | DDL 层 NOT NULL | `是` / `否` |
| 校验时机 | 业务校验发生点 | `保存时` / `提交动作时:<动作>` / `不校验` |

同一张表所有字段默认继承表级校验时机，仅例外项单独标注。

### 1.0.2 拆表边界与视图/存储分层（C，本修订的主规则）

> **业务从属关系按宿主拆表，各自带真外键；横切基础设施保持单一管线。字段定义表描述 API 契约，ER 描述存储，任何集合关系在存储层只有一份。**

**分界线（本轮决策："拆表处理，不要集中在一个表"）：**

| 类别 | 处理 | 表 | 判据 |
|---|---|---|---|
| 宿主主表 | 各自一张 | `matter`、`risk_matter`（`case_study` 随案例移出第一期） | 字段集本就不同 |
| 业务从属关系 | **按宿主拆表，真外键** | `matter_node`/`risk_matter_node`、`matter_party`/`risk_matter_party`、`matter_staff`/`risk_matter_staff`、`matter_tag`/`risk_matter_tag`、`party_tag` | 只在单个宿主详情页内读写，无跨宿主聚合需求 |
| 横切基础设施 | **保持单一管线** | `comment`、`activity_log`、`attachment`、`custom_reminder`、`notification_event`、`notification_delivery`、`user_watch` | 产品要求跨宿主统一：4.6 关注 feed 混合 AJ-/FX- 按时间倒序；审计与附件鉴权管线必须统一，拆表会在每处查询长出 UNION 与两套签名逻辑 |
| 关系表 | 一张 | `risk_matter_case` | 本身就是两个宿主之间的桥 |

拆表收益（写进文档，避免有人再去"抽公共基类"）：
- `matter_node.matter_id` 等列可建真 `FOREIGN KEY`，孤儿行由数据库挡住，不再只靠应用层校验（原评审对多态关联的顾虑即此项）。删除策略按表分级，见 §12.4。
- `matter_node` / `risk_matter_node` 不再有 `matter_type` 列 → **原 1.4 的多态字段删除**。
- 1.12 节点类型配置的 `applicable_type` 三值枚举（案件/风险/通用）**收敛为 `host_type` 二值**（`matter` / `risk_matter`）。"通用"不再是一个取值，而是在两张宿主下各存一行——因为运行时表已拆开，一行配置无法同时喂两张表。seed 需按此展开。
- 代价：任何"案件或事项一起查"必须显式 `UNION ALL`。第一期此类需求只有 4.6 关注 feed 一处，且它走横切表，不受影响。
- **禁止**为覆盖两者而引入泛化抽象（`AbstractMatter` / `LegalEntity` / 统一 `host_id` 视图）。API 层同理：`/matters/{id}` 与 `/risk-matters/{id}` 两套路径，不做 `/hosts/{type}/{id}`。

**内联数组的处理**（原 `party_ids` / `tag_ids` / `related_matter_ids` / `co_owner_ids` / `follower_ids` / `party_roles` / `attachments` / `case_id`）：
- 主表内联 JSON 数组列**全部禁止**。
- 字段表中保留 `xxx_ids 数组` 写法，但必须标注身份：`[input]` = 写入入参，服务端拆解为中间表行；`[derived]` = 读取时反查装配，只读不可写。
- 允许的受控冗余仅两处，均标 `[derived]` 且由状态变更服务单点写入：`is_archived`（供部分索引）、`matter_staff(staff_role=owner)` 对应主表 `owner_id`（数据范围计算的最高频条件，见 §8.1）。

**统一 `TargetType` 登记表**（横切表专用；值一律全称，禁止 `risk` 这类简称）：

| TargetType | 可挂评论 | 可挂日志 | 可挂提醒 | 可挂附件 | 可被关注 |
|---|---|---|---|---|---|
| `risk_matter` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `matter`（案件） | ✅ | ✅ | ✅ | ✅ | ✅ |
| `matter_node` / `risk_matter_node` | ❌ | ✅ | ❌ | ✅ | ❌ |
| `matter_progress` / `matter_expense` | ❌ | ✅ | ❌ | ✅ | ❌ |

> `case_study` 行随案例模块移出第一期而删除；第二期恢复案例时连同其可见性规则一并回补。

> 节点不支持评论与提醒是第一期有意的收敛（评论统一挂在案件/事项层，通过 `related_node_id` 弱引用定位；提醒统一由 `node.remind_days` 扫描产生，不走 `custom_reminder`）。
> 节点类型**配置表不拆**：保留一张 `node_type_config` + `host_type` 列，因为后台需要在同一页面统一维护；被拆的是**运行时表**（`matter_node` / `risk_matter_node`）。两者的 `node_type_id` 各自外键到 `node_type_config`，由 `host_type` 条件约束可选范围。

---

## 2. A1 — 自动化规则唯一性作用域 + 预置配置

### 2.1 替换原文 3.3「动作白名单与唯一性」

原「全局唯一」不成立：5 种动作最多支撑 5 条启用规则，而预置清单需要 7 条同时在线（其中「发送通知」被 4 条规则使用）。改为按**触发域**判定：

> **动作唯一性：在同一触发域（`scope_key`）内，同一 `action_type` 至多一条启用规则。**

`scope_key` 由触发条件规范化生成，**不含动作**：

```
scope_key = sha1_12(
    trigger_type
  + trigger_target_type            // matter | risk_matter | matter_node
  + normalized(trigger_config)     // 键排序、值取 code 而非 id、去空白
)
```

规则表新增两列：

| 字段 | 类型 | 存储约束 | 说明 |
|---|---|---|---|
| scope_key | varchar(32) | 是 | 保存时由服务端计算，不可手改 |
| is_system | boolean | 是 | 预置规则为 true：可停用、可调参，不可删、不可改 trigger |
| host_type | 枚举 | 是 | `matter` / `risk_matter` / `all`，声明规则作用于哪类宿主（取代原文 `target_scope`；拆表后该列只出现在规则表，不出现在被拆的从属表） |
| trigger_target_type | 枚举 | 是 | `matter` / `risk_matter` / `matter_node` / `risk_matter_node`，声明触发实体 |
| last_run_at | timestamptz | 否 | 排障与幂等辅助 |
| created_by / updated_by | bigint | 是 / 否 | 原文缺失，补上 |

唯一约束（PostgreSQL 原生 partial unique index，无需生成列绕过）：

```sql
CREATE UNIQUE INDEX ux_rule_enabled_action
  ON automation_rule (scope_key, action_type)
  WHERE is_enabled;          -- 停用规则不占位，可随时回滚
```

`scope_key` 是 `trigger_type + trigger_target_type + normalized(trigger_config)` 的 12 位摘要，**不含动作**，因此"同域不同动作"天然允许并存。归一化函数必须稳定（键序、值取 code 而非 id、去空白），并配套单测用例，否则唯一约束会漂移。

### 2.2 替换原文 3.4「冲突检测」

- **配置时**：选定 `trigger_*` + `action_type` 后即时计算 scope_key，命中唯一索引则提示
  「触发条件与规则【XX】同域，且动作均为『发送通知』。同域同动作只能启用一条，请修改触发条件或禁用原规则。」
- **停启用时**：启用一条与既有启用规则冲突的规则 → 直接拒绝，给「禁用原规则并启用本条」一键操作。
- **运行时**：动作执行前二次校验（并发兜底），冲突则跳过并写 `AUTO_RULE_SKIPPED`（原文只有"告警"，未定义告警去向，此处落日志）。
- **状态被停用时**：若该状态被任一启用规则的 `trigger_config` 引用 → 阻止停用并列出规则名。

### 2.3 预置规则 seed（A1/A2/A4/A8 合并结果）

7 条预置规则在**当前配置下均可同时启用**（动作唯一性按域判定，已复核）：

| # | 规则名 | host_type | trigger_type | trigger_target | trigger_config | action | action_config | priority | 默认启用 | 唯一性域复核 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 结案自动归档 | all | `status_changed` | 宿主 | `{status_code:"closed"}` | `archive` | `{}` | 10 | **否** | 与规则 2 同域、动作不同 → 允许 |
| 2 | 结案通知关注人 | all | `status_changed` | 宿主 | `{status_code:"closed"}` | `notify` | `{receivers:["follower"],template:"case_closed"}` | 20 | 是 | 同上 |
| 3 | 进入进行中创建节点 | all | `status_changed` | 宿主 | `{status_code:"in_progress"}` | `create_node` | `{template_code:"matter_in_progress"}` | 10 | 是 | 独立域 |
| 4 | 长期未更新提醒 | all | `time_no_progress` | 宿主 | `{days:30}` | `notify` | `{receivers:["owner"],template:"stale_30d",once_per_target:true,cooldown_days:30}` | 10 | 是 | 独立域 |
| 5 | 节点开始提醒 | all | `node_before_start` | 节点表 | `{days:3}` | `notify` | `{receivers:["owner","follower"],template:"node_start"}` | 10 | 是 | 独立域；实现内同时扫两张节点表 |
| 6 | 节点截止提醒 | all | `node_before_end` | 节点表 | `{days:3}` | `notify` | `{receivers:["owner","follower"],template:"node_end"}` | 20 | 是 | 独立域；同上 |
| 7 | 转案件后归档 | risk_matter | **`event_occurred`** | 宿主 | `{event:"risk_converted"}` | `archive` | `{}` | 10 | 是 | 触发类型不同 → 与规则 1 天然不同域 |

规则 7 的触发条件按本轮决策改写：**不再依赖「已转案件」状态**，改由 `risk_matter_case` 写入成功后发出的 `risk_converted` 领域事件触发（见 §3.2）。代价是 `event_occurred` 从"扩展位"升为**第一期必装触发类型**——原文 3.2 的"事件发生"这一类由此落地，`trigger_config` 需增 `event` 枚举（第一期仅 `risk_converted` 一个值）。

规则 5/6 的扫描器跨 `matter_node` + `risk_matter_node` 两张表：在动作实现内 `UNION ALL`，**不**为规则引入跨宿主统一节点视图。

规则 4 的 `once_per_target + cooldown_days` 是必填项，否则 cron 重扫造成提醒风暴（见 §7.2）。

`trigger_type` 枚举闭合为：`status_changed` / `time_no_progress` / `node_before_start` / `node_before_end` / `event_occurred`。

### 2.4 预置的自动化相关配置（A1 后半）

| seed 类别 | 内容 |
|---|---|
| 通知模板 | `case_closed`、`case_archived`、`node_start`、`node_end`、`stale_30d`、`mention`、`comment_new`（7 条；「转案件归档」无独立模板，复用 `case_archived`。表结构见 §7.2） |
| 节点模板 | `matter_in_progress`（举证/开庭/判决）、`risk_matter_default`（受理/核查/反馈，对应清单#3「事项默认 3 个」） |
| 状态配置 | 案件 4 + 事项 4，**同构**（转案件不再占状态位），见 §3 |
| 节点类型 | 立案/举证/开庭/判决/调解/核查/反馈，按 `host_type` 分列（后台统一页维护） |
| 费用项目 | 诉讼费/律师费/鉴定费/公证费/差旅费 |
| 风险等级 | 高/中/低 |
| 标签 | 紧急/大额/涉外/集团客户（示例，可改） |

规则引用的都是 `code` / `template_code` 而非雪花 id，保证 seed 可跨环境重放。

### 2.5 规则引擎能力边界（必须在文档里写明，否则实现会分歧）

第一期**不实现**通用规则引擎，而是「5 种内置动作 + 可配参数 + 可配启停 + 可新建同结构规则」：

- `extra_condition` 第一期只支持字段级 AND 比较，操作符 `eq / ne / in / not_in / is_empty / gt / lt`，字段白名单：`level`,`case_type`,`procedure`,`owner_id`,`tag_ids`,`amount`,`source`。**不支持** OR / 嵌套 / 子查询 / 聚合。
- 因此规则 4「30 天无更新」的比较逻辑（近 30 天无 ActivityLog 中的实质进展）是**动作实现内置的**，不通过 `extra_condition` 表达。原文档未区分，是 D2 的根因。
- 「用户自由组合新触发类型」不在第一期范围。新建规则只能在上述 5 个 `trigger_type` 内选参数。

---

## 3. A2 — 状态改为配置驱动

### 3.1 替换原文 1.12「案件/风险状态配置」

原「固定 4 个，不可增删」改为：**状态由配置表驱动，案件状态可自定义；事项使用默认 4 态、不开放配置入口**。

| 字段 | 类型 | 存储约束 | 默认 | 说明 |
|---|---|---|---|---|
| id | bigint | 是 | 自动 | |
| code | varchar(32) | 是 | — | 语义标识，seed 与规则引用它；创建后不可改 |
| name | varchar(50) | 是 | — | 展示名，可改 |
| color | varchar(20) | 是 | — | |
| host_type | 枚举 | 是 | — | `matter` / `risk_matter` |
| **semantics** | 枚举 | 是 | — | 见下表，**必填，决定系统行为** |
| is_system | boolean | 是 | false | true = seed 内置，可改名/改色/排序，不可删 |
| is_archive_status | boolean | 是 | false | 由 `semantics='archived'` 推导，只读生成列 |
| is_initial_status | boolean | 是 | false | 新建默认态，每 host_type 恰好一个 |
| next_status_codes | text[] | 否 | `'{}'` | 推荐后继；空 = 不限制 |
| sort_order | integer | 是 | 0 | 列表与推荐路径展示序 |
| is_enabled | boolean | 是 | true | 停用后不可人工选择，但历史数据保留 |

`semantics` 枚举（这是自定义状态能安全落地的关键——没有语义锚点，"可自定义状态"会让归档逻辑、推荐路径、规则引用全部失据）：

| semantics | 系统行为 | 每 host_type 数量约束 |
|---|---|---|
| `open` | 新建初始态 | 1 |
| `in_progress` | 计入"活跃"，可被规则 3 命中 | ≥1 |
| `closed` | 视为结案，`closing_date` 自动写入 | ≤1 |
| `archived` | 触发归档：只读 + 列表默认隐藏 | 恰好 1 |
| `custom` | 纯展示与筛选，无系统行为 | 任意 |

自定义状态（`semantics=custom`）示例：`mediation`（调解中）、`suspended`（中止）。它们不影响任何自动化。

条件唯一索引：

```sql
CREATE UNIQUE INDEX ux_status_initial ON status_config (host_type) WHERE is_initial_status;
CREATE UNIQUE INDEX ux_status_archived ON status_config (host_type) WHERE semantics = 'archived';
CREATE UNIQUE INDEX ux_status_closed   ON status_config (host_type) WHERE semantics = 'closed';
CREATE UNIQUE INDEX ux_status_code     ON status_config (host_type, code);
```

> 删除 `default_node_template` 字段 — 见 §4 A3。
> **`semantics` 中不设 `converted`**：转案件不占状态位，见 §3.4。

### 3.2 seed 状态集

| host_type | code | name | semantics | is_system | 备注 |
|---|---|---|---|---|---|
| matter | pending | 待受理 | open | ✅ | is_initial |
| matter | in_progress | 进行中 | in_progress | ✅ | |
| matter | closed | 已结案 | closed | ✅ | |
| matter | archived | 已归档 | archived | ✅ | |
| risk_matter | pending | 待受理 | open | ✅ | is_initial |
| risk_matter | in_progress | 进行中 | in_progress | ✅ | |
| risk_matter | closed | 已结案 | closed | ✅ | |
| risk_matter | archived | 已归档 | archived | ✅ | |

**A2 的根因与解法（本轮已定）**：规则 7 引用了不存在的「已转案件」。曾考虑把它补成事项第 5 态，但**状态位是互斥的**——"已转案件"与"已结案"是两个正交事实（转案件后事项可能仍在进行中，也可能结案后才补记转过案件），挤在同一条 status 链上会让「转案件 → 已结案」这类正常流转被状态推荐路径挡掉。故改为事项表上一个独立小整型（§3.4），状态集保持与案件**同构 4 态**，规则 7 改由领域事件触发。

代价与补偿：事项列表筛"已转案件"从 `status=?` 变为 `conversion_status=1`（同样走 btree 索引，性能无差）；详情页把"已转案件"渲染为**状态之外的第二个徽标**而非状态标签——这本身是更准确的业务表达。

### 3.3 替换原文 2.1 / 2.2 状态机

原文两张图与"允许任意状态间跳转"并置后不具约束力。改写为一条规则 + 一张推荐路径表，**不再称"状态机"**（避免开发去实现 `allowed_transitions` 硬校验）：

```
状态模型：软推荐路径 + 偏离可解释

1. 状态集合来自 status_config（按 host_type 取），任意启用状态之间均可人工跳转。
2. 推荐路径 = 按 sort_order 串联 semantics 序列；案件与事项同构：
     open → in_progress → closed → archived
3. 偏离判定：目标状态 ∉ 当前状态的 next_status_codes
   → 弹出二次确认，「变更原因」必填，写入 activity_log.reason。
   → next_status_codes 为空时视为不限制，但跳转至 archived 恒需确认。
4. archived 为终态且不可人工离开；唯一例外：管理员「撤销归档」，需原因，写日志。
5. 归档生效方式：状态变更为 archived 的那一刻起，记录转只读、列表默认隐藏。
   （即"归档动作即时生效"，不隐含"结案即归档"——后者是规则 1，默认关闭，见 §5 A4）
6. 转案件不是状态。它与 status 正交，见 §3.4。
```

事项与案件的关系：状态集**同构**（原文 2.2「与案件完全一致，共用同一套状态」这一定性成立），差异仅在事项多一个 `conversion_status` 维度，且事项不开放自定义状态入口。

### 3.4 新增 `risk_matter.conversion_status`（A2 落地位）

| 字段 | 类型 | 存储约束 | 默认 | 说明 |
|---|---|---|---|---|
| conversion_status | smallint | 是 | 0 | 0=未转案件，1=已转案件。**不复用 status，不建枚举表** |
| converted_at | timestamptz | 否 | null | 首次转案件成功时间 |
| converted_by | bigint | 否 | null | 操作人 |
| converted_case_count | integer | 是 | 0 | `[derived]` = `risk_matter_case` 行数，列表徽标"已转 2 个案件"用，避免每行 count |

写入与约束：

- 唯一写入口 = 「转案件确认」服务方法，在同一事务内置 1、写 `converted_at/by`、刷 `converted_case_count`、发 `risk_converted` 事件。
- **不允许人工设置或回滚为 0**：若需撤销，只能删除 `risk_matter_case` 关联行，且仅当目标案件尚未产生进展/费用/节点时允许（否则只允许"保留关联 + 备注"）。此规则原文完全未定义，必须补——否则会出现"事项显示已转案件但关联已被清空"。
- 索引：`CREATE INDEX ix_risk_conv ON risk_matter (conversion_status, updated_at DESC) WHERE NOT is_deleted;`
- 展示：详情页与列表以独立徽标呈现，文案「已转案件」，点击跳关联案件列表。
- 规则 7 的触发即监听本字段 `0 → 1` 这一次变更。

### 3.5 连带修正

- 原文 2.4 节点生命周期图缺「已取消」方框，且未定义能否恢复。补全：

```
未开始 ──到 start_time 且 is_time_confirmed──▶ 进行中 ──人工完成──▶ 已完成
   │                                              │
   └────────────人工取消──────────────────────────┘──▶ 已取消
                                                       │
                                            仅「未开始→已取消」可人工恢复
                                            「进行中→已取消」不可恢复，需新建节点
```

- 已归档记录：`activity_log` 不再新增（评论/附件/提醒同步只读）；例外是「撤销归档」本身。此条原文未定义，补上。
- 清单#2 措辞由「4 个固定，案件/事项共用」改为「状态配置驱动、案件可自定义；案件与事项状态同构 4 态；转案件用独立 `conversion_status`，不占状态位」。
- 生命周期对 `matter_node` 与 `risk_matter_node` 两张表同时成立，状态枚举值一致（配置表不拆，见 §1.0.2）。

---

## 4. A3 — 取消 `default_node_template`，节点生成拆为两条互斥路径

原设计里"进入状态时创建节点"有两套机制（1.12 状态配置 + 3.5 规则 3），会创建两遍。

**处理**：从 `status_config` 删除 `default_node_template`。节点生成只保留两条**时机不同、互斥**的路径：

| 路径 | 时机 | 载体 | 第一期用途 |
|---|---|---|---|
| P1 创建时预设 | 新建事项/案件 | `node_type_config.preset_on_create` | 清单#3「事项默认 3 个节点」 |
| P2 状态变更时规则 | 状态变更后 | `automation_rule` 规则 3 | 案件进入进行中→举证/开庭/判决 |

`node_type_config`（**不拆表**，后台单页维护）新增/变更列（同时按 A9 删除 `default_remind_days`）：

| 字段 | 类型 | 存储约束 | 默认 | 说明 |
|---|---|---|---|---|
| code | varchar(32) | 是 | — | 供模板与规则引用；同 host_type 内唯一 |
| name | varchar(50) | 是 | — | |
| **host_type** | 枚举 | 是 | — | `matter` / `risk_matter`，取代原 `applicable_type` 三值；"通用"改为两张宿主各一行 |
| time_type | 枚举 | 是 | 时间点 | 时间点 / 时间段 |
| **preset_on_create** | boolean | 是 | false | P1 开关 |
| **template_code** | varchar(32) | 否 | null | P2 归组码，规则 3 按它批量取模板节点 |
| sort_order | integer | 是 | 0 | P1 生成顺序 |
| is_enabled | boolean | 是 | true | |

P1 生成规则：宿主创建成功 → 取 `is_enabled AND host_type = 宿主类型 AND preset_on_create` 按 `sort_order` 实例化到对应节点表，`start_time` 留 null、`is_time_confirmed=false`。事项默认 3 个即由 seed 的 3 行承载，无需新增配置表。

**提醒默认值来源（A9 连带）**：删除 `default_remind_days` 后，`node.remind_days` 的默认 `{7,3,1}` 由服务端常量给出，不再可按节点类型差异化。第一期把该列从 `jsonb` 改为 **`integer[]`**（`remind_days integer[] NOT NULL DEFAULT '{7,3,1}'`），扫描器直接展开，不再解析 JSON。若后续需要按类型差异化，第二期引入独立 `remind_policy_config` 表，**不要**再往 `node_type_config` 上加 JSON 列。

---

## 5. A4 — 「已结案」为可停留常态

- 预置规则 1「结案自动归档」**默认 `is_enabled=false`**，seed 中显式标注；配置页作为"推荐开启"提示，不自动生效。
- 因此「已结案 → 已归档」是人工动作（或由管理员启用规则 1 后自动化），「已结案」可长期停留，4.1 列表页 `AJ-002 已结案` 的原型成立。
- 副作用需在 UI 说明：结案后不归档，案件仍出现在默认列表（仅按 `status` 筛选区分）。原文「已归档=列表隐藏」不受影响。
- 需配套补一个入口：4.1 筛选区新增「包含已归档」开关（默认关），否则归档数据不可寻回。
- 清单#5 措辞澄清：「归档立即执行」指**归档动作本身即时生效**，不指「结案即归档」。

---

## 6. A5 + A6 — 字段表修订（替换原文 1.1 / 1.2 / 1.4 对应行）

### 6.1 1.4 MatterNode → 拆为 `matter_node` + `risk_matter_node`（A5 + C）

原文一张多态 `MatterNode` 按拆表决策一分为二，**两表结构完全同构**，差异只在 FK 目标与 `node_type_id` 的可选范围。以下列变更对两张表同时生效；删除原 `matter_id` + `matter_type` 多态列，改为真外键。

| 字段 | 类型（PG） | 存储约束 | 默认 | 校验/说明 |
|---|---|---|---|---|
| matter_id / risk_matter_id | bigint | **是** | — | `REFERENCES matter(id) ON DELETE RESTRICT` / 同构（删除策略见 §12.4）；不再有 `matter_type` discriminator 列 |
| node_type_id | bigint | 是 | — | FK → `node_type_config(id)`，应用层再加 `host_type` 匹配校验 |
| start_time | timestamptz | **否** | null | 可空 = 时间待定；空或 `is_time_confirmed=false` 时不参与提醒扫描、不自动转进行中 |
| end_time | timestamptz | 否 | null | `time_type=时间段` 且 `is_time_confirmed=true` 时必填，且 ≥ start_time |
| **is_time_confirmed** | boolean | 是 | false | 时间是否已确认；4.2 原型「判决 待定」即 `false` |
| **deadline_time** | timestamptz | 是 | 生成列 | `GENERATED ALWAYS AS (COALESCE(end_time, start_time)) STORED`（时间段取 end，时间点取 start）；用于排序与临期筛选 |
| **remind_days** | integer[] | 否 | `'{7,3,1}'` | 提醒唯一配置入口（A8/A9 后无第二处）；由 jsonb 改为数组，扫描器直接 `unnest` |
| status | 枚举 | 是 | 未开始 | 未开始/进行中/已完成/已取消 |
| completed_at / completed_by | timestamptz / bigint | 否 | null | 新增，闭环节点完成口径 |
| cancel_reason | varchar(200) | 否 | null | 新增，`status='cancelled'` 时必填 |
| source_kind | 枚举 | 是 | manual | `manual` / `preset_p1` / `rule_p2`，新增，标明节点从哪条路径来 |
| source_ref | varchar(64) | 否 | null | P2 时存 `rule_id`，便于规则回滚批量清理 |

配套索引（两张节点表各建一份）：

```sql
-- 提醒扫描：跨宿主按期限全局扫，原设计 (matter_id, start_time) 两个单列会走全表
CREATE INDEX ix_node_scan ON matter_node (status, deadline_time)
  WHERE is_time_confirmed AND status IN ('not_started','in_progress');
CREATE INDEX ix_node_host ON matter_node (matter_id, sort_order);
```

`deadline_time` 用 `COALESCE(end_time, start_time)` 而非条件表达式，避免 `time_type` 与两列的一致性校验漏洞；写库时仍校验"时间段必须同时有 start/end"。生成列需 `STORED` 才能进索引（PG 的 `VIRTUAL` 不支持表达式索引）。

### 6.2 1.2 Matter / 1.1 RiskMatter 当事人（A6）

| 字段 | 原 | 修订后 |
|---|---|---|
| 案件 `party_ids` | 必填=是，默认 `[]`，说明"至少 1 个" | 存储层无此列，`[input]` 数组写入 `matter_party`；校验时机 = `提交动作时:创建案件 / 转案件确认`，≥1 行；创建后不得清空至 0 |
| 事项 `party_ids` | 否 | `[input]` 数组写入 `risk_matter_party`；校验时机 = `不校验` |

`party_roles` JSON 列**删除**，角色落到中间表列（`matter_party.role` / `risk_matter_party.role`，见 §8.1）——一个案件里我方可能同时是本诉原告、反诉被告，案件级单值 `litigation_role` 承载不了；`litigation_role` 保留为"案件主诉地位"的概览字段，详情页展示以 `matter_party.role` 为准。

### 6.3 其余字段表补漏（顺手修，属 A 组证据链）

| 位置 | 补充 |
|---|---|
| 1.1 / 1.2 / 1.3 / 1.10 | `updated_by`、`is_deleted boolean NOT NULL DEFAULT false`、`deleted_at timestamptz`（软删语义见 §10 B 组待办，先占位；所有列表索引统一带 `WHERE NOT is_deleted`） |
| 1.1 风险事项 | **新增 `conversion_status smallint`（§3.4）**、`converted_at`、`converted_by`、`converted_case_count`；`archived_at`、`archived_by`；`amount` 语义定名「涉案金额（预估，非损失口径）」，类型 `numeric(18,2)`；补 `currency char(3) DEFAULT 'CNY'` |
| 1.2 案件 | `amount` 语义「标的额」+ `currency`；`last_progress_at`（§6.4）；**删除 `source_risk_id` 与 `case_id`**（前者由 `risk_matter_case` 反查；后者随案例模块移出第一期） |
| 1.2 `case_no` | 明确唯一性：**非唯一索引 + 保存时提示重复**（不同法院案号体系可重号），`internal_code` 才是唯一锚点 `UNIQUE`。原文 5.2 写"查重"但未定义阻止还是提示 |
| 1.2 `procedure` | "一审/二审/再审/仲裁/执行等" 的"等"必须替换为闭集白名单，第一期：一审/二审/再审审查/再审/仲裁/执行/执行异议/破产/其他 |
| 1.5 `MatterProgress` | 保持**案件专属**（拆表决策下不给事项加 `risk_matter_progress`，第一期事项无进展沉淀入口，需在文档明示）；`progress_type` 枚举闭合：日常推进/法院动作/对方动作/客户反馈/内部决议/材料提交；`node_id` 改为真 FK → `matter_node(id)` 可空；补 `next_plan`、`updated_at`、`is_deleted` |
| 1.6 `MatterExpense` | 同为案件专属；`status` 枚举闭合：`pending_pay`/`paid`/`void`（第一期无审批，不含 approved）；`amount` → `numeric(18,2) CHECK (amount >= 0)`；补 `currency`、`payer_id`、`updated_at`；详情页展示 `SUM(amount)` 合计（属明细统计，不违反清单#14「不做报表」） |
| 1.7 `Comment` | 补 `attachment_ids [derived]`（→ `attachment` 横切表）、`updated_at`、`is_edited`、`deleted_by`、`deleted_at`；`parent_id` 限制**最多 1 层嵌套**（`CHECK parent_id IS NULL OR (SELECT ...) IS NOT NULL` 由服务层保证，DB 侧加 `idx_parent`） |
| 1.8 `ActivityLog` | 新增 `reason varchar(500)`（A2 偏离确认原因）；`action` 枚举闭合表待补（B6）；补 `matter_id` / `risk_matter_id` 双列（其一非空，`CHECK` 约束）以支撑"我的关注"与"我相关活动"的跨目标 feed |
| 1.9 `CustomReminder` | `is_sent` 单布尔无法支撑 `repeat_type` → 替换为 `status 枚举(pending/sent/cancelled/failed)` + `next_remind_time` + `sent_at` + `failure_reason`；`remind_channels` 统一到 §7.2 的 `notify_channel`；投递明细落 `notification_delivery`，不放本表 |
| 1.10 `Party` | `type` 改为存储约束=是（自然人/法人/非法人组织，决定 `id_number` 校验规则）；`id_number`/`phone`/`address` 标注**加密存储 + 默认脱敏展示**，另存 `id_number_hash char(64)` 做精确查重索引（细则属 B7）；补 `created_by`、`is_deleted` |

### 6.4 `last_progress_at`（新增，规则 4 的正确性依赖它）

`AutomationRule` 规则 4「30 天无更新」原用 `updated_at` 判断，会被自动化改字段、节点自动转进行中、系统回写等**非人工动作**污染，导致规则永不触发或每轮都触发。

- `matter.last_progress_at` / `risk_matter.last_progress_at`：`[derived]`，仅在人工提交进展、变更状态、新增评论时刷新；系统写入（`operator=SYSTEM`）与纯字段编辑不刷新。
- 规则 4 的判定改为 `now - last_progress_at > 30d AND status ∉ {archived}`。

---

## 7. A7 + A8 + A9 — 附件与通知聚合

### 7.1 新增 `attachment`（A7，替换 1.3/1.5/1.6/1.7 的 `attachments` 数组列）

附件属**横切基础设施**，按 §1.0.2 分界线保持单表管线，不按宿主拆表（否则签名 URL 签发、病毒扫描、留存策略要各写一份）。

| 字段 | 类型（PG） | 存储约束 | 说明 |
|---|---|---|---|
| id | bigint | 是 | |
| owner_type | varchar(32) | 是 | `TargetType`，见 §1.0.2 |
| owner_id | bigint | 是 | 多态，无 DB 外键，应用层校验；宿主删除时由服务层清理 |
| file_name | varchar(255) | 是 | 原始名，展示用 |
| storage_key | varchar(255) | 是 | 不可猜测的对象键，**不含业务含义**，禁止用原始名；`UNIQUE` |
| mime_type | varchar(128) | 是 | 服务端按白名单校验，不信客户端声明 |
| size_bytes | bigint | 是 | |
| checksum_sha256 | bytea | 是 | `char(64)` 亦可；用于秒传去重与完整性校验 |
| category | 枚举 | 否 | 证据/起诉状/判决/合同/其他（第一期枚举，不做配置表） |
| related_node_id | bigint | 否 | 弱引用，用于"该节点的材料"视图；因节点已拆表，需配 `related_node_type ∈ {matter_node, risk_matter_node}` 才能定位 |
| uploaded_by / uploaded_at / is_deleted / deleted_at | bigint / timestamptz / boolean | 是 | |

索引：`CREATE INDEX ix_attach_owner ON attachment (owner_type, owner_id) WHERE NOT is_deleted;`

约定：
- 字段表中的 `attachments` / `attachment_ids` 一律标注 `[input]`（写入）或 `[derived]`（读取），主表不再有数组/JSON 列。
- 下载走短期签名 URL，签发时按权限草案 §7.3 逐条判定宿主可见性；上传白名单：pdf/doc/docx/xls/xlsx/png/jpg/jpeg/zip，单文件 ≤50MB，单宿主 ≤100 个。
- **上传改走预签名 PUT 直传对象存储**（技术选型 §12.2 C3）：客户端向服务端申请 PUT URL 直传 MinIO，服务端只登记元数据、事后异步校验 hash，不中转文件流。依据是核验发现 Nitro/h3 的 `readMultipartFormData` 会把整个文件缓冲进内存，且框架层无 body size 上限。
- 宿主转 `archived` 后附件只读、不可删；`is_deleted` 保留对象以便审计追溯，物理清理由 B 组定义。
- 案件详情页 Tab 增加「附件」（原文 4.2 缺，判决书/合同原件此前无处上传，只能塞进进展）。

### 7.2 通知按事件聚合（A8）

**问题**：一次业务操作（转案件、状态变更）可命中多条规则；同一用户可同时是负责人+关注人+被 @；节点自身 `remind_days` 与规则 5/6 时间窗重叠。原设计会产生成倍重复推送。

**三层拆分**（三张表均为横切管线，不拆）：

```
业务动作 (event_batch_id)
   │  同一次操作内所有规则/提醒命中共用一个 batch_id，透传至下游
   ▼
notification_event    事件层：聚合后"该发的一条消息"
   ▼
notification_delivery 投递层：按 (event × user × channel) 一行，各自重试
```

`notification_event`：

| 字段 | 类型（PG） | 说明 |
|---|---|---|
| dedupe_key | varchar(120) | 聚合键，见下；`UNIQUE` |
| event_batch_id | uuid | 一次业务操作；同批只合并"完全同键"事件 |
| event_type | 枚举 | `status_changed`/`node_due_start`/`node_due_end`/`stale_30d`/`mention`/`new_comment`/`risk_converted`/`expense_added` |
| source_type | 枚举 | `node_remind` / `custom_reminder` / `auto_rule` |
| source_rule_id | bigint | 否 | 排障回溯 |
| target_type / target_id | varchar(32) / bigint | 指向业务对象 |
| host_id | bigint | 冗余的宿主 id，供 feed 一跳取"所属案件/事项" |
| title / body | varchar(200) / text | 模板渲染结果 |
| payload | jsonb | 结构化上下文，前端渲染用；**唯一保留 jsonb 的场景之一** |
| window_start / window_end | timestamptz | 聚合窗口，定时类为扫描批次边界 |
| recipient_count / merge_count | integer | `merge_count` = 被本事件吸收掉的原始条数，排障用 |
| created_at | timestamptz | |

`dedupe_key`（决定"算一条"的粒度）：

```
immediate 类: event_type + ":" + target_id + ":" + event_batch_id + ":" + sorted(recipients).hash
scheduled 类: event_type + ":" + target_id + ":" + date_key(扫描日期)
              ↑ 同一节点同一天的多条提前提醒 → 合并为 1 条
```

**合并规则**：
1. 同一 `event_batch_id` 内，同一收件人只出 1 条事件（转案件不再分别发"归档+通知+节点"三条）。
2. 命中角色重叠（owner ∩ follower ∩ mention）→ 收件人集合去重到 user 级。
3. 同宿主同类型的定时提醒，一天内合并一次（规则 5 的 3 天 + `remind_days` 含 3 → 一条）。
4. **来源标记**：节点提醒以 `node.remind_days` 为唯一展开源，规则 5/6 命中同一 `(node, date)` 时 `dedupe_key` 相同 → 由 `INSERT ... ON CONFLICT (dedupe_key) DO NOTHING` 天然吸收，不重复。这是 A8/A9 的收口点，**去重靠数据库唯一键，不靠应用层判重**。
5. `once_per_target` + `cooldown_days` 命中已存在事件时跳过（规则 4 依赖）。
6. 规则 5/6 的扫描器跨 `matter_node` + `risk_matter_node`：两条 SQL 各扫自己表的 `ix_node_scan`，结果并集后进同一聚合管道。

`notification_delivery`：`event_id, user_id, channel notify_channel, status(pending/sent/failed/void), attempt, next_retry_at, sent_at, error varchar, is_read boolean DEFAULT false, read_at timestamptz`；索引 `(user_id, is_read, created_at DESC)` 支撑 4.6「未读更新：3」。渠道枚举第一期 = `in_app` + `email`（企微/钉钉留扩展位）。
原文 1.9 `CustomReminder.remind_channels` 引用了未定义的渠道枚举，现统一到 `notify_channel[]`（PG 数组，B6 登记表的一条）。

**待办（B5 承接）**：`NotificationTemplate(code, event_type, channel, title_tpl, body_tpl, is_enabled)` 的表结构第一期需实现（规则 seed 依赖它），文案定稿属 B5。
`is_read` 落在 Delivery 行上，支撑 4.6「未读更新：3」。

---

## 8. C — 关系单一存储源

### 8.1 存储层最终表（替换原文 5.1 相应部分）

**按宿主拆表**（业务从属关系，全部带真外键）：

| 表 | 关键列 | 取代的内联字段 |
|---|---|---|
| `matter_node` / `risk_matter_node` | `matter_id`/`risk_matter_id` FK（RESTRICT，见 §12.4）、`node_type_id` FK、§6.1 全列 | 原 1.4 `matter_id`+`matter_type` 多态 |
| `matter_tag` / `risk_matter_tag` | (owner_id, tag_id) UK，各自 FK | 1.1/1.2 `tag_ids` |
| `party_tag` | (party_id, tag_id) UK | 1.10 `tag_ids` |
| `matter_party` / `risk_matter_party` | (host_id, party_id, **role**, role_seq) UK，FK → 宿主与 `party` | 1.2 `party_ids` + `party_roles` JSON |
| `matter_staff` / `risk_matter_staff` | (host_id, user_id, **staff_role**) UK，FK 双向 | 1.1/1.2 `co_owner_ids`、`follower_ids` |

**横切单表**（统一管线，不拆）：

| 表 | 关键列 | 用途 |
|---|---|---|
| `risk_matter_case` | (risk_matter_id, matter_id) UK(matter_id)，`seq`、`converted_by`、`converted_at`，双向 FK | 取代 1.1 `related_matter_ids` + 1.2 `source_risk_id` |
| `user_watch` | (user_id, target_type, target_id) UK，`watch_type`、`last_read_at`、`created_at` | 新增，支撑 4.6 与 4.2「⭐收藏」；4.6 跨宿主 feed 就靠这张表 + `notification_delivery` |
| `attachment` | §7.1 | 四处 `attachments` 数组 |
| `comment` / `activity_log` / `custom_reminder` / `notification_event` / `notification_delivery` | 见 §7.2、§6.3 | 审计、评论、提醒、通知统一 |

`*.staff_role`：`owner` / `co_owner` / `follower`。
`user_watch.watch_type`：`follow`（他人指派为关注人，由 `*_staff` 同步生成）/ `favorite`（本人 ⭐，与业务无关，不进详情页"关注人"）。

> **为何 `owner_id` 仍留在主表**：单值、每页必读、且是数据范围计算的最高频条件。`matter_staff` 里的 `owner` 行与之双写，由状态变更服务单点维护。这是刻意的性能冗余，标注 `[derived]`。

`matter.case_id`（原文 1.2）**删除**：案例模块已移出第一期。第二期恢复时唯一真相应为 `case_study.matter_id` 唯一索引，详情页「关联案例」由反查装配，**不得**回补 `case_id` 列。
`matter.source_risk_id` **删除**：反查 `risk_matter_case`。

### 8.2 索引修订（替换原文 5.2 相应行，PG 语法）

| 表 | 原 | 修订 | 理由 |
|---|---|---|---|
| matter | `idx_status, idx_owner, idx_created_at` | `(status, owner_id, updated_at DESC) WHERE NOT is_deleted AND NOT is_archived`；`(updated_at DESC, id) WHERE NOT is_deleted` | 列表恒带未删+未归档过滤 → 用部分索引直接命中，不必把两个布尔放进每条索引前缀 |
| matter | `idx_case_no` | `UNIQUE (internal_code)` + 非唯一 `(case_no)` | 见 §6.3，查重=提示不阻止 |
| matter / risk_matter | — | `(last_progress_at) WHERE NOT is_deleted AND is_archived = false` | 规则 4 扫描，见 §6.4 |
| 两张节点表 | `idx_matter_id, idx_start_time` | `(host_id, sort_order)` + `ix_node_scan (status, deadline_time) WHERE is_time_confirmed AND status IN (...)` | 扫描跨宿主按期限，单列会全表扫 |
| activity_log | `idx_target, idx_created_at` | `(target_type, target_id, created_at DESC)` + `(operator_id, created_at DESC)` + `(matter_id)` + `(risk_matter_id)` | 多态三列；"我的活动"与关注 feed 需按人/按案件聚合 |
| comment | `idx_target` | `(target_type, target_id, created_at) WHERE NOT is_deleted` + `(parent_id)` | 列表过滤软删 |
| automation_rule | `idx_enabled, idx_priority` | `ux_rule_enabled_action`（§2.1 partial unique）+ `(trigger_type) WHERE is_enabled` | 两个单列索引无用 |
| party | `idx_name` | `(name)` + `(id_number_hash)` | 加密后不可索引明文，需存 HMAC 索引列 |
| *_staff | 新增 | `(user_id, staff_role, host_id)` | 支撑"我协办/我关注"，是数据范围查询的主路径 |
| user_watch | 新增 | `(user_id, created_at DESC)`；`(target_type, target_id)` | 4.6 按时间倒序；反查"谁关注了这件事"（发通知要用） |
| risk_matter | 新增 | `(conversion_status, updated_at DESC) WHERE NOT is_deleted` | §3.4 列表筛"已转案件" |

### 8.3 命名与类型（本轮已定）

- **领域命名不改**：案件 = `Matter`，事项 = `RiskMatter`。原歧义（`matter_type ∈ {matter, risk}` 读起来像"事项"）来自那个并列枚举，**拆表后 `matter_type` 列整体消失**，歧义源随之消解。
- 残余规则：**枚举值一律用全称 `risk_matter`，禁止缩写 `risk`**。横切表的 `target_type` 因此取值 `{matter, risk_matter, matter_node, risk_matter_node, matter_progress, matter_expense}`，`matter` 与 `risk_matter` 并列时读法清晰。
- 表名 `RiskMatter_Matter` → **`risk_matter_case`**。
- **禁止泛化抽象**（`AbstractMatter` / `host_id` 统一视图 / 泛型 `MatterLike` 基类），见 §1.0.2。
- 展示名统一 `name`（1.3 `title` → `name`，1.9 `title` → `name`）；API 层用 `displayName`。
- 类型基线：id `bigint`、时间 `timestamptz`（UTC）、日期 `date`、金额 `numeric(18,2)`、枚举 `varchar + CHECK`（不用 PG `enum` 类型，避免加值需 `ALTER TYPE` 与事务限制）、固定集合用 `text[]`/`integer[]`、自由结构用 `jsonb`。
- 时区：`timestamptz` 存储、按用户时区展示，法律期限计算按 UTC 日切并展示"剩 N 天"。刚性期限不容时区偏差。

---

## 9. 交付确认清单（原文第六部分）需改的 5 条

| # | 原文 | 修订后 |
|---|---|---|
| 2 | 状态模型（4 个固定，案件/事项共用） | ✅ 状态配置驱动、案件可自定义（`semantics=custom` 无系统行为）；案件与事项**状态同构 4 态**；转案件改由独立 `conversion_status` 表达，不占状态位 |
| 3 | 节点模型（案件完整，事项默认 3 个可自定义） | ✅ 两条互斥生成路径：P1 创建时预设（`preset_on_create`，事项 3 个）、P2 状态变更规则（规则 3）；取消 `default_node_template`；节点表按宿主拆两张 |
| 5 | 归档（= 状态变更为已归档，立即执行） | ✅ 归档即时生效；**「结案→归档」不内置**，由默认禁用的规则 1 承载；归档终态，仅管理员可撤销 |
| 6 | 自动化规则约束（动作一对一…） | ✅ 唯一性作用域由「全局」改为「**同触发域（scope_key）内同动作唯一**」，7 条预置规则现可共存；禁止状态变更、不级联维持；触发类型闭集 5 种，`event_occurred` 第一期必装 |
| 8 | 关注/收藏/提醒机制 | ✅ 拆为 `*_staff.follower`（业务关注人）+ `user_watch.watch_type=favorite`（个人收藏）+ `last_read_at`（未读）；提醒单一来源 = `node.remind_days` |
| 10 | 一案件一案例 | ⏭ **移出第一期**，改为「第二期」。PRD 1.3 字段表、2.3 案例状态机、案例检索原型整体后移；连带去掉对 PG 中文分词扩展的依赖（§12.5 作废） |
| 13 | MCP 授权页 | ⏭ **移出第一期**，改为「第二期」。删 4.5 原型；外部「案例库服务」随之外移（案例模块本身亦已后移，见 #10） |

### 9.1 本轮已定项（原"新增待确认"，已关闭）

| # | 议题 | 决策 |
|---|---|---|
| 15 | 「已转案件」怎么表达 | **独立 `conversion_status smallint`**，不进状态机（避免与"已结案"争状态位）；规则 7 改 `event_occurred` |
| 16 | 领域命名 | **不改名**（案件 `Matter` / 事项 `RiskMatter`），靠**拆表**消除 `matter_type` 歧义；枚举值一律全称 `risk_matter` |
| 17 | 数据库 | **PostgreSQL 15+**，落地要点见 §12 |
| 18 | MCP 授权页 | **移出第一期** |

---

## 10. 本修订未覆盖（B 组，下一步）

B1 权限与数据范围 → 草案 `PRD-phase1-permission-design-draft.md` **v3 定稿**：无组织维度；三档数据范围按「我与记录的关系」；角色按功能机制划分（`sys_admin`/`full_admin`/`full_operator`/`joined_operator`/`self_operator`，不用岗位名）；可见即可操作 + 4 特权开关 + 2 归属护栏 + 禁止自助提权。无开放问题
B2 附件鉴权细则 → 判定流程已在权限草案 §7.3 给出；剩签名参数与病毒扫描策略
B5 通知模板文案定稿（表结构已在 §7.2 给出）
B6 枚举与结构登记表 → **已交付** `PRD-phase1-enums-and-schemas.md`：28 项硬编码枚举 + `activity_log.action` 全清单 + `trigger_config`/`action_config`/`extra_condition` schema + `scope_key` 归一化与 8 条单测向量。配置表数量封在 5 张
B7 当事人敏感字段加密与脱敏 → 方案已在权限草案 §7.3 给出（AES-256-GCM + HMAC 索引列 + `key_version` 预留），剩密钥托管与轮换细则
B8 删除语义（与 §6.3 `is_deleted` 占位对应；注意 §6.1 节点 FK 已定 `ON DELETE CASCADE`，与软删策略需统一，见 §12.4）
D 转案件字段映射矩阵 → **已交付** `PRD-phase1-risk-to-case-mapping.md`：逐字段映射（继承/重填/留空/引用）、金额不分摊、描述与附件不复制、当事人引用+角色落关联表、单事务 + `event_outbox` 派发 `risk_converted`、撤销前置条件
F 缺失原型补齐：风险事项详情页、当事人管理、5 类配置后台、通知中心、已归档视图（§5 已定需加「包含已归档」开关）、批量导入、全局搜索。（案例列表/详情/检索随模块后移）
G 非功能需求：数据量预估、并发、留存期、备份、部署形态（当前为 0）

---

## 11. A 组自复核（修订后逐条回归）

| 项 | 修订后是否自洽 | 复核要点 |
|---|---|---|
| A1 | ✅ | 7 条 seed 在新唯一性作用域下可全部启用；「发送通知」4 次但域各不同；规则 1/7 同为 `archive` 但一个 `status_changed:closed`、一个 `event_occurred:risk_converted` |
| A2 | ✅ | 状态机不再被引用为"已转案件"；规则 7 由 `conversion_status 0→1` 的事件驱动；撤销路径已定义（§3.4） |
| A3 | ✅ | `default_node_template` 已删；P1/P2 时机互斥，不再重复建节点 |
| A4 | ✅ | 规则 1 默认禁用 → 4.1 的「已结案」行成立；补「包含已归档」筛选 |
| A5 | ✅ | `start_time` 可空 + `is_time_confirmed` → 与 4.2「判决 待定」一致；2.4 自动转进行中加了 `is_time_confirmed` 前置 |
| A6 | ✅ | 字段不再"必填却默认空"；校验时机移到「创建案件/转案件确认提交」 |
| A7 | ✅ | `attachment` 落地，1.3/1.5/1.6/1.7 的数组列全部改为反查；4.2 补附件 Tab |
| A8 | ✅ | 三层拆分 + `dedupe_key` 唯一键 + `ON CONFLICT DO NOTHING`；规则 5/6 与 `remind_days` 同键 → 吸收而非叠加 |
| A9 | ✅ | `default_remind_days` 删除，提醒配置只剩 `node.remind_days` 一处 |
| C | ✅ | 业务从属关系按宿主拆表带真 FK；横切表保持单管线并写明判据；`is_archived` 与 `*_staff.owner` 两处冗余显式标注为受控派生 |

**遗留风险**：
1. ~~A1 的 `scope_key` 依赖 `trigger_config` 归一化函数稳定~~ → 已闭合，见 `PRD-phase1-enums-and-schemas.md` §4.4（含 8 条必过单测向量）。
2. 拆表后 `matter_node` / `risk_matter_node` 等同构表对约 5 组，**服务层代码复用与 schema 漂移**是新风险：迁移脚本必须成对改动，建议用同一迁移文件 + 契约测试（两表列集合 diff 必须为空）。
3. ~~B1 未定，`conversion_status`、`user_watch`、`attachment` 三处的可见性判定是悬空引用~~ → 已由 `PRD-phase1-permission-design-draft.md` 接管（分别对应其 §6.2、§6.3、§6.4）。但该草案 §11 尚有 5 点待裁定，未裁定前这三处的实现仍是开放的。

---

## 12. PostgreSQL 15+ 落地要点

本轮选型确定后，前面各节引用 PG 语法，集中记录 5 条决策与 2 个必须先解决的实现问题。

### 12.1 为什么这轮的决策"正好"依赖 PG

| 需求 | PG 能力 | 替代方案的代价 |
|---|---|---|
| 规则动作同域唯一（§2.1） | partial unique index `WHERE is_enabled` | MySQL 需生成列 + 唯一键，`trigger_config` 一改就要重建列 |
| 列表恒过滤未删+未归档（§8.2） | partial index | MySQL 只能把布尔塞进索引前缀，选择性差 |
| `next_status_codes`、`remind_days`、`remind_channels` | `text[]` / `integer[]` + GIN | MySQL 需 jsonb 模拟 + 多值索引（8.0.17+，限制多） |
| 编号生成器（§12.3） | `INSERT ... ON CONFLICT ... RETURNING` 单语句原子自增 | MySQL 需 `SELECT FOR UPDATE` 两段式 |

### 12.2 类型与迁移基线

- id：`bigint`（雪花由应用侧生成，DB 不设 `IDENTITY`，避免双序列冲突）。
- 时间：一律 `timestamptz`，`date` 仅用于"当事人可见的日历日期"（`discover_date`、`filing_date`、`progress_date`）——**日历日期不能用 timestamptz**，否则跨时区会漂一天，法律期限计算直接错。这是本节最容易被忽略的一条。
- 枚举：`varchar + CHECK`，不用 PG `enum` 类型（加值需 `ALTER TYPE`，且在事务块/逻辑复制下受限）。
- 金额：`numeric(18,2)`，禁 `float`。
- 迁移工具建议 pt/Flyway，每张同构表对放同一个迁移文件（对应 §11 遗留风险 2）。

### 12.3 编号生成器（`FX/AJ/AL-YYYYMMDD-XXX`）

原设计只给了格式，未定实现。PG 方案：

```sql
CREATE TABLE code_seq (
  day_key   date        NOT NULL,      -- 服务器 UTC 日
  prefix    varchar(4)  NOT NULL,      -- FX | AJ | AL
  last_seq  integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (day_key, prefix)
);

-- 单语句原子取号，天然处理并发与跨日边界
INSERT INTO code_seq (day_key, prefix, last_seq)
VALUES (CURRENT_DATE, 'AJ', 1)
ON CONFLICT (day_key, prefix)
  DO UPDATE SET last_seq = code_seq.last_seq + 1
RETURNING last_seq;
```

- 序号 3 位、每日上限 999 → **必须定义溢出行为**：溢出时扩为 4 位（`AJ-20261015-1000`）而非报错。原文未定义，这是会在线上首次遇到的故障。
- 时区：`day_key` 用 UTC 还是所内时区（Asia/Shanghai）必须**写死一种并在文档标注**。法律案号按"立案日"编号，建议用业务时区 `CURRENT_DATE AT TIME ZONE 'Asia/Shanghai'`，否则晚上立案会归到后一天。
- 号可跳不可复：事务回滚会留下空洞，接受（不要试图复用，复用会引入锁竞争）。

### 12.4 软删与 FK CASCADE 的冲突（新发现，需决策）

§6.1 给节点表定了 `ON DELETE CASCADE`，而 §6.3 又给所有表加了 `is_deleted` 软删。两者不能共存于同一张表——真删会连带抹掉审计链。定调：

- **业务表（matter / risk_matter / party）：只软删**，DB 层 FK 一律 `ON DELETE RESTRICT`，级联由服务层显式执行并写 `activity_log`。
- **从属明细表（*_staff / *_tag / *_party）：随宿主硬删**（`ON DELETE CASCADE`），它们无独立审计价值。
- `node` / `progress` / `expense` / `attachment`：**软删**（有业务与审计含义）。
- 因此 §6.1 的节点 FK 定为 `RESTRICT`：节点有业务与审计含义，不随宿主硬删。

### 12.5 ~~中文全文检索的前置条件~~（作废）

原为 1.3 案例库 `summary` 的 `tsvector` 检索而写。案例模块移出第一期后，**第一期无任何全文检索需求**，`zhparser` / `pg_jieba` 扩展依赖一并消失。
第二期恢复案例时再评估：全局搜索（§10 F 项）会是第一个真正需要它的地方，届时按当时数据量决定是否引入扩展。
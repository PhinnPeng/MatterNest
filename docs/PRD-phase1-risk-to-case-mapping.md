# MatterNest 第一期设计交付物 — 风险事项转案件映射矩阵（D）

> 状态：**定稿**。闭合 `PRD-phase1-design-revision-r1.md` §10 的 D 项。
> 上游依据：PRD 4.3 转案件页面、清单#7「转案件 1:N」、修订稿 §3.4（`conversion_status`）、§8.1（`risk_matter_case`）、§12.3（编号生成器）、权限草案 §4.4（写入校验）。

---

## 1. 转换语义（先定边界，再定映射）

| 议题 | 决策 | 理由 |
|---|---|---|
| 基数 | 一次操作 = 1 事项 → **N 个案件（N ≥ 1）** | 清单#7 |
| 原子性 | N 个案件的创建 + 关联回写 + 事项状态变更 = **单个数据库事务**，任一失败整体回滚 | 分批提交会留下"转了一半"的事项，而 `conversion_status` 只有 0/1 两值，无法表达半态 |
| 是否可追加 | **可以**二次转案件，向同一事项追加案件；`conversion_status` 保持 1，`converted_case_count` 递增 | 一个风险衍生出多起诉讼常跨月发生，禁止追加会把用户逼回"新建案件"从而丢掉关联 |
| 是否有"部分转换"第三态 | **不做**。`conversion_status` 维持 0/1 | 引入部分态需要"哪些子请求已转"的追踪结构，第一期无此需求 |
| 事项是否必须归档 | **不强制**。由预置规则 7 决定（`event_occurred: risk_converted` → `archive`，seed 默认启用）；规则被禁用时事项留在原状态 | 归档是策略，不是转换的定义 |
| 转换可否撤销 | 可以，但**只在目标案件尚未产生进展/费用/节点时**（修订稿 §3.4）。已触发的归档**不自动回滚**，需 `can_unarchive` | 自动回滚归档等于让一次业务动作隐式解开另一次状态变更，审计链会断 |

---

## 2. 字段映射矩阵

`继承` = 原值直接带入新案件；`重填` = 表单必给；`留空` = 不预填；`引用` = 不复制、经关联表可跳转。

### 2.1 标识与系统列

| 案件字段 | 处理 | 规则 |
|---|---|---|
| `id` | 新生成 | 雪花 |
| `internal_code` | 新生成 | `AJ-YYYYMMDD-NNN`，走修订稿 §12.3 的 `code_seq`（业务时区日界、溢出扩 4 位） |
| `case_no` | 默认 = `internal_code`，可改 | 非唯一，重复仅提示（修订稿 §6.3） |
| `name` | **派生 + 必确认** | N=1 → 事项 `name`；N>1 → 事项 `name` + `-1`/`-2`…。表单内该格高亮为"待确认"，用户未改也可提交 |
| `source_risk_id` | **无此列** | 由 `risk_matter_case` 反查（修订稿 §8.1） |
| `created_by` / `created_at` | 当前用户 / now | |
| `status` | 事项 `semantics=open` 的案件初始态 | 取 `status_config(host_type='matter', is_initial_status=true)`，**不是**照抄事项状态 |
| `is_archived` | false | 派生 |
| `last_progress_at` | `= created_at` | 规则 4「30 天无更新」的基准，必须在建案时落初值，否则 `NULL` 会让该规则永不或立刻命中 |

### 2.2 业务字段

| 案件字段 | 事项来源 | 处理 | 判定理由 |
|---|---|---|---|
| `level` | `level` | **继承** | 风险等级即案件风险等级，同一事件的不同阶段 |
| `case_type` | 无对应 | **重填（必填）** | 事项无此维度 |
| `procedure` | 无对应 | **重填（必填）** | 同上 |
| `litigation_role` | 无对应 | **重填（必填）** | 同上 |
| `cause` | 事项 `type` | **重填（必填），不做自动映射** | 见 §2.3 |
| `court` | 无对应 | 留空 | 受理机关是法院事实，风险阶段未知 |
| `filing_date` | `discover_date` ❌ | **留空，不映射** | 发现日期 ≠ 立案日期。误填会污染后续期限计算 |
| `closing_date` | — | 留空 | |
| `amount` | `amount`（涉案金额） | **留空，逐案自填**；仅做**提示性**校验 | 见 §2.4 |
| `description` | `description`（风险描述） | **不继承**，改为引用 | 见 §2.5 |
| `measure` | `measure`（处置措施） | **不继承**，随事项留存 | 同上，属风险处置记录 |
| `owner_id` | `owner_id` | **继承为默认值，可逐案改** | 改后受权限草案 §4.4 写入校验 |
| `co_owner_ids` | `co_owner_ids` | **继承，剔除 `is_enabled=false` 的用户** | 停用账号留在授权表里是无意义风险面 |
| `follower_ids` | `follower_ids` | **继承，同上剔除** | 继承即授权扩散，但"原班人马继续办理"是产品预期；权限侧规则见 §5.3 |
| `tag_ids` | `tag_ids` | **继承** | 标签是描述性的，继承无副作用 |
| `party_ids` | `party_ids` | **引用同一 `party` 行，不复制** | 见 §2.6 |
| `party_roles` | `risk_matter_party.role` | 事项角色**作为默认值带入**，逐案可改 | 风险阶段角色与诉讼阶段角色通常一致，但不保证 |
| 节点 | 事项预设节点 | **不继承** | 见 §2.7 |
| 附件 | 事项附件 | **不复制**，引用 | 见 §2.8 |
| `source` | — | 无对应列 | |

### 2.3 案由不做自动映射

事项 `type`（合同/劳动争议/知识产权/…，E15）与案件 `cause`（案由）看着能对照，**第一期不建对照表**：案由是国标树、层级深且一个风险类型能落到几十个案由，映射表只能凭感觉写，写错比不写更糟（用户会信默认值）。表单里把 `cause` 设为必填并允许直接搜索输入即可。

将来若确有诉求，走枚举表 §6 的升级路径建 `cause_config` 树，再谈推荐映射。

### 2.4 金额不分摊

事项 `amount` 语义是"涉案金额（预估）"，案件 `amount` 是"标的额"。一事项转多案时，标的额怎么分是**有法律后果的业务判断**（决定诉讼费、影响承办考核），系统替用户分等于替他做错。

处理：案件 `amount` 一律留空逐案填。提交时若 `Σ 各案 amount > 事项 amount`，给一条**非阻断**提示：「各案标的额合计（X）已超过风险事项登记的涉案金额（Y），请确认」。

> 为什么是"提示"不是"阻止"：一事项先转一部分进诉、剩余后续处理，是正常业务。阻止会造成用户绕开本功能。

### 2.5 描述不复制

事项 `description`（风险描述）与案件 `description`（案情说明）**语义不同**。复制会产生两份各自漂移、且没人记得源头在哪的文本——这是比"留空"更糟的结果。

处理：新案件 `description` 留空；案件详情页"来源风险"卡片里直接渲染事项的 `description` 与 `measure`（只读，按事项可见性鉴权）。要写案情就自己写。

### 2.6 当事人：引用 + 角色落到关联表

新案件写 `matter_party(matter_id, party_id, party_role, represented, role_seq)`：

- `party_id` **指向事项已关联的同一批 `party` 行**，不新建、不克隆。
- `party_role` 默认取 `risk_matter_party.party_role`，逐案可改。
- `represented`（是否我方代理）**默认 `true` 的那批**带入新案件——风险事项能转案件，通常就是本所代理的那方在提诉或应诉；其余当事人以 `represented=false` 预填，用户可改。
- 表单上当事人区必须显示 party 的 `code`，并在用户**编辑名称**时提示「该当事人被 N 个案件引用，修改将同步生效」。这是引用模型的必然代价，藏起来会在生产上吃投诉。
- 校验：每案 ≥1 条 `*_party` 行（修订稿 §6.2 的动作级校验）。

### 2.7 节点不继承

事项的 3 个预设节点（受理/核查/反馈）是**风险处置动作**，案件的节点（举证/开庭/判决）是**诉讼程序**，`node_type_config.host_type` 已经把它们拆成两套（修订稿 §4）。继承会造出语义错误的节点集合。

处理：新案件节点走自身的 P1 预设（`host_type=matter` 且 `preset_on_create`）；`matter_in_progress` 模板由进入"进行中"时规则 3 生成。

### 2.8 附件不复制

事项附件（律师函、投诉材料）是立案的证据来源。复制文件会产生双份存储、双份鉴权判定、以及"改了一份另一份还在"的幽灵引用。

处理：`attachment` 不新增行；案件详情页"来源风险"卡片下按 `owner_type='risk_matter' AND owner_id=<事项>` 列出并可跳转。下载鉴权仍按权限草案 §7.3 走事项宿主判定——注意这意味着**能看到案件但看不到来源事项**的用户，看不到这些附件。第一期接受该行为（引用不扩权），并在卡片上显示「无权查看来源风险的 N 个附件」而非静默隐藏。

---

## 3. 表单与请求结构

对应 PRD 4.3，一期一提交：

```jsonc
// POST /risk-matters/{id}/convert
{
  "cases": [
    {
      "name": "XX公司诉YY公司货款纠纷案-1",
      "case_type": "civil_commercial",
      "procedure": "first_instance",
      "litigation_role": "plaintiff",
      "cause": "买卖合同纠纷",
      "court": "XX区人民法院",
      "amount": "500000.00",
      "owner_id": 123,
      "co_owner_ids": [456],
      "follower_ids": [789],
      "tag_ids": [11],
      "parties": [
        { "party_id": 1001, "party_role": "plaintiff",  "represented": true,  "role_seq": 1 },
        { "party_id": 1002, "party_role": "defendant",  "represented": false, "role_seq": 2 }
      ]
    }
    // … N-1 more；支持"复制上一个案件的字段"，但 id 类字段不复制
  ],
  "reason": "拖欠货款分两批起诉"     // 选填，进 activity_log.reason
}
```

- 服务端**不接收** `status`、`is_archived`、`internal_code`、`conversion_status`、`created_*`。
- `cases[]` 为空 → 400。

### 3.1 提交时校验（逐案，全部通过才开事务）

```text
必填     name, cause, case_type, procedure, litigation_role, owner_id
关系     parties.length >= 1 且 party_id 均存在且未软删
角色     party_role 属于 E12 取值
金额     amount 为 null 或 >= 0（numeric(18,2)）
人员     全部 id 类用户 is_enabled = true
权限     owner/co_owner/follower 均落在创建者可见用户集内（权限草案 §4.4）
幂等     同一 (risk_matter_id, name, internal cause) 重复提交不去重——允许同名案件
```

---

## 4. 事务边界与事件派发

```text
BEGIN
  1  SELECT … FOR UPDATE            -- 锁事项行，串行化并发转换
  2  取 conversion_status 判定 首次 / 追加
  3  逐案：code_seq 取号 → INSERT matter
                    → INSERT matter_party / matter_staff / matter_tag
                    → P1 预设节点（host_type=matter, preset_on_create）
  4  INSERT risk_matter_case × N     -- seq 续接，converted_at/by 仅首次写
  5  UPDATE risk_matter: conversion_status=1, converted_case_count=重算
  6  INSERT event_outbox(risk_converted, batch_id)   ← 见 §4.1
  7  INSERT activity_log(CONVERTED_TO_CASE, payload={case_ids}, reason)
COMMIT
-- 提交后
  8  后台投递 outbox → 规则 7（archive）→ 通知 fan-out
```

第 5 步的 `converted_case_count` 用 `COUNT(*)` 重算而非累加，保证与关联表始终一致。

### 4.1 事件必须走 outbox

规则 7 若在事务内同步执行，会出现两种错：读到未提交的关联行，或自身失败把整个转换一起回滚（用户看到"转案件失败"但案件其实建了又删了）。

```sql
CREATE TABLE event_outbox (
  id           bigint PRIMARY KEY,
  event_type   varchar(40)  NOT NULL,   -- 'risk_converted'
  batch_id     uuid         NOT NULL,   -- 同时充当 event_batch_id（权限草案 §7.1 聚合键）
  payload      jsonb        NOT NULL,
  published_at timestamptz,             -- NULL = 待投递
  attempts     integer      NOT NULL DEFAULT 0,
  last_error   varchar(500)
);
CREATE INDEX ix_outbox_pending ON event_outbox (id) WHERE published_at IS NULL;
```

投递器扫 `published_at IS NULL`，成功即打时间戳。**至少一次**语义，因此规则侧必须有去重：`notification_event.dedupe_key` 唯一 + `AUTO_RULE_SKIPPED` 记跳过（修订稿 §7.2）。

### 4.2 并发

- 行锁 `FOR UPDATE` 保证同事项串行。
- 追加转换时 `(risk_matter_id, matter_id)` 主键唯一，防重复关联。
- 锁等待超时（默认 5s）→ 返回「该事项正在被其他操作转换，请稍后重试」，不自动重试。

---

## 5. 撤销与后续联动

### 5.1 撤销关联

```text
DELETE risk_matter_case WHERE risk_matter_id=? AND matter_id=?
  前置：该案件无 matter_progress / matter_expense / matter_node（除 P1 预设外）
  后置：converted_case_count 重算
        若归 0 → conversion_status 回 0，converted_at/by 置 NULL
  必写：activity_log(UNCONVERT, reason 必填)
不自动做：解除归档。已归档案件保持归档，需人工 can_unarchive
```

前置条件里**排除 P1 预设节点**——它们由系统自动生成，用户还没动手就永远撤不了销。这条原文没定义，按"系统生成的东西不算用户投入"来判。

### 5.2 与事项状态的关系

| 事项状态 | 可否转案件 |
|---|---|
| `semantics=open` / `in_progress` | 可 |
| `closed` | **可**（结案后补记转过案件，正是 §3.4 用独立列而非状态位的原因） |
| `archived` | 不可，需先 `can_unarchive` 撤销归档 |

### 5.3 三条必须写进权限文档的连带规则

1. **新案件对创建者必须立即可见**，否则刚转完就打不开。继承 `owner_id=事项 owner` 时，若事项 owner ≠ 操作者，操作者靠 `created_by` 分支获得可见性（权限草案 §4 已含该 OR），此结论成立——记录为设计不变量，勿在后续收窄。
2. 继承过来的 `follower_ids` 会**立即**获得新案件全部读写（权限草案 §6）。因此转案件表单的关注人区要显示与事项同一句授权提示，不能只在"管理关注人"弹窗里有。
3. 用户**看得到案件但看不到来源事项**时（被加为案件协办而不在事项参与名单里），来源卡片按 §2.8 显示"无权查看"占位，不暴露事项 `code` 以外的内容。

---

## 6. 闭合关系

| 上游 | 本文件 |
|---|---|
| 修订稿 §10 D「金额拆分、名称派生、当事人引用 vs 复制、事务边界与补偿」 | §2.4 / §2.1 / §2.6 / §4 |
| 修订稿 §3.4 转换撤销规则未定义 | §5.1 补前置条件与计数归零 |
| 修订稿 §12.3 编号生成器 | §2.1 引用 |
| 权限草案 §4.4 写入校验 | §3.1 落地为具体校验行 |
| 权限草案 §7.1 通知聚合 `event_batch_id` | §4.1 outbox 的 `batch_id` 即其来源 |
| 权限草案 §6 关注人=授权 | §5.3 |
| PRD 4.3「自动编号可改」「复制案件 1 字段」 | §2.1 `name` 派生 + §3 复制语义 |
| PRD 清单#7 | §1 |

**仍开放**：修订稿 §10 的 B8（删除语义）、B2 剩余（签名参数与病毒扫描）、F（缺失原型）、G（非功能需求）。

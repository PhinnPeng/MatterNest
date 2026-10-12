# 副标题纪律：现状清点、约束形态与条文草案（2026-10-12）

> 归属：`.trellis/spec/frontend/` 的"组件 API 收口"与"文案纪律"两条待补条目的取证底稿。
> 触发：2026-10-12 对登录页与左侧导航做完一轮文案删减后，用户要求「研究以降低大部分内容出现副标题的行为」+
> 「针对大量出现的副标题，增加约束是否可行？」
> 前提（今天已发生、**本文不重新论证**）：登录页副标题、左栏"风险事项 · 案件"、侧栏"数据范围 · 全公司"、
> NAV 里 4 条从未被渲染的 `hint` 死数据、以及随之删除的 `theme/antd.ts:SCOPE_HINT` 常量，
> 共同点是**同一屏里同一信息被说了两遍**。
> 证据纪律：仓内一手材料是 `.trellis/spec/**`、`docs/**`、`CHANGELOG.md`、`tools/**` 与源码本身；
> 仓外只引一手（antd 包内源码、antd 官方文档），并给路径或 URL。
> **本文只读**，不改任何源码 / spec / eslint 配置；`src/shared/enums/targets.ts` 等在制改动未被触碰。

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| 现状里副标题主要属于哪一类 | 75 条枚举里 **复述型只剩 1 条（1.3%）** —— 今天那轮删减已经把最该删的那类打掉了。占多数的是 **计量型 24 条（32.0%）与解释型 24 条（32.0%）并列第一**，其后是状态型 13（17.3%）、引导型 12（16.0%）。数字见 §A.2 |
| 推荐哪种约束 | **组件 API 收口为主 + 门禁源码断言兜底 + spec 条文裁决搬迁目的地**（§B.6）。不推荐 ESLint 规则：它拦的是 prop 名，而副标题的真正入口是 antd 的 4 个原生 slot（`title`/`extra`/`description`/`help`），全仓 75 处命中，误伤面覆盖所有列表页与弹窗 |
| 最该先改的一个文件 | **`src/app/components/page-header.tsx`** —— 删 `eyebrow` / `meta` 两个 `ReactNode` 插槽（:12,14,17,19 与 :25-29,38-47），让"页面头第二行说明"**在类型上不可表达**；顺带清掉改完后成为死代码的 `MetaItem`（:55-62，13 处调用全在两个 `meta` 槽内）与当前就是零 import 的 `Section`（:90-111）、`VDivider`（:113） |

一条不能忽略的前提：`PageHeader` 的注释（`page-header.tsx:8`）明写它承载
"**编号 / 名称 / 状态**这类必须在第一屏出现的信息"。所以推荐方案**不是把页面头掏空**，
是把它从"任意 `ReactNode` 的第二行"改成"状态徽标 + 与标题同行的主键"两件具名的事，
把其余字段搬进已经存在的「基本信息」卡片。§B.6.2 给了逐调用点的搬迁方案，净信息损失为 0。

---

## A. 现状清点

### A.0 口径与检索命令

**什么算"副标题样"**：灰色（`type="secondary"` / `INK.muted` / `INK.faint` / `INK.secondary`）或字号 ≤13px，
**挂在某个标题或标签附近**、承担"解释 / 计数 / 引导 / 状态"职能的文本。
行内第二行（列表单元格里名字下面那行）、表头灰字、字段标签**不算**，见 §A.4 的排除项。

检索命令（PowerShell 下 `rg` 不在 PATH，用 `grep` 工具等价）：

```
# 灰字总量（46 处 INK.muted/faint + 10 处 type="secondary"，含 theme 与 spec 自述）
grep -rn 'type="secondary"'       src --include=*.tsx          # 10 处，分布于 4 个文件
grep -rn 'INK\.(muted|faint)'     src --include=*.tsx          # 46 处
grep -rnE 'fontSize: (11|12|13)'  src --include=*.tsx          # 88 处

# 页面头槽位的调用点（全仓唯一 4 处）
grep -rn 'PageHeader|eyebrow|meta=' src --include=*.tsx
grep -rn '\beyebrow\b' src         # 7 处：3 个调用点 + page-header.tsx 自身 4 处
grep -rn '\bmeta\s*=' src          # 2 处：risk-detail.tsx:134、matter-detail.tsx:190

# 卡片 extra / 空态 / 字段说明
grep -rn 'extra=|hint=|description=' src --include=*.tsx
```

### A.1 全量枚举（75 条）

`A`族 = `PageHeader` 的 `eyebrow`/`meta` 槽位；`B`族 = 卡片头 / `extra` / 底栏；
`C`族 = 页面顶部整行说明；`D`族 = 空态与提示；`E`族 = 弹窗 / 横幅 / 对话框说明；
`F`族 = 表单字段说明；`G`族 = 外壳与登录页。

#### A 族 — `PageHeader` 的副标题插槽（18 条）

| # | 位置 | 原文 | 归类 |
|---|---|---|---|
| A1 | `(desk)/workbench.tsx:83-87` `eyebrow` | `{day}` → `toLocaleDateString("zh-CN",{…weekday:"long"})`，即「2026年10月12日星期一」 | **复述型** |
| A2 | `matters/[id]/matter-detail.tsx:180-182` `eyebrow` | `<ArrowLeftOutlined /> 案件`（页内返回链接） | 引导型 |
| A3 | `matter-detail.tsx:183` `eyebrow` | `<Typography.Text className="num">{m.internalCode}</Typography.Text>` | 计量型 ⚠**同屏重复** |
| A4 | `matter-detail.tsx:184-186` `eyebrow` | `<StatusMark host="matter" code={m.status} />` + `已归档` / `已结案` 两个 `FlagMark` | 状态型 |
| A5 | `risk-matters/[id]/risk-detail.tsx:128-132` `eyebrow` | `<ArrowLeftOutlined /> 返回事项列表` | 引导型 |
| A6 | `matter-detail.tsx:192-194` `meta` | `案号 {m.caseNo}` | 计量型 ⚠**同屏重复** |
| A7 | `matter-detail.tsx:195` `meta` | `案由 {m.cause}` | 状态型 |
| A8 | `matter-detail.tsx:196` `meta` | `程序 {…procedures[m.procedure]}` | 状态型 |
| A9 | `matter-detail.tsx:197` `meta` | `等级 {level}` | 状态型 |
| A10 | `matter-detail.tsx:198-200` `meta` | `标的额 {money(m.amount)} 元` | 计量型 |
| A11 | `matter-detail.tsx:201` `meta` | `立案 {calDate(m.filingDate)}` | 计量型 |
| A12 | `matter-detail.tsx:202` `meta` | `更新 {fromNow(m.updatedAt)}` | 计量型 |
| A13 | `risk-detail.tsx:136-138` `meta` | `编号 {risk.code}` | 计量型 |
| A14 | `risk-detail.tsx:139-141` `meta` | `状态 <StatusMark host="risk_matter" …>` | 状态型 |
| A15 | `risk-detail.tsx:142-144` `meta` | `风险类型 <FlagMark>` | 状态型 |
| A16 | `risk-detail.tsx:145-149` `meta` | `等级 <FlagMark tone=…>` | 状态型 |
| A17 | `risk-detail.tsx:151-155` `meta` | `已转案件 <Tag color="blue">已转 {n} 个案件</Tag>` | 计量型 ⚠**同屏重复** |
| A18 | `risk-detail.tsx:156` `meta` | `更新 {fromNow(risk.updatedAt)}` | 计量型 ⚠**同屏重复** |

> ⚠ 4 处同屏重复的另一半，各自带行号：
> - A3 ↔ `matter-detail.tsx:221-225` `Descriptions` 的「内部编号」
> - A6 ↔ `matter-detail.tsx:226-230` `Descriptions` 的「正式案号」
> - A17 ↔ `risk-detail.tsx:298-315` 右栏「已转案件」卡片（卡片标题 `SectionTitle` 上已带 count）
> - A18 ↔ `risk-detail.tsx:285` `DetailBlock「登记信息」` 里的 `MetaLine label="更新"`
>
> 这四条就是今天删掉 `SCOPE_HINT` 时用的那条判据（`theme/antd.ts` 末尾注释：
> "把范围谓词复述成了第二份说法"）在详情页上的四份残留。

#### B 族 — 卡片头 / `extra` / 底栏（19 条）

| # | 位置 | 原文 | 归类 |
|---|---|---|---|
| B1 | `components/ui/data-table/DataTable.tsx:104-106` | `共 {total} 条`（卡片头 `title` 里，紧跟 h1） | 计量型 |
| B2 | `DataTable.tsx:184-188` | `第 {page} / {ceil(total/pageSize)} 页 · 每页 {pageSize} 条`（卡片底分页条左侧） | 计量型 |
| B3 | `(desk)/workbench.tsx:108-112` | Card「节点到期」的 `extra`：`含已逾期，按期限升序` | 解释型 |
| B4 | `workbench.tsx:291-295` | Card「最近动作」的 `extra`：`{data?.recent.length ?? 0}`（裸数字） | 计量型 |
| B5 | `workbench.tsx:244-249` | `Statistic`「风险事项」的 `suffix`：`已转 {n}` | 计量型 |
| B6 | `config/config-view.tsx:63` | Card `title={\`案件状态 (${m.statuses.length})\`}` | 计量型 |
| B7 | `config-view.tsx:86` | Card `title={\`事项状态 (${r.statuses.length})\`}` | 计量型 |
| B8 | `config-view.tsx:73-75` | `Typography.Text type="secondary" fontSize:12`：`标签`（"案件状态"卡内的一行分组标签） | 子标题（边界） |
| B9 | `config-view.tsx:137-139` | `EnumBlock` 标题 `{title} · {entries.length}`，**6 处调用**（`:119-124`） | 计量型 ×6 |
| B10 | `risk-detail.tsx:166` | `<SectionTitle count={risk.nodes.length}>事项节点` | 计量型 |
| B11 | `risk-detail.tsx:244` | `Collapse` 的 `label`：`展开风险描述、处置措施、当事人与登记信息` | 引导型 |
| B12 | `risk-detail.tsx:301 / 320 / 327` | `<SectionTitle count={…}>已转案件 / 处置记录 / 活动流` | 计量型 ×3 |

> B2 之所以不是"和分页器重复"：`node_modules/antd/es/pagination/Pagination.js` 里**已经没有 `showTotal`**
> （`Select-String -Path … -Pattern showTotal` 无命中），antd 6 的 `Pagination` 默认不渲染任何文字说明，
> 所以那行"第 x / y 页"是本仓自己写的、也是唯一一处把"我正在看第几页、每页多少条"说出口的地方。
> 一手路径：`node_modules/antd/es/pagination/Pagination.js`（antd 6.6.5）。

#### C 族 — 页面顶部整行说明（1 条）

| # | 位置 | 原文 | 归类 |
|---|---|---|---|
| C1 | `archive/archive-view.tsx:213-215` | `归档是终态：默认不出现在办列表；撤销归档在记录的「变更状态」里做，需专门权限。`（与 `Segmented` 宿主切换器同行） | 解释型 |

#### D 族 — 空态与提示（19 条）

| # | 位置 | 原文 | 归类 |
|---|---|---|---|
| D1 | `matters/matters-view.tsx:279-281` | `DataTable empty`（有筛选）：`当前筛选下没有可见案件。清掉关键词或状态再看一次；如果同事能看见而你不能，那是数据范围（L1/L2/L3）的差异。` | 引导型 |
| D2 | `matters-view.tsx:281` | `DataTable empty`（无数据）：`还没有在办案件。点右上「新建案件」，内部编号会由数据库单语句取号。` | 引导型 |
| D3 | `risk-matters/risks-view.tsx:321-322` | `empty`（有筛选）：`当前筛选下没有可见事项。清掉条件再看一次；范围不同看到的条数就不同。` | 引导型 |
| D4 | `risks-view.tsx:323` | `empty`（无数据）：`还没有在办风险事项。点右上「新建事项」报备一条。` | 引导型 |
| D5 | `archive-view.tsx:255-256` | `empty`（有筛选）：`当前关键词下没有已归档记录。换个词或清掉关键词再看一次。` | 引导型 |
| D6 | `archive-view.tsx:257-259` | `empty`（无数据，两个分支）：`还没有已归档案件。在办案件走完流程、置为归档后才会出现在这里。` / `还没有已归档风险事项。` | 引导型 ×2 |
| D7 | `workbench.tsx:120` | `StateBlock hint`：`所有已确认时间的节点都完成了。新建节点在案件详情页的「工作节点」里。` | 引导型 |
| D8 | `workbench.tsx:299` | `StateBlock hint`：`建案、改状态、加评论都会记在这里。` | 引导型 |
| D9 | `matter-detail.tsx:270` | `StateBlock hint`：`节点是提醒的唯一入口：确认时间并设了期限，才会进工作台的到期清单。` | 解释型 |
| D10 | `risk-detail.tsx:180` | `StateBlock hint`：`事项不预置节点。只有确有时限时才手动加一个时间点。` | 解释型 |
| D11 | `risk-detail.tsx:251` | `<Dash hint>`：`没有当事人时无法转案件——转案件要求每案至少 1 个当事人。` | 解释型 |
| D12 | `risk-detail.tsx:521` | `<Dash hint>`：`事项的核查走处置记录，不靠进展——所以这里可能是空的。` | 解释型 |
| D13 | `config-view.tsx:29` | `StateBlock tone="error" hint`（**硬编码**）：`会话可能已过期，重新登录后再看。` | 引导型 |
| D14 | 6 处错误态 hint（传 `error.message`） | `workbench.tsx:57` / `archive-view.tsx:192` / `matters-view.tsx:219` / `risks-view.tsx:253` / `matter-detail.tsx:68` / `risk-detail.tsx:105` | 解释型 ×6 |

> D14 与 D13 都落在 `ui/state-block.tsx` 的同一个 `hint` 插槽上（`:21`），渲染分支 `:34`（error/denied）与 `:50`（empty）。
> `state-block.tsx:12` 的注释是它们存在的理由："要能把原文错误带出来（排查时'读取出错'四个字没有价值）"。
> **这 7 条受 spec 明文保护，不是"过多副标题"的一部分。**

#### E 族 — 弹窗 / 横幅 / 对话框说明（7 条）

| # | 位置 | 原文 | 归类 |
|---|---|---|---|
| E1 | `components/status-dialog.tsx:92-94` | Modal「变更状态」标题下：`{target.code} · {target.name}` | 状态型 |
| E2 | `risk-matters/convert-dialog.tsx:142-144` | Modal「转为案件」标题下：`来源事项 {source.code} · {source.name}` | 状态型 |
| E3 | `risk-detail.tsx:208-211` | 归档横幅：`这条事项已归档（{date}），是只读终态。要改内容需先由持「撤销归档」权限的人撤销归档。` | 解释型 |
| E4 | `risk-detail.tsx:709-711` | Modal「变更处理人」内：`这是一次普通字段编辑：不新增状态、不进独立流程。选「退回未指派」会把这条事项放回待处理池。` | 解释型 |
| E5 | `risk-detail.tsx:725-727` | `这条事项上目前没有可指派的其他同事。` | 状态型 |
| E6 | `risk-detail.tsx:354` | `Popconfirm description`：`库内仍可恢复，但界面上没有回收站。普通用户看不到已删行。` | 解释型 |
| E7 | `matters/matter-create-dialog.tsx:349-353` | `已引用库中当事人 · 名称是共享信息，会同步到所有案卷` | 状态型 |

> E1/E2 是本仓最容易**误判成复述**的一类：它们看着像 Modal 标题的副标题，实际回答的是
> "这次改的是**哪一条**记录"。弹窗遮住了背后的页面头，所以这两行是**唯一**能把操作对象说清楚的位置。
> 今天删掉的 `SCOPE_HINT` 那条判据在它们身上**不成立**。

#### F 族 — 表单字段说明（9 条）

| # | 位置 | 原文 | 归类 |
|---|---|---|---|
| F1 | `status-dialog.tsx:100-106` `Form.Item help` | 三分支：`归档后默认从列表消失，撤销归档需专门权限（或 is_admin）。` / `这一步不在当前状态的推荐路径上，要写一句为什么。` / `走推荐路径，不需要原因；写了会一起进活动记录。` | 解释型 ×3 |
| F2 | `convert-dialog.tsx:175` `Form.Item extra` | `默认沿用事项等级，可改` | 解释型 |
| F3 | `matter-create-dialog.tsx:282` `extra` | `来自配置表，不是硬编码四档` | 解释型 |
| F4 | `risk-create-dialog.tsx:157` `extra` | `可空：来源不明的风险也要能报备` | 解释型 |
| F5 | `risk-create-dialog.tsx:176` `extra` | `留空按今天记` | 解释型 |
| F6 | `risk-detail.tsx:646` `extra` | `留空则用节点类型的默认名` | 解释型 |
| F7 | `risk-detail.tsx:652` `extra` | `可以留空，之后再定。事项节点不支持时间段。` | 解释型 |

#### G 族 — 外壳与登录页（2 条）

| # | 位置 | 原文 | 归类 |
|---|---|---|---|
| G1 | `(auth)/login/page.tsx:78-80` | 字标旁的 `企业内部系统`（11px，`alpha(BRAND.sider.item,.62)`） | 状态型 |
| G2 | `components/app-shell.tsx:166-168` | Header 右侧 `<Tag>{DATA_SCOPE_LABELS[…].zh}</Tag>` → `全公司` | 状态型 |

> G2 是**今天删掉侧栏底部"数据范围 · 全公司"之后，屏幕上关于数据范围的唯一一处**。
> 删掉它，范围就只能靠"打不开某条记录时才知道自己看不见"来推断 —— 那正是
> `.trellis/spec/frontend/quality-guidelines.md:47` 禁止的"把存在但无权说成不存在"。

### A.2 分类计数

| 归类 | 条数 | 占比 | 构成（族内明细） |
|---|---|---|---|
| **计量型** | **24** | 32.0% | A3,A6,A10,A11,A12,A13,A17,A18（8）+ B1,B2,B4,B5,B6,B7,B9×6,B10,B12×3（16） |
| **解释型** | **24** | 32.0% | B3（1）+ C1（1）+ D9,D10,D11,D12（4）+ D14×6（6）+ E3,E4,E6（3）+ F1×3,F2–F7（9） |
| 状态型 | 13 | 17.3% | A4,A7,A8,A9,A14,A15,A16（7）+ E1,E2,E5,E7（4）+ G1,G2（2） |
| 引导型 | 12 | 16.0% | A2,A5（2）+ B11（1）+ D1–D8,D13（9） |
| **复述型** | **1** | 1.3% | A1 |
| 子标题（边界，另计） | 1 | 1.3% | B8 |
| **合计** | **75** | 100% | A18 + B19 + C1 + D19 + E7 + F9 + G2 |

**回答"哪一类占多数"**：并列第一是**计量型 24 与解释型 24**（各 32.0%）。
**复述型今天已经只剩 1 条**——这正是删减的有效性证据，不是"问题还在"的证据。

### A.3 哪些撤掉真的会让人做不了判断

| 类别 | 条数 | 可否一刀切撤 | 依据 |
|---|---|---|---|
| 解释型 24 | 24 | **否** | 逐条理由各不相同：B3 是清单口径；C1 解释为什么本页没有"撤销归档"按钮；D9/D10 解释为什么节点区可以是空的；D11 是**阻塞原因**（没有当事人就转不了案件）；D12/E3/E6 解释不可逆边界；F1–F7 全是"留空会怎样"的字段规则，删掉表单就变成"试一次错一次" |
| 状态型 13 | 13 | **否** | E1/E2 是操作对象（见上）；E5/E7 是空值语义（`未指派处理人` / `已引用库中当事人` 留白会被读成"数据缺失"，`risks-view.tsx:207-208` 已写明）；G2 是范围提示；A4/A14 是第一屏必须可见的状态 |
| 引导型 12 | 12 | **否** | **受 spec 明文保护**：`.trellis/spec/frontend/component-guidelines.md:81`「空态/错误态走 `ui/state-block.tsx`：**说清下一步能干什么**，不留一句"暂无数据"」 |
| 计量型 24 | 24 | **部分** | 20 条是**唯一计数**，删掉用户就不知道自己在第几页 / 看的是不是全量（`DataTable.tsx:78-80` 那条禁令⑧ 的前提就是"调用方不能以为已经拉全了"）；**4 条可删**（A3/A6/A17/A18，都是同屏重复） |
| 复述型 1 | 1 | **是** | A1：标题"今天该动手的"里的"今天"就是这个日期 |
| 子标题 1 | 1 | **可删** | B8："标签"二字在"案件状态"卡里指代不清，且全仓只有这一处用 12px secondary 纯文本当分组标题（B9 那 6 处都带 count） |

**结论：不能一刀切的是 49/75（65.3%）**（解释 24 + 状态 13 + 引导 12）。
可删的是 **6/75（8.0%）**：A1 + B8 + A3/A6/A17/A18。
剩下的 20 条计量型删不删都不影响判断（删了省 20 个字，不删也不产生复述），
**它们不是"过多副标题"的一部分，而是这套界面里唯一在承载数字的地方。**

### A.4 形态相同但**不算**副标题（排除项，共 30 处）

排除理由逐条列在下面，避免读者以为漏数：

| 形态 | 位置（示例） | 为什么不算 |
|---|---|---|
| 列表行内第二行（名字下面那行） | `workbench.tsx:183-186`（`hostCode · hostName · owner · deadlineTime`）、`workbench.tsx:318-321`、`matter-detail.tsx:104`（节点 `remark`）、`:335-338`（当事人类型·证件号）、`:582-584`（评论作者·时间）、`:618`（`下一步：…`）、`:620`、`risk-detail.tsx:429-433`（节点时间）、`:533-534` | 它是**数据的第二属性**（同一实体的另一个字段），不是对上方标题的解释。去掉它等于删字段 |
| 单元格内的短值 | `matters-view.tsx:208` / `risks-view.tsx:224` / `archive-view.tsx:179`（`更新` 列）、`matters-view.tsx:109`（内部编号）、`risks-view.tsx:174`（`未转`）、`:213`（`未指派`）、`matter-detail.tsx:124`（`时间未确认`）、`:134`（`—`）、`deadline-mark.tsx:18`（`未定`） | 它们就是列的值；空值显式写出来是因为"留白会被读成数据缺失"（`risks-view.tsx:207-208`） |
| 表头灰字 | `theme/antd.ts:57`（`headerColor: INK.secondary`） | 表头是列名本身 |
| 字段标签 | `query-filter.tsx:77`（`FilterField` 的 `<label>`）、`status-mark.tsx:63`（`MetaLine` 的 label）、`risk-detail.tsx:737`（`DetailBlock` 的 title div，6 处用法） | 是标签不是说明。`DetailBlock` 的 6 个 title 是**字段组名**（风险描述 / 处置措施 / 当事人 / 参与人 / 登记信息），不是任何东西的副标题 |
| 字段占位符 | 各 `placeholder="…"`（共 20 余处，如 `案号 / 名称 / 案由`、`最多两位小数`） | 占位符只在输入前可见，不是屏上常驻副标题 |

**另一个相邻现象（也记一笔，但不是副标题）**：`app-shell.tsx:148-150` 的 Header 标题取自
`titleOf(pathname)`（NAV 里的 `案件` / `风险事项` / `配置字典`），而同一屏 `DataTable` 的卡片头是
`案件列表` / `风险事项列表` / `配置字典`。Header 说"案件"、卡片说"案件列表"——
这是**两个标题的粒度重叠**，不是标题 + 副标题。收口方案（§B.6.2 第 5 条）顺带给了处置建议，
但它不属于本题的"副标题"计数。

### A.5 `PageHeader` 两个 prop 与 `DataTable` 卡片头的专项核对

**`eyebrow` / `meta`（`page-header.tsx:11-21`）**

| 调用点 | 传了什么 | 删掉后页面失去什么 | 判断 |
|---|---|---|---|
| `workbench.tsx:82-101` | `eyebrow={day}`；`title="今天该动手的"`；`actions={<Button>刷新</Button>}` | 完整日期（含星期几） | **直接删**。标题已含"今天"；时效判断由"逾期节点 / 7 日内到期"两个 `Statistic` 承担，星期几不参与任何判断 |
| `config-view.tsx:59` | 只有 `title="配置字典"` | 无 | **零影响**，本来就不传 |
| `matter-detail.tsx:177-206` | eyebrow = 面包屑 + `internalCode` + `StatusMark` + `FlagMark`×2；meta = 7 个 `MetaItem` | 面包屑、编号、状态徽标、归档/结案徽标、案号/案由/程序/等级/标的额/立案/更新 | **不能一刀切删**：状态徽标是 `page-header.tsx:8` 明写要留在第一屏的；meta 里 6 项是「基本信息」Tab 没有的字段。处置见 §B.6.2 |
| `risk-detail.tsx:127-159` | eyebrow = 面包屑；meta = 6 个 `MetaItem` | 面包屑；编号/状态/风险类型/等级/已转案件/更新 | 同上。其中"已转案件"与"更新"是同屏重复（A17/A18） |

**连带发现（零成本）**：`page-header.tsx` 里 `Section`（:90-111）与 `VDivider`（:113）**全仓零 import**
（`grep -rn 'Section\b\|VDivider' src` 只命中这两行声明本身）。`Section` 恰好是
"`Card` + `SectionTitle` + `extra`" 的一整套卡片头副标题装置 —— 一起删掉等于少一个副标题入口。
另外 `MetaItem`（:55-62）在 `meta` 去掉后也会成为死导出（它的 13 个调用点全在两个 `meta` 槽里）。

**`DataTable` 卡片头（`DataTable.tsx:96-108`）**

结构是 `<h1>{title}</h1>` + `共 {total} 条`（`INK.muted` 12px）。
`DataTable.tsx:29-30` 的注释说明这个安排是刻意的："**标题是页面主标题**：列表页不再单独渲染
`PageHeader`，h1 由这里的卡片头承担，所以读屏拿到的标题层级与视觉层级是同一个。"
**结论：卡片头不该动。** 它是 B1（计量型），不是复述——`共 N 条` 全站只此一处，
列表页没有别的位置告诉用户"这次查一共多少条"。三张列表页共用它，一处改动影响三屏，
**风险收益比最差**。

---

## B. 可行性评估：约束能长什么样

### B.0 本仓禁令的表达方式（读懂才能改）

`tools/lint-guard/README.md:11-12` 写死了机制："规则的**唯一声明处**是
`restricted-imports.mjs`：`eslint.config.mjs` 和 `check.mjs` 都从这里取，所以不存在
'测试用的规则'与'仓库用的规则'分叉。"

| 禁令 | 规则 | 声明处 | 挂载段（`eslint.config.mjs`） |
|---|---|---|---|
| ① shared 纯净 | `no-restricted-imports` | `restricted-imports.mjs:9-26` `SHARED_PATTERNS` | :43-48 |
| ⑦ 体系 | `no-restricted-imports` | `:48-88` `UI_PATTERNS` | :49-57 |
| ⑦ 色值 | `no-restricted-syntax` | `:101-115` `COLOR_RULE` | :58-63 |
| ⑥⑤ 页面壳 | `no-restricted-imports` | `:125-134` `SHELL_PATTERNS` | :64-73 |

**加一条新禁令要动的文件（按 `README.md:33-38` 的"加新禁令的写法"）**：

1. `tools/lint-guard/restricted-imports.mjs` — 新增导出的规则常量（`no-restricted-syntax` 形状：`{ selector, message }` 数组）
2. `eslint.config.mjs` — **新起一个 config 段**。不能塞进 `:64-73` 那段：该段自己的注释（`:66-68`）明写
   "eslint 后段会**整条覆盖**同名规则，只写 SHELL_PATTERNS 的话 page.tsx 就会变成⑦的盲区" ——
   同理，挂进那一段会把 `UI_PATTERNS` 与 `COLOR_RULE` 顶掉。正确形状是照 `:58-63` 那样单起一段。
3. `tools/lint-guard/fixtures/bad/<name>.ts` — 违规样本
4. `tools/lint-guard/fixtures/good/<name>.ts` — 合法样本
5. `tools/lint-guard/check.mjs` — `SCOPES` 加一项（`:31-88` 的形状，**11 个字段**：`id`/`rule`/`bad`/`good`/`badPath`/`goodPath`/`expectHits`/`mountedAt`/`marker`/`mustNotReach`/`whyOverflow`）
6. `tools/lint-guard/README.md:14-19` 的表格加一行
7. `.trellis/spec/frontend/quality-guidelines.md:12` 与 `component-guidelines.md:29-30` 的禁令清单同步
8. **反向红一次**（`README.md:36-38` 硬要求）：在真实路径下临时写违规文件跑 `npx eslint <该文件>`，
   因为 fixtures 目录被仓库 lint 排除（`eslint.config.mjs:37-38`），fixture 通过不代表 config 对真实路径生效

### B.1 候选 1：纯文档约定

**形态**：在 `.trellis/spec/frontend/` 加一节"副标题纪律"，并在 `index.md` 的 Guidelines Index 表加一行。

| 维度 | 评估 |
|---|---|
| 能挡住 | 什么都不挡。`pnpm verify`（`package.json:25`）的五步是 `format:check / lint / typecheck / test / lint-guard`，**没有任何一步读 spec**。spec 是给人和代理读的判据，不是 CI 判据 |
| 挡不住 | `eyebrow`/`meta` 是 `ReactNode`（`page-header.tsx:17,19`），TS 不管、eslint 不管；新页面作者看到 props 里有这两个槽，天然会填 |
| 会误伤 | 无 |
| 谁会第一个顺手加 | 写新详情页的人（或代理）。动机是合法的："状态徽标该在第一屏"（`page-header.tsx:8`）——所以靠纪律压不住 |
| 落地成本 | 1 个新 md + `index.md` 改 1 行。**最低** |
| 证据 | 同仓先例：`.trellis/spec/frontend/quality-guidelines.md:26`「无 `style={{` 覆盖组件默认样式」与 `:30`「键盘导航可用」都是纯人工项，说明这个仓库对"哪些约束要机器化"是有选择的，不是全都要 lint |

### B.2 候选 2：ESLint 规则

**形态**：`no-restricted-syntax` + selector `JSXAttribute[name.name='eyebrow']`（本仓 `COLOR_RULE`
的 `Literal[value=/…/]` 已证明 selector 能匹配 AST 节点，见 `restricted-imports.mjs:105,110`）。

| 维度 | 评估 |
|---|---|
| 能挡住 | 把 `eyebrow` / `meta` 这两个**名字**重新写回 JSX |
| 挡不住 | 换个名字（`sub` / `subTitle` / `hint`）再塞；`Card` 的 `extra="…"` 字符串；`Descriptions` 的 label；`SectionTitle` 的 `count` |
| 会误伤 | `meta` 是通用词。**本仓侥幸没撞**：`grep -rn '\bmeta\s*=' src` 只有 2 处命中（两个 `PageHeader` 调用点），`const { data: meta } = useMeta()` 后面跟的是 ` }` 或 `?.`；`grep -rn '<meta'` 零命中。换个项目/换种写法就会撞 |
| 半径 | 副标题的真正入口是 antd 的 **4 个原生 slot**：`Card/Descriptions` 的 `title`、`Card` 的 `extra`、`Empty`/`Alert` 的 `description`、`Form.Item` 的 `extra`/`help`。全仓 75 处里 **18 处走 `PageHeader` 自己的两个插槽（A 类）**，其余 **57 处**是 antd 原生 slot、不经过 `PageHeader`。一条规则想覆盖它们，误伤面 = 全部列表页 + 全部弹窗 + 全部空态 |
| 谁会第一个顺手加 | 同 B.1。规则拦的只是它恰好叫 `eyebrow` |
| 落地成本 | 8 个文件（B.0），外加一次反向红 |
| 判断 | **性价比最低。**它把"文案的语义判断"伪装成"语法命题"，而语义判断恰恰是这个题目问的那件事 |

### B.3 候选 3：组件 API 层收口 ★推荐主方案

**形态**：把"页面头第二行说明"这个**位置**从 API 里删掉。

```ts
// 改后（草案）
export function PageHeader({ title, code, status, flags, actions }: {
  title: ReactNode;
  code?: ReactNode;      // 与标题同行的主键（事项编号 / 案件内部编号）
  status?: ReactNode;    // StatusMark —— 第一屏必须可见的状态
  flags?: ReactNode;     // 与状态正交的第二个事实（已归档 / 已结案）
  actions?: ReactNode;
})
```

关键不是"少一个 prop"，而是**从"一个能塞任意 `ReactNode` 的副标题行"变成"两件具名的事"**：
状态归 `status`，主键归 `code`，其余字段**必须落到页面里已有的一张字段表**（`Descriptions` / `MetaLine`），
没有地方可塞。

| 维度 | 评估 |
|---|---|
| 能挡住 | 全站唯一的"页面头副标题"入口。**类型上不可表达 ⇒ 不需要任何 lint 规则**，也不需要有人记得门禁 |
| 挡不住 | `Card extra` / `Descriptions` / `Empty description` / `Form.Item extra` 这 57 处——它们是 antd 的 slot，不是本仓的组件 |
| 会误伤 | 2 处面包屑（A2/A5，页内返回链接）与 13 个 `MetaItem` 字段。**必须用"搬迁"兜，不能用"删除"兜**——否则 `matter-detail` 会真的丢掉状态徽标与 6 个字段 |
| 谁会第一个顺手加 | 想加页内返回的人。**加回来的成本是"重新发明一个 prop"，而新 prop 一旦又是 `ReactNode`，收口就白做了** —— 这条要靠 §C 条文第 4 条堵 |
| 落地成本 | `page-header.tsx` 改 props（−~15 行）+ 删 3 个死导出（`Section` / `VDivider` / 连带 `MetaItem`）+ 2 个详情页各搬字段（净增 ~10 行）+ `workbench.tsx` 删 6 行。**不新增任何配置文件** |
| 证据 | 本仓已有同形先例：`DataTable.tsx:29-30` 把"标题承担 h1"写成组件契约，`page-header.tsx:8-9` 把"副信息第几行在全站只有一个答案"写成组件契约。**收口是这个仓库既有的手法** |

### B.4 候选 4：门禁脚本加一条可证伪断言

**形态**：在 `tools/lint-guard/check.mjs` 里加一段**独立于 `SCOPES`** 的源码断言。

⚠ **它不能进 `SCOPES`**：`SCOPES` 的六道断言里，D（`calculateConfigForFile` 看规则是否开着）、
D2（看生效规则内容是否含 marker）、E（看规则不得溢出到某路径）**全都假设存在一条 eslint 规则**。
源码断言没有规则可挂载，硬塞进去会得到一个永远为假的 D。逻辑必须是**另一种断言**。

```js
/**
 * 副标题纪律（2026-10-12）：`PageHeader` 不再提供"什么都能塞"的第二行插槽。
 * 对应 §B.3 的组件收口——**没有 eslint 规则**，所以不进 `SCOPES`（六道断言里有四道是查配置的）。
 *
 * 为什么是词级穷举而不是 AST / `[\s\S]*?` 切片：本仓已经因为后者翻过一次车——
 * `.trellis/spec/frontend/component-guidelines.md:156` 记着"第一版守卫用
 * `function TableHeader[\s\S]*?bg-muted/40`，`[\s\S]*?` 会跨函数漂移到 `TableFooter`
 * 附近，删掉表头底色照样绿"。这里的匹配面小到可以人工逐条核对：
 *   · `\beyebrow\b` 在 src 下只有 7 处（3 个调用点 + page-header.tsx 自身 4 处）
 *   · `\bmeta\s*=` 只有 2 处（两个 PageHeader 调用点）
 *     —— `const { data: meta } = useMeta()` 后面跟的是 ` }` 或 `?.`，不命中
 * 所以"归零"是一个能被列举验证的目标，不是正则碰运气的目标。
 */
const SUBTITLE_FORBIDDEN = [
  { name: "eyebrow", re: /\beyebrow\b/g },
  { name: "meta", re: /\bmeta\s*=/g },
];

// 计数目标由 §A.1 的检索直接给出，提交前必须先让 §B.3 落地，否则这条断言立刻是红的：
//   git grep -c -E '\beyebrow\b'   src   -> 期望 0（2026-10-12 现状 7）
//   git grep -c -E '\bmeta\s*='    src   -> 期望 0（2026-10-12 现状 2）
async function assertNoSubtitleSlots() {
  const { readdir, readFile } = await import("node:fs/promises");
  const walk = async (dir) =>
    (await readdir(dir, { withFileTypes: true })).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : [],
    );
  for (const file of await walk("src/app")) {
    const code = await readFile(file, "utf8");
    for (const { name, re } of SUBTITLE_FORBIDDEN) {
      const hits = code.match(re)?.length ?? 0;
      if (hits > 0) failures.push(`副标题插槽 · ${file} 里还有 ${hits} 处 \`${name}\` —— 页面头不再有第二行说明的位置`);
    }
  }
}
```

| 维度 | 评估 |
|---|---|
| 能挡住 | 把 `eyebrow` / `meta` 精确加回来（`=== 0` 判定，任何一处就是 1，可证伪） |
| 挡不住 | 改个名字（`sub` / `subtitle`） |
| 会误伤 | 当前**零误伤**（两个词在 src 下的全部出现位置已列在 §A.0 的检索命令里）；唯一新增风险是将来有人把局部变量命名成 `eyebrow` |
| 谁会第一个顺手加 | 会换个名字的人 → 所以它只能是**兜底**，不能是主方案 |
| 落地成本 | `check.mjs` 加 ~20 行。**必须在 §B.3 之后落地**，否则第一跑就是红的 |

### B.5 四种方案并排

| | B.1 纯文档 | B.2 ESLint | B.3 组件收口 ★ | B.4 门禁断言 |
|---|---|---|---|---|
| 挡住"页面头副标题"回归 | ✗ | ✓ | ✓ | ✓ |
| 挡住"换个名字再塞" | ✗ | ✗ | ~（§C 第 4 条兜） | ✗ |
| 挡住 `Card extra` / `Form.Item extra` 等 57 处 | ✗ | ✗（4 个 slot，误伤半径覆盖全站） | ✗ | ✗ |
| 需要人记得 | 是 | 否 | 否 | 否 |
| 新增配置文件 | 1 md | **8 个文件** | **0 个** | 1 个文件 +20 行 |
| 误伤面 | 0 | **全部列表页与弹窗** | 2 个详情页的搬迁点 | 0 |
| 误伤可在本轮内消解 | — | 否（需逐个豁免 57 处） | **是**（§B.6.2 给了逐条方案） | — |

### B.6 推荐方案（可直接实施）

> **组件 API 收口（B.3）为主 + 门禁源码断言（B.4）兜底 + spec 条文（§C）裁决搬迁目的地。**
> 不选 ESLint（B.2）：它把语义判断伪装成语法命题，而 57/75 的副标题根本不经过 `PageHeader`。

#### B.6.1 先决条件与顺序

1. **先做 B.3**（`page-header.tsx` 改 API + 4 个调用点搬迁）
2. **再做 B.4**（否则门禁第一跑就红）
3. **再贴 §C 条文**（它是 B.3 搬迁的裁决依据，不是 B.3 的前置）

#### B.6.2 组件改动清单（4 个文件）

| 文件 | 改动 | 信息往哪去 |
|---|---|---|
| `src/app/components/page-header.tsx` | ① 删 `eyebrow`（:12,17,25-29）与 `meta`（:14,19,38-47）两个 prop 及其渲染分支；② 新增 `code` / `status` / `flags` 三个具名 prop（与 `title` 同行 `Flex`，`INK.muted` 12px 只给 `code`）；③ 删死导出 `Section`（:90-111）、`VDivider`（:113）、`MetaItem`（:55-62）——`Section` 与 `VDivider` 当前就是全仓零 import；`MetaItem` 现有 13 处调用（`matter-detail.tsx` 7 处、`risk-detail.tsx` 6 处），但**全部在两个 `meta` 槽内**，本次改完即成死导出；④ 同步删 :5 的 `Divider` import | 无（改完后三者无人用） |
| `src/app/(desk)/workbench.tsx:82-101` | 删 `eyebrow={day}`（A1，复述型）；`:45-50` 的 `day` 常量随之成为死代码，一并删 | **直接删**。"今天该动手的"已含"今天"；星期几不参与任何判断 |
| `src/app/(desk)/config/config-view.tsx:59` | **零改动**（本来就不传两个 prop） | — |
| `src/app/(desk)/matters/[id]/matter-detail.tsx:177-206` | ① `eyebrow` 的面包屑（A2）→ **删**：侧栏 `app-shell.tsx:52` 的「案件」已是返回路径，页内返回是第二套；② `eyebrow` 的 `internalCode`（A3）→ **删**：同屏 `Descriptions:221-225` 已有；③ 状态徽标 + `已归档`/`已结案`（A4）→ 收进新 `status` / `flags`；④ `meta` 里 `案号`（A6，同屏重复）→ **删**；⑤ `案由`/`程序`/`等级`/`标的额`/`立案`/`更新`（A7–A12）→ **搬进**「基本信息」Tab 的 `Descriptions`（`:217-247` 现有 9 项，加 6 项 = 15 项，`column={{xs:1,sm:2,lg:3}}` 下 5 行） | 全部搬进已有的 `Descriptions`，**净信息损失 0**，只是从"页头第二行"挪到"Tab 第一屏" |
| `src/app/(desk)/risk-matters/[id]/risk-detail.tsx:127-159` | ① `eyebrow` 面包屑（A5）→ **删**（侧栏 `app-shell.tsx:54-57` 的「风险事项」已是路径）；② `meta` 的 `状态`（A14）→ 收进 `status`；③ `编号`（A13）→ 收进新 `code`，与标题**同行**（编号不是副标题，它和名称是同一个名词的两个面）；④ `风险类型`/`等级`（A15/A16）→ 搬进右栏「标题与归属」卡片（`:215-235` 已有 `MetaLine` 三行：经办人/发现日期/敞口金额）；⑤ `已转案件`（A17，同屏重复于 `:298-315` 卡片）与 `更新`（A18，同屏重复于 `:285`）→ **删** | 全部搬进已有的卡片 / 改为同行主键，**净信息损失 0** |

**顺带（低成本、零风险、建议同批）**：

- **A.3 / A.6 / A.17 / A.18 这 4 条同屏重复**：上面已随搬迁消掉 —— 它们正是今天删 `SCOPE_HINT` 的同一条判据（`theme/antd.ts` 末尾注释："把范围谓词复述成了第二份说法"）
- **A1**（workbench 星期）与 **B8**（`config-view.tsx:73-75` 的「标签」子标题）：直接删。`config-view.tsx:16` 的注释说这张页的价值是"为什么这个能改那个不能改"，
  而「标签」二字在"案件状态"卡里指代不清（案件标签）；可并入 `B9` 那套 `EnumBlock` 样式或直接提到卡片标题里
- **B4**（`workbench.tsx:291-295` 裸数字 `extra`）：与同页 `B1` 的「共 N 条」不一致。建议改成与 `SectionTitle` 同形（`页-header.tsx:78-82` 的 count 样式），
  或者直接删——它与列表长度是同一个数
- **`app-shell.tsx:148-150` 的 Header 标题**（§A.4 末尾的相邻现象）：与 `DataTable` 卡片头粒度重叠。
  低风险处置：Header 改显示 `NAV` 的 `label`，列表页的卡片头去掉「列表」二字（`案件列表`→`案件`）——
  但这会动三张列表的 h1 文案，**需产品点头，不在本题范围**

#### B.6.3 门禁草案（`tools/lint-guard/check.mjs`）

如 §B.4 所列。三个必答项：

- **形态**：独立断言块，**不进 `SCOPES`**（理由：`SCOPES` 的 D/D2/E 三道断言的前提是"存在一条 eslint 规则"，源码断言没有配置可挂载）。
  调用点放在 `check.mjs:152`（`if (loaded === 0)` 之前）与 `:154`（失败汇总）之间。
- **`expectHits` 怎么推**：**推荐方案不产生 `expectHits`** —— 它不是 eslint 规则，没有 `messages` 可数。
  源码断言的数字是 `=== 0`，推导依据是 §A.0 的两条检索：
  `\beyebrow\b` 在 src 下 7 处（3 调用点 + 组件自身 4 处）、`\bmeta\s*=` 2 处 —— 组件收口完成后两者都归零。
- **`marker` 为什么要写禁令原文标记**（这条对 B.4 不适用，但对备选的 B.2 必需，附在此处以免漏）：
  `check.mjs:138` 用 `JSON.stringify(mountedRule).includes(scope.marker)` 判断"生效的是不是本 scope 的规则"，
  `:147` 用同一个办法判断"规则有没有溢出"。marker 必须出现在规则 **options 里**（即 `message` 原文）才能区分
  "这条规则"与"同名但内容不同的规则"。写成配置里不存在的词 → D2 永远红；写成通用词（如「副标题」）→
  可能撞上别的规则。两种都是假信号。**这正是 `check.mjs:19-20` 注释里说的"只看规则在不在是不够的"**。
- **反向红一次**（`README.md:36-38` 硬要求）：`check.mjs` 的断言不走 eslint，fixtures 目录也被排除
  （`eslint.config.mjs:37-38`），所以要**手工验证**：把 `SUBTITLE_FORBIDDEN` 的 `=== 0` 临时改成 `=== 2`，
  确认 `workbench.tsx` 与 `matter-detail.tsx` 两处命中被报出来，再改回去。

#### B.6.4 若坚持走 ESLint（备选，不推荐）

`tools/lint-guard/restricted-imports.mjs` 追加：

```js
export const SUBTITLE_RULE = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "JSXAttribute[name.name='eyebrow']",
      message: "禁令⑨：PageHeader 不再有第二行说明的位置；要放状态用 status，要放主键用 code",
    },
    {
      selector: "JSXAttribute[name.name='meta']",
      message: "禁令⑨：PageHeader 不再有第二行说明的位置；字段请落到页面上已有的 Descriptions / MetaLine",
    },
  ],
};
```

`eslint.config.mjs` **新起一段**（照 `:58-63` 的形状，绝不能塞进 `:64-73` 那段——该段注释 `:66-68`
已警告"后段 config 会整条覆盖同名规则"）：

```js
{
  files: [UI_FILES_GLOB],
  rules: SUBTITLE_RULE,
},
```

`tools/lint-guard/check.mjs` 的 `SCOPES` 加一项：

```js
{
  id: "禁令⑨ 副标题插槽",
  rule: "no-restricted-syntax",
  bad: "tools/lint-guard/fixtures/bad/page-header-subtitle.ts",
  good: "tools/lint-guard/fixtures/good/page-header-no-subtitle.ts",
  badPath: "src/app/components/__guard_bad__.tsx",
  goodPath: "src/app/components/__guard_good__.tsx",
  expectHits: 2,                       // 见下方推导
  mountedAt: "src/app/(desk)/matters/probe.ts",
  marker: "禁令⑨",                      // 必须出现在 message 原文里，见 B.6.3
  mustNotReach: "src/app/theme/brand.ts",
  whyOverflow: "brand.ts 不渲染 JSX，扩到它没有意义；而挂到 src/shared/** 更不对——那里没有 ReactNode",
}
```

- **`expectHits` 的推导规则**：`check.mjs:110` 过滤的是 `m.ruleId === rule && m.severity === 2`，
  即 **bad fixture 里被触发的 AST 节点数**，不是行数。
  对照两个既有用例可验证这个推导：`fixtures/bad/hardcoded-color.ts` 有 4 个色值字面量 → `expectHits: 4`（`:69`）；
  `fixtures/bad/ui-direct-primitive.ts` 有 10 条 import（`:6-15`）→ `expectHits: 10`（`:54`）。
  本案 bad fixture 写**两个**违规调用点（一个 `eyebrow=`、一个 `meta=`）→ `expectHits: 2`。
  写两个而不是一个，是因为只写一个的话"另一个 selector 写坏了"不会被发现 —— 这就是 `check.mjs:13-14`
  注释说的"只断言 >0 不够：十条 group 写坏九条也照样绿"。
- **bad fixture 代码**：

```ts
/** 故意写坏：禁令⑨ —— PageHeader 的"第二行说明"插槽已从 API 删掉。 */
import { PageHeader } from "@/app/components/page-header";

export const bad = (
  <PageHeader
    eyebrow={<span>2026年10月12日星期一</span>}   // 1/2 违规
    title="今天该动手的"
    meta={<span>在办 12</span>}                   // 2/2 违规
  />
);
```

- **good fixture 代码**（`check.mjs:124-130` 的 C 断言要求 0 命中）：

```tsx
/** 合法：新 API 的三个具名槽 + 操作区。 */
import { PageHeader } from "@/app/components/page-header";

export const good = <PageHeader code="FX-0031" status={<Badge status="success" text="已结案" />} title="某某案" />;
```

- **这条备选方案的净评价**：能挡住精确名字，挡不住 57 处 antd 原生 slot，且要动 8 个文件。
  **只在 §B.3 已落地、但仍担心有人"为了加个说明"重新发明 prop** 时，才值得加它当第二道。

---

## C. 约束条文草案

> 落点建议：`.trellis/spec/frontend/component-guidelines.md` 新增一节（该文件 `:8-9` 已经在管
> "副信息第几行在全站只有一个答案"）；同时在 `index.md:28` 的 Guidelines Index 表补一行指向它。
> 若独立成 `copy-discipline.md`，需在 Index 表加一行 —— 现有 Index 表（`index.md:20-28`）是一文件一行的形状。

---

### 页面头与标题下的第二行说明（副标题纪律）

**默认没有第二行。** 标题下面（或标题旁边）默认不挂灰色说明文字。需要多说什么时，
信息必须落到下面四类位置之一；落不进去，说明这句话**本来就不该存在**。

**为什么**（2026-10-12 实测，本仓自有证据）：

1. 副标题在内部系统里的失败模式不是"解释得不够"，是**"同一屏里把同一件事说了两遍"**。
   那天撤掉的三处——登录页"用公司账号…"、左栏"风险事项 · 案件"、侧栏"数据范围 · 全公司"——
   共同点都是紧邻位置已经说过一遍（标题说过 / 菜单就在正下方 / Header 右侧已有范围标签），
   判据写在 `src/app/theme/antd.ts` 末尾那段注释（"范围已经在 Header 标签上说过一遍，
   而那行散文把范围谓词复述成了第二份说法。"
2. 删到 75 条枚举只剩 **1 条复述型（1.3%）** 时，同屏重复还剩 **4 处**（本文 §A.1 的 ⚠ 四条）。
   这说明**这类问题会自己长回来**：新加一个详情页，"编号/状态/案号"最自然的下落点就是页头第二行。
3. 一句说明的成本不是那 20 个字，是它**占掉了标题下方那块空白**。
   `src/app/(auth)/login/page.tsx:60-62` 记着：脚注在时 `space-between` 把三样东西摊开，
   撤掉后只剩两样再 `space-between`，中间会空一大块 —— 同一句话既多占了位置又制造了空场。

#### 允许出现第二行说明的四种落点

| 落点 | 形态 | 本仓既有用例 |
|---|---|---|
| **① 空态 / 错误态** | `ui/state-block.tsx` 的 `hint`，或 `DataTable` 的 `empty` | `matter-detail.tsx:270`（"节点是提醒的唯一入口：确认时间并设了期限，才会进工作台的到期清单。"） |
| **② 字段说明** | `Form.Item` 的 `extra` / `help`，`placeholder` | `status-dialog.tsx:100-106`（"走推荐路径，不需要原因；写了会一起进活动记录。"） |
| **③ tooltip / `title`** | 悬停才出，不占常驻版面 | `risks-view.tsx:170`（`FlagMark title={\`已由该事项建了 ${n} 个案卷\`}`） |
| **④ 折叠区 / 详情卡里的字段表** | `Descriptions`、`MetaLine`、`DetailBlock` | `matter-detail.tsx:217-247`（基本信息 Tab）、`risk-detail.tsx:282-290`（登记信息） |

**另有一类不算副标题、但必须在第一屏**：`PageHeader` 的 `status`（状态徽标）与 `flags`
（已归档 / 已结案这类与状态正交的第二个事实）。它们不是对标题的解释，是**标题之外的那个事实本身**。
同理，与标题**同行的主键**（案件内部编号、事项编号）不是副标题 —— 编号和名称是同一个名词的两个面，
横排放是"主键 + 名称"，竖排放才是"标题 + 副标题"。

#### 不允许的四种形态（反例）

| ❌ 反例 | 为什么不行 | 正确做法 |
|---|---|---|
| 菜单名下面再写一遍菜单名<br>`风险事项 · 案件` 挂在 `MatterNest` 字标下，而正下方就是菜单 | 屏幕可见、信息量为零；菜单就在一屏之内 | 直接删（`app-shell.tsx` 的字标 div 现在只留 `MatterNest`） |
| 同一屏的第二个位置重复同一事实<br>Header 右侧已有 `全公司` 标签，侧栏底部再写"数据范围 · 全公司" | 范围只剩一处可见时反而更弱——读者要在两处之间比对 | 保留一处（`app-shell.tsx` 的 Header 右侧 `Tag`） |
| 标题里已含的词再作为副标题<br>标题「今天该动手的」下面写「2026年10月12日星期一」 | "今天"就是那个日期 | 直接删（本文 §A.1 的 A1） |
| 页面头 `meta` 里塞"基本信息 Tab 已经有了"的字段<br>页头写「案号」，同屏 Tab 的 `Descriptions` 里又有「正式案号」 | 同屏两处同一个值；两处将来会不同步 | 页头只留第一屏必需的状态与主键，字段回 Tab |

#### 三条执行口径

1. **删一条副标题，要先回答"这条信息搬去哪"**。搬不进去、且没有第二处出现过 —— 才删。
   本文 §B.6.2 的搬迁表是这一条的操作版本。
2. **不许用"换个位置"绕过这条**。把页头 `meta` 里的字段原样挪进 `Section` 的 `extra` 不算解决，
   那只是换了插槽。（`Section` 已在 §B.6.2 的删除清单里。）
3. **反例里的四条，逐条对应一次已经发生的回归或残留**。新加详情页时对着这四条看一遍，
   比看规范条文有效。

---

## D. 未验证 / 存疑项

1. **没有跑过浏览器**。本轮全部结论来自源码与检索。**没有验证**："删掉这 4 条同屏重复后页头会不会塌"、
   "把 6 个字段搬进「基本信息」Tab 后 1180px 容器里 15 项 `Descriptions` 会不会过高"、
   "workbench 去掉星期几后页头左侧的留白节奏"（`page-header.tsx:23` 的 `marginBottom: 12`）。
   这些要用 `.trellis/spec/frontend/component-guidelines.md:150-152` 的同源 iframe 固定视口实测法量，
   不能靠看截图下结论。
2. **按要求未跑 `pnpm verify` / `pnpm build` / 任何写库脚本**。因此：
   - §B.6.2 的改动清单**未经编译验证**（`MetaItem`/`Section`/`VDivider` 三个死导出的判定基于
     `grep -rn 'Section\b\|VDivider\|MetaItem' src`，检索面覆盖 `src/`，但没有跑 `tsc --noEmit` 确认）
   - §B.4 的断言代码是草案，**没有实跑过**（没有跑 `node tools/lint-guard/check.mjs`）
   - 已知无关失败：`enum-check.spec.ts` 当前挂一条，来源是工作区里那份在制改动
     （`src/shared/enums/targets.ts`、`src/app/lib/server/db/schema/collab.ts`、
     `src/app/lib/server/db/migrations/0006_activity_log_user_scope.sql`、
     `docs/PRD-phase1-enums-and-schemas.md`）。**与本文无关，未做任何改动**
3. **A 族的归类含两处主观判断**，已在表里标出供反驳：
   - **A1**（workbench 的日期）判为"复述型"：理由是标题已含"今天"。若产品认为"星期几"是有用信息，
     它就变成计量型，那么复述型归零、A1 需另找落点。本文按"不做无依据判断"归入复述型。
   - **E1/E2**（弹窗里的"改的是哪一条"）判为"状态型、不可删"：理由是弹窗遮住了背后的页面头。
     若产品认为页头信息在弹窗背后仍可见，那它们就变成复述型、可删。**这一条需要产品点头。**
4. **B8**（`config-view.tsx:73-75` 的「标签」）单列为"子标题（边界）"，没有归入五类。
   它既不是解释也不是计数，是否算副标题取决于"分组标题算不算标题"的界定。
5. **57/75 这个数字有口径依赖**：它建立在"副标题 = 挂在标题附近的灰/小字说明"这个定义上（§A.0）。
   若把"行内第二行"（§A.4 的 30 处）也算进来，计量型会涨到约 40 条、总数约 105 条，
   但**分类结论不变**（解释型与计量型仍并列第一，复述型仍然极少）。
6. **外部一手来源只引了一处**：antd 6 的 `Pagination` 无 `showTotal`
   （`node_modules/antd/es/pagination/Pagination.js`，检索无命中）。本文没有引用
   Material Design 或 WCAG 的副标题规范——题目问的是"这个项目里"，一手材料是本仓自身，
   仓外规范只能提供"应该怎么做"的通用建议，不构成本仓现状的证据。若要把 C 节升级成
   "对齐全站设计规范"，那需要另开一轮并引 MD/WCAG 原文。
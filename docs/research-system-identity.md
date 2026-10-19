# 系统身份：该不该为自动化规则建一个「系统用户」行？

> 研究日期 2026-10-19 · 承接 MATT-72「P12 自动化规则页」的阻塞 1（规则 1 `preset_01_close_auto_archive` 要写 `ARCHIVED` 审计，而审计的 `operator_id` 是 NOT NULL 外键）。
>
> 标注口径：**［来源］** = 一手来源原文（官方文档 / 官方规范 / 官方源码）；**［实测］** = 本仓读码或读库得出；**［推断］** = 我的判断。
> 一手来源：Kubernetes 官方文档（`kubernetes.io`）、AWS CloudTrail 官方文档（`docs.aws.amazon.com`）、Salesforce 官方 Help（`help.salesforce.com`）、OWASP Cheat Sheet Series 与 OWASP Non-Human Identities Top 10 官方项目页、NIST SP 800-92 官方页。**二手博客一篇未引**。
>
> 术语以仓库根 `GLOSSARY.md` 为准。本文只回答一个窄问题，**不复议**权限草案 §8 已有的裁定本身（见 §3）。
>
> **⚠ 落地状态（2026-10-19 补记）**：本文写完之后，MATT-72 阻塞 1 **当天就落地了** ——
> `operator_id` 已放开 NOT NULL（迁移 `0016`），规则 1 有了执行体，方案见 §9 的落地回写。
> 所以下面正文里「`operator_id` 是 NOT NULL 外键」这类**现在时描述是写文时的状态**，不是今天的库结构。
> 沿读时请以 §9 与本文件末的核实表为准。

---

## 1. 短答

**「要不要建一个系统行」这个问题问反了 —— 真正该问的是「审计的 actor 列该怎么表达『没有人』」。**

行业里两条路都有人走，但它们回答的是**两个不同的问题**：

- **Salesforce 建了行**（`Automated Process User` / `System User`），但它建的是**平台内置的、管理员改不动的实体**，不是「在用户表里插一行」［来源］。
- **AWS 与 Kubernetes 都不建「用户行」**：CloudTrail 用一个 `type` 枚举区分 `IAMUser` / `AssumedRole` / `AWSService`［来源］；Kubernetes 用 `system:` **前缀命名空间**表示系统身份，并且**在用户校验规则里显式禁止外部身份冒用这个前缀**［来源］。

而**唯一一条正面点名这件事的安全规范**是 OWASP NHI Top 10 的 NHI10:2025，它把「人与自动化的动作不可区分」直接列为风险项，并给的缓解措施是「审计并监控 NHI 的活动，**让人对 NHI 的使用可检出、可追责**」［来源］。

**所以结论是：方向正确（系统动作必须与人的动作可区分），但「在 `mn_app_user` 里插一行」是最差的那一种实现**——因为它同时踩中 OWASP NHI10 想防的每一件事（见 §4）。本仓权限草案 §3/§8 早就写下了与此一致的口径（「**不建 `app_user` 行**，用常量 id」），只是**库结构从未兑现它**（见 §3）。

---

## 2. 设计空间：三条路，各自被谁用过、什么时候会坏

| 方案 | 是什么 | 谁在用（一手来源） | 什么时候坏 |
|---|---|---|---|
| **A. 哨兵行（sentinel row）**：在 `app_user` 里插一行 `system`/`bot` | 一个**真实的用户行**，充当「系统」的 actor | Salesforce 的 `Automated Process User` / `System User`；GitHub Actions 的 `github-actions[bot]` ［来源］ | 见 §4 六条 —— 本仓会同时踩中：登录面、用户列表、选人面、外键 RESTRICT、席位/统计口径 |
| **B. 可空 FK（nullable actor）**：`operator_id` 允许 NULL，NULL = 系统 | actor 列**可为空**，空即「非人」 | OWASP Logging Cheat Sheet 把 `Who` 明写成 **"Who (human or machine user)"**，即该字段本身就要承载两种主体 ［来源］；OpenStack `system` scope / AWS `AWSService` 同构 ［来源］ | 空值语义要靠约定（NULL 是「系统」还是「未知」？）；所有读侧要处理 null；`NOT NULL` 契约被放宽 |
| **C. actor 类型列 + 常量 id**：`operator_id` 存一个**永不对应任何真实用户行**的保留常量，另用枚举/前缀标明它是系统 | 值域里划出一段「系统专用」，与真实用户 id 不重叠 | Kubernetes `system:` 前缀 + `system:serviceaccount:*` ［来源］；AWS CloudTrail `type` 枚举 ［来源］ | 常量值必须**不可能与真实 id 冲突**；FK 约束会拦住它（本仓现状，见 §3） |

**三条路的共同点**：都把「系统动作」表达成一种**可与人类主体区分**的形态。差别只在**区分点放在哪一层**：A 放在「行存不存在」，B 放在「值空不空」，C 放在「值的域」。

**行业主流是 B/C，不是 A。** A 只被两类系统采用：① 平台内置、用户不可改的实体（Salesforce）② 本来就是「机器为主、人偶尔用」的账号体系（CI bot）。本仓是**人为主的案卷系统**，属于 B/C 的适用场景。

---

## 3. 本仓现状：规格已经裁过，库结构没兑现

### 规格怎么写的

权限草案 §3 末行 ［实测，`docs/PRD-phase1-permission-design-draft.md:97`］：

> 系统内部身份（`operator = SYSTEM`）**不建 `app_user` 行**，用常量 id，特权恒为假（§8）。

权限草案 §8 ［实测，`:230`］：

> 规则以 `operator = SYSTEM` 执行，**绕范围但不绕只读**：可读范围限定在触发记录及其直接关联。

**注意**：规格明确说的是「**不建行**、用**常量 id**」——这正是上面的**方案 C**，不是方案 A。它甚至规定了特权恒假（`privileges` 全 false）。

### 库结构怎么写的

［实测］`mn_activity_log.operator_id`：

- `0000_mn_baseline.sql:343` → `"operator_id" bigint NOT NULL`
- `0000_mn_baseline.sql:406` → `FOREIGN KEY ("operator_id") REFERENCES mn_app_user(id) ON DELETE RESTRICT`
- `schema/collab.ts:90-92` → drizzle 侧同形（`.notNull().references(() => appUser.id, { onDelete: "restrict" })`）

**所以规格说的「常量 id」今天写不进去**：`SYSTEM` 不是数字就类型不符，编一个数字又必然撞 FK（除非那个 id 恰好有真实行）。这就是阻塞 1 的物理成因——**不是代码没写，是规格与库结构对不上**。

### 一个已经存在的旁证：`AUTO_RULE_*` 三个动作

［实测］`ck_mn_activity_action` 的值域里**早就有** `AUTO_RULE_EXECUTED` / `AUTO_RULE_SKIPPED` / `AUTO_RULE_FAILED`（`0000_mn_baseline.sql:349`，并经 0002/0008/0014 三次迁移保留至今）。也就是说**库结构当初就为「自动化规则的审计」留了位**，只是没人走到那条路——今天库里 `AUTO_RULE_*` 审计行是零行（既有规则 4/7/9 只写 `mn_notification_event`，那张表没有 operator 列）。

⇒ **这不是「要不要支持系统动作」的问题，是「支持到一半」的问题**：动作名备好了，actor 的表示没备好。

### 另一条同源的历史证据

［实测］`docs/survey-missing-seams.md:31` 在同一个表上**已经记录过**这处硬约束（当时是为了讨论「拒绝留痕」）：

> 更硬的约束在库上：`target_id bigint NOT NULL`（`0000_mn_baseline.sql:340`）、`operator_id bigint NOT NULL`（`:343`）、`target_type` 只有 7 个取值……

即：`operator_id NOT NULL` 这个约束**已经挡过一件事了**，这是第二次挡。**同一处约束连着挡两件合法需求，说明它是设计时没考虑「非人主体」**，而不是「这两件事本就不该做」。

---

## 4. 为什么不建议哨兵行：六条会被踩中的坑

以下每条都标注了它是**行业证据**还是**本仓实测**。

**① 认证面：一个永不该登录的账号，住在登录表里。**

［实测］本仓登录校验在 `auth.ts:198`：只要 `is_enabled && activation_status === 'active' && !is_deleted` 就放行。哨兵行必然满足这三条（否则它自己就会被 `listSelectableUsers` 那三个条件筛掉、无法被引用）。

⇒ 它与真实账号**走同一套校验**。今天它登不进去**只是因为没人给它设口令**（`password_hash` 为 NULL ⇒ `verifyPassword` 返回 false）——**这是一条靠「碰巧」成立的防线，不是一条被守住的防线**。对比 Salesforce：它的 `Automated Process User` 明确写着「**cannot be deactivated, modified, or deleted**」且是**平台内置实体**，认证面在平台层就切断了［来源］。

**② 用户列表与选人面：它会露出来。**

［实测］`users.ts:96` 的 `listUsers()` **没有任何过滤**（只按 username 排序）；`selectable-users.ts` 的三个条件是 `is_enabled` + `active` + 共现集，同样不排除系统行。

⇒ 建了哨兵行，它会出现在「用户与角色」页里，**并且可能被选为案件经办人/关注人**。要挡住得**到处补特例过滤**——而每一处漏补都是一个静默的口子。

**③ 席位与统计口径：多一个假装是人的行。**

［实测］本仓一期没有席位计费，但「人员工作量」这类按人聚合的报表是 master §7 明确列的未来项（§9 那张表里点过名）。哨兵行一旦存在，任何 `count(users)` / 按 operator 聚合的口径都要**额外记得排除它**。

**④ 外键 `ON DELETE RESTRICT` 会变成隐形的钉。**

［实测］`operator_id` 的 FK 是 `ON DELETE restrict`。哨兵行被审计引用之后，它**既不能被删**（RESTRICT），又**必须永远存在**。这本身不致命，但它意味着「这个账号」在数据层面成了**永久不可变的存在**——而它不是平台内置实体（Salesforce 那种），是**本仓自己插的一行**，却承担了平台内置实体的语义。

**⑤ 审计可读性：读侧要显式处理它。**

［实测］读侧用的是**子查询**而非 INNER JOIN —— `matters.ts:300` 与 `overview.ts:120` 都是：

```sql
(select u.display_name from mn_app_user u where u.id = operator_id)
```

⇒ 好消息：哨兵行**不会让查询炸**（子查询对缺失行返回 NULL，不破坏行数）；坏消息：**它会让审计显示「系统管理员 admin 归档了此案」**，而真相是「规则引擎自动归档」。子查询给了 display_name，而 display_name 是「系统管理员」——**审计说谎了**。

［来源］OWASP NHI10:2025 把这类后果点名列为风险：「**Lack of detailed auditing and accountability**」（缺乏细致的审计与追责）与「**Indistinguishable activity between humans and automation**」（人与自动化的活动不可区分），其危害是「any actions they perform are logged under the service account, **obscuring accountability**」（动作被记到服务账号名下，**掩盖了责任归属**）。

**⑥ 最反直觉的一条：哨兵行恰恰制造了 OWASP NHI10 那个漏洞。**

OWASP NHI10 讲的是「人盗用机器身份」。但**反过来也成立**：把机器动作记成**某个具体人**，就是「人手写的动作被记成 admin 做的」——**审计链上这两个方向的混淆是同一个缺陷**。用 admin（id=101）当系统 actor，等于让**所有自动归档都顶着管理员的签名**；一旦将来要追「这批归档是谁批的」，答案是**不可回答**的。

［来源］OWASP NHI10 的缓解措施第一条是「**Use dedicated identities**」——注意是 **dedicated**（专用的），不是「借一个现成的」。

---

## 5. 那正确做法是什么：Kubernetes 与 CloudTrail 的共同答案

两条最有说服力的一手证据，都是**不建用户行**的：

### Kubernetes：用**命名空间前缀**区分，并**主动禁止冒用**

［来源］`kubernetes.io/docs/reference/access-authn-authz/authentication/`：

- 「All Kubernetes clusters have two categories of users: **service accounts** managed by Kubernetes, and **normal users**.」——**两类主体，不是一类**。
- 系统身份走前缀：service account 认证为 `system:serviceaccount:(NAMESPACE):(SERVICEACCOUNT)`；节点为 `system:node:<name>`；未认证为 `system:anonymous`。
- 关键的一条——**用户校验规则显式禁止外部身份使用这个前缀**：

```yaml
userValidationRules:
- expression: "!user.username.startsWith('system:')"
  message: 'username cannot used reserved system: prefix'
```

文档演示了这个规则**真的会拒绝**：把一个 token 的 claim 映射成 `"system:" + claims.username`，结果是 `401 Unauthorized`［来源］。

⇒ Kubernetes 的做法翻译过来是：**（a）系统身份用保留命名空间；（b）这个命名空间对外部身份是禁止进入的**。它防的正是「人伪装成 system」。

### AWS CloudTrail：用**类型枚举**，不是「多一个用户」

［来源］`docs.aws.amazon.com/.../cloudtrail-event-reference-user-identity.html`，`userIdentity.type` 的取值包括：

`Root` / `IAMUser` / `AssumedRole` / `Role` / `FederatedUser` / `Directory` / `AWSAccount` / **`AWSService`** / `IdentityCenterUser` / `BuilderIdUser` / `Unknown`

- `AWSService`：「The request was made by **an AWS account that belongs to an AWS service**」。
- 另有一个 `invokedBy` 字段：「The name of the AWS service that made the request, **when a request is made by an AWS service**」。
- 对服务发起的动作，`userName` 一栏是 **「Not present」**——**AWS 明确不给服务主体编一个用户名**。

⇒ 这是**方案 C 的教科书形态**：actor 的类型是一等公民（`type`），而「人」只是其中一种。**没有为了表达「服务干的」而去 `IAMUser` 表里插一行。**

### OWASP Logging Cheat Sheet：`Who` 一栏本来就写着两种主体

［来源］`cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html`，Event attributes 一节：

> - **Who (human or machine user)**
>   - Source address e.g. user's device/machine identifier, …
>   - User identity (if authenticated or otherwise known) e.g. user database table primary key-value, username, license number

并且有独立的一条：**User type classification** e.g. public, authenticated user, CMS user, search engine, authorized penetration tester, uptime monitor［来源］。

⇒ 规范要求的 audit record 里，`Who` **本来就是「人或机器」两值**，且另有一栏做**主体类型分类**。**它从未假设 `Who` 只能填人类用户的 id。**

### NIST SP 800-92

［来源］NIST 官方页（`csrc.nist.gov/pubs/sp/800/92/final`）定位为「Guide to Computer Security Log Management」；其记录要求由 OWASP Cheat Sheet 转述为「application logs must record **"when, where, who and what"** for each event」［来源，OWASP 转述］。

⇒ NIST 本身**没有**明文要求「actor 必须是人类用户表的外键」——**它要求的是「who」可记录**。把 `who` 限死成 FK→用户表，是**实现选择**，不是规范要求。**我没有找到任何权威规范要求「审计 actor 必须非空且指向人类用户表」。**（见 §8）

---

## 6. 针对本仓的建议

［推断］综合上面，建议**方案 C 的一个具体形态**：

1. **保留一段 id 段位当系统主体**，例如 `mn_app_user.id` 现有的低号段纪律之外，另定一个**永不对应真实行**的保留值（本仓已有 `8xxx` 低号段先例，但那是**真实行**的号段，不能混用）。同时**把 actor 类型写进审计**——本仓已有现成的落点：`payload` 列（`AUTO_RULE_*` 三个动作的载荷本就要写 `{rule_id, rule_name, action_type, target_ids, event_id}`，见 `docs/PRD-phase1-enums-and-schemas.md:129`）。
2. **`operator_id` 改为可空**，系统动作写 `NULL`。这是「放宽 NOT NULL 契约」的代价，但它是**最小**的：读侧已经是子查询（`matters.ts:300` / `overview.ts:120`），`NULL` 只会让子查询返回 `NULL` 而**不破坏任何行数或 join**；DTO 的 `operator: string` 需要改成 `string | null`（`api.ts:289` / `api.ts:514` 两处），前端 `matter-detail.tsx:629` 的 `{a.operator}` 要有个「系统自动化」的显示分支。
3. **显式禁止人与系统的混淆**（Kubernetes 那条 `userValidationRules` 的本仓对应物）：`logActivity` 的 `Actor` 入参应当新增一条「系统 actor」路径，**而不是让调用方伪造一个 Actor**。今天的 `logActivity(tx, actor, …)`（`activity.ts:14-40`）拿的是 `Actor`（`auth.ts:101`），系统动作没有 `Actor`——这正是要补的那个缝。
4. **不要碰 admin（id=101）**。理由见 §4⑥：它会让所有自动归档顶着管理员的签名。

**要不要直接采用「可空」还是「保留常量 + 可空」**：［推断］两者都行。可空的优点是**语义简单**（NULL = 无人），缺点是 NULL 在 SQL 里与「未知」同形；保留常量的优点是**值与类型都可筛**（`operator_id = <保留值>`），缺点是 FK 仍然拦着——**除非同时放宽 FK 或改用 CHECK 约束**。**这条要人拍**（见 §9）。

---

## 7. 一句话给产品

**「加一个系统账号」这件事，Salesforce 那条路（平台内置、人改不动）在你这里是学不来的——因为你没有一个平台层能把它锁住。你能学的只有 Kubernetes/AWS 那条：系统不占用户表的一行，而是在「谁」这个字段里用一个专门的取值来表达。**

---

## 8. 我没能确认的（不粉饰）

1. **没有找到任何权威规范明文要求「审计 actor 必须非空且指向人类用户表」。** 我查了 NIST SP 800-92（官方页 + OWASP 转述）、OWASP Logging Cheat Sheet、OWASP NHI Top 10、OWASP Top 10 A09:2025。**这是「没找到」，不是「确认不存在」**——PCI-DSS 10.x 的原文我没能取到（`pcisecuritystandards.org` 需授权，未能拉取），它是最可能含明文要求的来源，**留作缺口**。
2. **NIST SP 800-92 原文我只拿到官方页与目录级信息**，没有逐段读到条款原文（PDF 未解析）。上面第 5 节那条是**经 OWASP Cheat Sheet 转述**的（已在行内标注「OWASP 转述」）。
3. **ServiceNow `system` 用户的一手文档没取到**（多次检索只落到文档站首页与二手解读）。它在第 2 节表里**没有出现**，因为我没有一手来源。
4. **Salesforce 的 `Automated Process User` 是否在用户表里真有一行**——官方文档只说它是「built-in system entit（y）」「cannot be deactivated, modified, or deleted」，**没有说它的存储形态**。我在第 2 节把它归为「建了行」是基于「它会出现在 `Last Modified By` 字段与 Setup Audit Trail 里」这一官方描述［来源］，**但「内置实体」是否等价于「用户表里的一行」我无法确认**。这条影响了 §2 表格里 A 行的归类强度。
5. **本仓 `mn_app_user` 的 id 号段纪律**（`8xxx` 是低号段占位）我只确认了**规则表**与**demo seed** 在用，**没有确认是否所有 seed 表都遵循**。定保留常量值前需要把这条确认清楚。

---

## 9. 要人拍的三点

> **2026-10-19 落地回写**（本票 `26f567d` + 冒烟 `c186caf`）：下面三点里 **2 与 3 已拍定并按本文建议落地**，
> 第 1 点拍了**「纯可空」而不是「保留常量 + 可空」**。落地形态与本文 §6 的差异见本节末「实现与建议的出入」——
> 差异是真的，不抹平。

1. **走「可空」还是「保留常量 + 可空」**（§6 末段）。前者语义简单，后者可筛可类型化。
   **→ 已拍：纯可空**（`operator_id = NULL` 即「无人类主体」，**没有**任何保留常量值）。
   身份线索改由 `payload` 承担（`rule_id` / `rule_code` / `rule_name` / `triggered_by`）。
2. **`operator_id` 的 `NOT NULL` 契约要不要放宽**——这是 `0000_mn_baseline.sql` 的**基线契约**，改动面覆盖所有审计读侧（§6.2 列了三处具体位置）。**这是规格修订，不是代码修改。**
   **→ 已放宽**：迁移 `0016_activity_log_operator_nullable.sql`（只 `DROP NOT NULL`，**FK 保留**）。读侧三处已改（`api.ts` 两处改 `string | null`、`matters.ts` / `overview.ts` 子查询改类型），UI 落在 `format.ts` 的 `actorName()`。
3. **审计 UI 怎么显示系统动作**——`matter-detail.tsx:629` 今天直接渲染 `{a.operator}` 字符串。系统动作要显示成什么？（本仓 UI 文案纪律见 `AGENTS.md`「旁白」节与 `component-guidelines.md`「副标题纪律」——**这条要按那份纪律来写，不要临时造词**。）
   **→ 已拍：`"系统自动"`**，收在 `format.ts` 的 `actorName()` 一个函数里（`matter-detail.tsx` 与 `workbench.tsx` 两处调用）。
   ⚠ **刻意不用空串、不用破折号**：那两种在本仓已经另有含义（"数据缺失" / "无值"），复用会让两种不同的东西长得一样。

### 实现与建议的出入（不抹平）

本文 §6 的建议第 1 条写着「**保留一段 id 段位当系统主体**……另定一个**永不对应真实行**的保留值」，
而**实际落地是纯可空、没有保留值**。§6 末段其实已经预判了这个岔口（「两者都行……这条要人拍」），
拍定结果选了可空那一支，理由是：

- 保留常量在**本仓的 FK 约束下走不通**——`operator_id` 的 FK 指向 `mn_app_user(id)`，
  常量值要么不存在（撞 FK），要么就得**为了它插一行**（等于回到被否决的方案 A 哨兵行）。
  §6 第 1 条自己都记着这条代价（「缺点是 FK 仍然拦着——除非同时放宽 FK 或改用 CHECK 约束」），
  而放宽 FK 的改动面**大于**放宽 NOT NULL，且会让「谁发起的」失去外键兜底。
- 保留值的**唯一好处是「可筛可类型化」**，而这件事在可空方案里由 `action = 'ARCHIVED'` +
  `payload.rule_code` 同样答得上来 —— 本仓按动作名筛审计是既有做法（`MATT-60` 把
  `UNARCHIVED` 从 `STATUS_CHANGED` 里拆出来，用的就是同一个思路）。

⇒ 若将来二期要「系统主体可类型化」（例如一个 `actor_type` 枚举列），本文 §2 的**方案 C 仍然是对的远期形态**；
一期选纯可空是**在 FK 约束下的最小改动**，不是对方案 C 的否定。

---

## 附：本仓核实过的具体位置（便于复核）

> ⚠ 行号为 **2026-10-19 落地后**的实测值。本文写于 2026-10-19 早先，§6 / §9 正文里引用的
> 行号是**写文时的**（`matters.ts:300` / `overview.ts:120` / `api.ts:289`、`:514` /
> `matter-detail.tsx:629`），落地改动之后各自下移，**以本表为准**。

| 事实 | 位置 |
|---|---|
| 规格裁定「不建行、用常量 id」 | `docs/PRD-phase1-permission-design-draft.md:97` |
| 规格裁定「规则以 operator = SYSTEM 执行」 | `docs/PRD-phase1-permission-design-draft.md:230` |
| `operator_id NOT NULL` + FK RESTRICT（**基线原状**） | `src/app/lib/server/db/migrations/0000_mn_baseline.sql:343` / `:406` |
| **放开 NOT NULL 的迁移**（落地） | `src/app/lib/server/db/migrations/0016_activity_log_operator_nullable.sql` |
| drizzle 同形定义（**已改可空 + FK 保留**） | `src/app/lib/server/db/schema/collab.ts:103` |
| `AUTO_RULE_*` 三动作已在值域 | `0000_mn_baseline.sql:349`（经 0002/0008/0014 保留） |
| 同源历史证据（operator_id 已挡过一次） | `docs/survey-missing-seams.md:31` |
| 登录校验（无口令即登不进，非显式拦截） | `src/app/lib/server/auth/auth.ts:198` 与 `:90` |
| 用户列表无过滤 | `src/app/lib/server/services/users.ts:95` |
| 审计读侧走子查询（NULL 不破行） | `src/app/lib/server/services/matters.ts:309`、`overview.ts:123` |
| DTO `operator: string \| null`（**已改**） | `src/app/lib/client/api.ts:295`、`:521` |
| 前端渲染（**已改走 `actorName()`**） | `src/app/(desk)/matters/[id]/matter-detail.tsx:630`；`actorName()` 定义在 `src/app/lib/client/format.ts` |
| `logActivity` 拿 `Actor`（系统动作无 Actor） | `src/app/lib/server/services/activity.ts:37-50`；并列的 `logSystemActivity` 在同文件 `:77-91`；`Actor` 定义 `auth.ts:101` |
| 规则 1 的执行体（**落地**） | `src/app/lib/server/services/auto-archive.ts` |
| 规则 1/3 阻塞的原始核对 | `agent-work/probe-rule13-blockers.mjs` |
| 规则 1 的真 HTTP 行为冒烟（**落地**） | `agent-work/smoke-rule1-auto-archive.mjs` |

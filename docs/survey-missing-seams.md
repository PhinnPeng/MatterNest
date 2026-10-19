# 调查：承诺了但没人写的那一类接缝（业务日 / 拒绝留痕）

> **⚠ 后续裁定（2026-10-14）：本报告是调查当时的状态快照，正文一个字未改，但其中两处结论已被处理——**
>
> 1. **§5.2「拒绝留痕」那条路 B 已落地**：`ACCESS_DENIED_WRITE` 于 2026-10-14 **退役**，从 `AUDIT_ACTIONS`、`AUDIT_ACTION_LABELS` 与 `ck_mn_activity_action` 里**物理删除**（迁移 `0014_retire_access_denied_write.sql`）。本文推荐的路 B 与实际处置一致，但**"从 CHECK 里删值"这一步是本文当时标为破例的**——执行时补了先决条件，写进枚举表 §5.3 的新增行（"退役一个从未写入过的取值"，三个条件 + 前提是 `db/seed/` 也要扫）。下面 §5.2 与末尾那张处置表里把它写成"真缺口 / 先退役"的地方，**请当成历史记载读**，不要再当成待办。
> 2. **§一「业务日」那条仍未处理**（2026-10-14 复核：`src/app/lib/server/services/risks.ts:228` 还是 `new Date().toISOString().slice(0, 10)`）。姊妹项 `closing_date` 已由 `2c4806d` 修好，`discoverDate` 这条还没有。
>
> 改这两处时**没有**回头改本文件的正文：它是调查记录，不是活文档，改了就失去"当时是什么样"的证据力。
>
> 只读调查，未改任何代码、未提交、未碰 Paca。
> 环境核对：`git log` HEAD = `c60029e`（`2c4806d` 与 `a781bf8` 均在历史中，两处修复**已落盘可读**：`matters.ts:433` 走 `businessDateKey`，`enum-check.spec.ts:594-913` 是审计写入点门禁）。调查结束时 `git status --short` **只输出 `?? docs/survey-missing-seams.md`**——工作区除此之外干净，本次调查未写入任何源码文件。
> 实跑过的命令：`npx vitest run src/app/lib/server/db/enum-check.spec.ts src/shared/time/zh-cn.spec.ts src/app/lib/server/services/matters.spec.ts` → **3 files / 50 tests 全绿**。未跑 `pnpm build`、未跑 `db:check`、未跑完整 `pnpm verify`。

---

## Question

本仓有两处同形的缺陷：业务日被写成 UTC 日切片（`src/app/lib/server/services/risks.ts:228`，其姐妹案 `closing_date` 刚由 `2c4806d` 修好），以及一个声明了却零写入点的审计动作 `ACCESS_DENIED_WRITE`（`src/shared/enums/audit.ts:78`，被 `a781bf8` 的新门禁逮到）。

假设是同一件事：**系统把一条不变量声明成了承诺，却没有任何机制保证它被遵守**。本调查回答两个问题——

1. 这一类还有多少处？
2. 每一条的**最小接缝**是什么（不是架构，是"一处让这类事不可能、或一改就红的地方"）？

---

## Short answer

**业务日：全仓 7 处 `slice(0,10)` 形态命中，落在 6 个文件里，只有 1 处真的写业务日语义的值**（`risks.ts:228`，另有 `import.ts:249` 通过委派继承同一处默认值）。`businessDateKey` 今天的保护面是**零**——没有 lint 规则、没有 import 限制、甚至 `zh-cn.spec.ts` 里**没有一条断言直接测它**，全部保护来自两处调用点自己的注释。

**拒绝留痕：没有单一漏斗，而且比票面描述的更难**——`http.ts` 的 10 个拒绝构造器**没有一个接受 `tx`，也没有一个接受 `target_type`/`target_id`**；只有 `requirePrivilege(actor, …)` 手里有 actor。更硬的约束在库上：`target_id bigint NOT NULL`（`0000_mn_baseline.sql:340`）、~~`operator_id bigint NOT NULL`（`:343`）~~、`target_type` 只有 7 个取值（`0006_activity_log_user_scope.sql:42-43`）——**建案类拒绝（POST /api/users、POST /api/matters）根本没有可落地的 target_id**。所以票面问的"拒绝时该记谁当 operator"其实不是最难的一半，**最难的是"该记什么当 target"**。

> **订正（2026-10-19）**：上面三项约束里的 `operator_id bigint NOT NULL` **已解除** —— 迁移
> `0016_activity_log_operator_nullable.sql` 放开了 NOT NULL（FK 保留），因为自动化规则 1
> 需要一个「无人类主体」的审计落点。所以这段里「**拒绝时该记谁当 operator**」这一半**现在有解了**：
> 无人类主体的动作可写 `operator_id = NULL`（`logSystemActivity`，与规则 1 同一条路）。
> **但「该记什么当 target」那一半没有任何变化**（`target_id NOT NULL` 与 `target_type` 的 7 值
> 都还在）—— 而它才是本文判定的「最难的一半」。⇒ **本节结论不变**，只是三项约束少了一项。


**同一类还找到 4 处实例**，其中最强的一处是：`withScope()` 在 9 份文档里被写成"缺这一步即视为漏洞"，其中一条还被写进 `.trellis/spec/backend/quality-guidelines.md:35` 的「**CI 必须拦得住**」表——**而 `withScope` 在代码里根本不存在**。它承诺的签名 `withScope(req, { target, action }, handler)` 恰好就是拒绝钩子需要的那两个参数。

---

## 一、业务日 sweep

### 1.1 全部命中（`src/`，7 行 / 6 文件）

用 `rg -e 'slice\(\s*0\s*,\s*10\s*\)' -e 'split\("T"\)' -e "split\('T'\)" src/` 扫，`src` 外（`agent-work/`、`docs/`）另有命中，属探针脚本与文档，不计。`substr(0,10)` / `substring(0,10)` / `toLocaleDateString` / `Intl.DateTimeFormat` / `getFullYear` 均为 **0 命中**（`Intl` 与 `toLocaleString` 仅出现在 `zh-cn.ts:25` 的注释里）。

| # | file:line | 表达式 | 判定 |
|---|---|---|---|
| 1 | `src/app/lib/server/services/risks.ts:228` | `discoverDate: input.discoverDate ?? new Date().toISOString().slice(0, 10)` | **业务日语义（真缺陷）** |
| 2 | `src/app/components/export-file-button.tsx:41` | `const stamp = new Date().toISOString().slice(0, 10)` | 文件名盖章（第三类，见下） |
| 3 | `src/app/(desk)/parties/parties-view.tsx:76` | `const stamp = new Date().toISOString().slice(0, 10)` | 文件名盖章（第三类） |
| 4 | `src/app/lib/client/format.ts:45` | `const [y, m, d] = value.slice(0, 10).split("-")` | **不是**——展示归一化 |
| 5 | `src/app/lib/client/format.ts:52` | `value ? value.slice(0, 10) : ""` | **不是**——表单回填 |
| 6 | `src/app/lib/server/services/matters.ts:419` | `now.slice(0, 10)`（**注释里**） | 不是——`2c4806d` 留下的说明文字 |
| 7 | `src/app/lib/server/services/matters.spec.ts:36` | `SHANGHAI_LATE_NIGHT.slice(0, 10)` | 不是——**故意的反例夹具** |

**第 1 类的判定依据**：`discover_date` 是 `date("discover_date").notNull()`（`src/app/lib/server/db/schema/hosts.ts:133`），导出会原样输出它（`services/exports.ts:324` 的「发现日期」）。`Date.prototype.toISOString()` 定义为 UTC，所以上海 00:00–08:00 之间新建的事项记到前一天。

**第 4/5 类的判定依据**：入参是 `date` 列（无时刻）的字符串，`slice(0,10)` 只是拆出年月日，且 `format.ts:36-42` 的注释明确说明**刻意不过 dayjs**（避免本地时区解释漂一天）。这两处是对的。

**第三类（2、3）**：文件名里的日期戳。人读出来是"这份导出是哪天做的"，所以 00:00–08:00 的导出文件名会写昨天——**方向上与真缺陷一致，只是它不落库、也不喂任何判定**。我把它单列，是因为它决定了接缝能不能"一条正则全拦"（见 §四）。

### 1.2 委托产生的第二写入点（不在上面的 7 行里）

`src/app/lib/server/services/import.ts:249`：
```
discoverDate: s(data.discoverDate) ?? null,
```
它把值传给 `createRiskMatter`（`import.ts:241`）。由于 `null ?? X === X`，批量导入建事项时同样落到 `risks.ts:228` 的默认值。**同一行代码、两条到达路径。**

### 1.3 与上一轮"11 处 / 2 处业务日"的差异

我独立扫到 **7 处 / 1 处业务日语义**（+1 处委托路径）。未能复现"11 / 2"这两个数。可能的口径差异：我用的是"整仓 `src/` + 4 种切片形态"；若把 `.format("YYYY-MM-DD")`、`.format(DATE_COMPACT_PATTERN)`、`.split("T")[0]` 也计入，命中数会上升，其中 `matter-create-dialog.tsx:180`、`convert-dialog.tsx:196`、`risk-create-dialog.tsx:78`、`risk-detail.tsx:867`、`expense-panel.tsx:353` 这 5 处是**用户选定的日期**（DatePicker 的 dayjs 对象 `.format()` 会原样还给用户选的那天，与时区无关），**不该算业务日缺陷**。详见 §六。

---

## 二、`businessDateKey` 今天是怎么被守着的

### 2.1 守：靠三处调用点的自觉，没有别的

- 权威定义：`src/shared/time/zh-cn.ts:74-76`
- 生产调用点 **3 处**：`services/matters.ts:433`、`services/notifications.ts:901`、`services/archive-reminder.ts:116`；另 `shared/notification/archive-reminder.ts:184` 一处
- 两条正确的反面教材注释：`matters.ts:416-426`、`numbering.ts:9-11`

### 2.2 不守：现有门禁面**完全没有触及这条不变量**

逐项核过：

| 门禁 | 覆盖面 | 对业务日 |
|---|---|---|
| `tools/lint-guard/check.mjs` 的 4 个 eslint scope（禁令① / ⑦体系 / ⑦色值 / ⑥⑤） | `check.mjs:31-88` | **零** |
| `check.mjs` 的 2 条源码断言（`eyebrow=`/`meta=` :171-200；富文本白名单 :219-243） | 纯正则走 `src/**/*.ts(x)` | **零** |
| `tools/lint-guard/restricted-imports.mjs:84` | 禁 `date-fns` / `moment` / `luxon` | **只禁库，不禁口径**——同一个 dayjs，写不写 `.tz()` 它看不见 |
| `src/shared/time/zh-cn.spec.ts` | 4 条用例 | **没有一条测 `businessDateKey`** |
| `services/matters.spec.ts:33-50` | 测的是**调用点** `resolveClosingDate`，不是"所有调用点都得用它"的规则 | **零** |
| `tools/db-check.mjs:157-171`（C6） | 实机证明 `now()::date` 与 `AT TIME ZONE` 跨零点差一天 | 只覆盖 `numbering.ts:25` 的 **SQL 侧**；且 `db:check` **不在 `pnpm verify` 里**（`package.json` 的 `verify` = format:check ‖ lint ‖ typecheck ‖ test ‖ lint-guard ‖ anchors:check ‖ deploy:check） |

**结论：这是纯约定，零机械 enforcement。** 而且不是"门禁写错了"，是**门禁面根本没设计到这个点上**——`check.mjs` 的六道断言（A/B/C/D/D2/E）全部以"存在一条 eslint 规则、可挂载到某路径"为前提（`check.mjs:11-21` 自己写明了），业务日这条不属于任何一条禁令。

**关于"门禁会不会空转"的诚实评估**：仓库对此有真实戒心——`enum-check.spec.ts` 里专门有 4 条"解析器/扫描器不是空转"的用例（`:173`、`:200`、`:214`、`:227`），`notification.spec.ts:149-162` 甚至把 `process.env.TZ` 改成 UTC 并**先断言反面**。**但这些是对"已存在的检查"防空转；业务日这条连检查都没有，谈不上空转，也谈不上有效。** 我没有找到任何间接的兜底（没有 import 边界、没有类型、没有测试会因为绕过 `businessDateKey` 而变红）。

### 2.3 顺带发现：同一类里另有一个**未被任何门禁覆盖的口径分叉**（展示侧）

`src/app/lib/client/format.ts:19-21`：
```ts
export function dateTime(value: string | null | undefined): string {
  return value ? dayjs(value).format(DEADLINE_COUNTDOWN_PATTERN) : "—";
}
```
**没有 `.tz(BUSINESS_TIMEZONE)`**——而 `zh-cn.ts:55-56` 写的是「瞬时 → 业务时区墙上时间。**通知文案里的每一个时间都必须过这里**」，`zh-cn.ts:24-27` 点名的正是这个缺陷的后果：「这不是"显示不精确"，是"**开庭提醒写着昨天**"」。

`dateTime()` 被 **15 处**调用，含 `workbench.tsx:175`（节点期限）、`matter-detail.tsx:151-152`（节点起止时间——就是 `zh-cn.ts:27` 点名的开庭时间）、`deadline-mark.tsx:24,32`。`fromNow()` 的 `format.ts:33` 同理。

**必须说清的边界**：这是**客户端**函数，走的是**浏览器时区**而不是容器时区。所以上海用户的上海浏览器上是对的。缺陷只在浏览器时区 ≠ Asia/Shanghai 时暴露（外派/出差、或服务器渲染首屏）。我**没有**证据表明本项目实际用户里存在这种浏览器，也没有跑过实测探针——这是**读码推出的口径分叉**，不是已复现的线上缺陷。但它与 `formatBusinessTime` 的分叉是真实的，且同样零 enforcement。

---

## 三、拒绝 / 审计接缝

### 3.1 拒绝到底在哪里被决定

`src/app/lib/server/http.ts` 导出 10 个拒绝构造器（外加 `fail()` / `json()` 两个原语）。**全部签名如下，没有一个带 `tx`，也没有一个带 target：**

| 构造器 | file:line | 码 | actor 在手？ | target 在手？ | tx 在手？ |
|---|---|---|---|---|---|
| `notFound()` | `http.ts:53-54` | 404 | ❌ 零参 | ❌ 零参（且**刻意不给**——元规则 3） | ❌ |
| `unauthorized()` | `http.ts:56-57` | 401 | ❌ 零参 | ❌ | ❌ |
| `reasonRequired()` | `http.ts:60-61` | 422 | ❌ | ❌ | ❌ |
| `attributionRequired()` | `http.ts:70-71` | 403 | ❌ 零参 | ❌ 零参 | ❌ |
| `importForbidden()` | `http.ts:80-85` | 403 | ❌ 零参 | ❌ | ❌ |
| `pathId(raw)` | `http.ts:97-108` | 400 | ❌ | 部分（原始 id 字符串） | ❌ |
| `body(req, schema)` | `http.ts:116-147` | 400 | ❌ | ❌ | ❌ |
| `query(req, schema)` | `http.ts:150-179` | 400 | ❌ | ❌ | ❌ |
| `withActor(handler)` | `http.ts:185-191` | 401 | ❌（**拿不到就是它返回 401 的理由**） | ❌ | ❌ |
| `requirePrivilege(actor, key, label)` | `http.ts:194-201` | 403 | ✅ **唯一一个有 actor 的** | ❌ | ❌ |

**规模**（`rg` 计数，方法说明见 §六）：`src/app/api` 下 **53 个 `route.ts`**，导出 **40 个写 handler**（27 POST / 7 PATCH / 6 DELETE），**110 处拒绝 return**（`return notFound()/attributionRequired()/…`、`return fail(4xx|5xx)`、`return denied` 三类合并计数）。此外还有**内联** `fail(403, "forbidden", …)` 一族，共 **9 个 `fail(403` 命中**散在 `users/[id]`、`risk-matters/[id]/nodes`、`matters/[id]/staff` 等处，**完全绕过任何命名构造器**。

**没有单一漏斗。** `notFound()` 的 45 处命中横跨 30+ 个路由文件，每个都手写。

### 3.2 每类拒绝现场到底有什么

| 类别 | actor | target_type/target_id | tx |
|---|---|---|---|
| `requirePrivilege` 拒绝（5 处调用：`users/route.ts:15`、`users/pending/route.ts:12`、`users/[id]/route.ts:28`、`users/[id]/roles/route.ts:27`、`users/[id]/approve/route.ts:29`、`parties/route.ts:48`、`matters/[id]/export/route.ts:29`、`risk-matters/[id]/export/route.ts:20`） | ✅ 有 | `users/[id]/*` 有（`target_type='app_user'`）；**`users/route.ts`（建号）与 `pending/route.ts` 没有** | ❌ |
| `attributionRequired`（3 处：`matters/[id]/status/route.ts:54`、`risk-matters/[id]/status/route.ts:53`、`risk-matters/[id]/route.ts:81`） | ✅ 在 `withActor` 回调里有 | ✅ 有（`pid.id`） | ❌（判定发生在服务函数内、事务外） |
| 内联 `fail(403,"forbidden")`（9 处） | ✅ 有 | ✅ 大多有 | ❌ |
| `importForbidden`（4 处：`import/route.ts:31`、`import/batches/route.ts:17`、`import/templates/route.ts:25`、`import/report/[id]/route.ts:22`） | ✅ 有 | ❌ | ❌ |
| `notFound`（45 处） | 部分有 | ❌ **且按设计不能有**——元规则 3 就是"装作不存在" | ❌ |

**票面那句"actor may not exist yet"——只对 401 成立。** 按 §3.3 的口径（`src/shared/enums/audit.ts:10-11`、`docs/PRD-phase1-enums-and-schemas.md:122`、`logging-guidelines.md:29`），**读拒绝不记**，所以 401 与 404 天然不在 `ACCESS_DENIED_WRITE` 范围内。所有**值得记的写拒绝**现场都有 actor。**actor 不是最难的一半。**

### 3.3 真正卡住的是库，不是 hook

`mn_activity_log` 的 DDL（`src/app/lib/server/db/migrations/`）：

| 列/约束 | 位置 | 约束 |
|---|---|---|
| `target_id` | `0000_mn_baseline.sql:340` | **`bigint NOT NULL`** |
| `operator_id` | `0000_mn_baseline.sql:343` | **`bigint NOT NULL`** + FK 到 `mn_app_user`（`:406`） |
| `target_type` | `0000:350` → `0006:42-43` | CHECK **7 值**：`matter / risk_matter / matter_node / risk_matter_node / matter_progress / matter_expense / app_user` |
| `ck_mn_activity_host` | `0000:351` → `0006:53-56` | `matter_id IS NOT NULL OR risk_matter_id IS NOT NULL OR target_type='app_user'` |

**推论**：一个"用户试图建号但没有 `canManageUser`"的拒绝，`POST /api/users` 上**没有任何 id**，`target_type` 也没有"账号创建请求"这个取值，`target_id NOT NULL` 与 7 值 CHECK 双重拒绝。**这不是 hook 好不好写的问题，是 schema 现在根本没有这个落点。**

还有一条被忽略的冲突：`.trellis/spec/backend/error-handling.md:64` 写「业务写 + `activity_log` **同一事务**；审计写失败＝整笔回滚」。拒绝**没有业务写**，因此只能单开事务；而单开事务后若日志写失败，按这条口径会**把 403 变成 500**——拒绝反而"成功"了。所以拒绝留痕必须先改一条 spec，不是纯代码活。

### 3.4 判定

**加一个 `logActivity(ACCESS_DENIED_WRITE)` 是设计工作，不是补一行 `action:`**——`enum-check.spec.ts:879-880` 的判断是对的，而且比它自己写的还保守：真正的障碍不在 http 层，在 migration 0014 之前不存在。

---

## 四、同一类（"声明了但没人写"）的其他实例

### 4.1 `withScope()` / `ScopedQuery`——最强的一处 ✅ 已核

**声明面**（全部已核，零代码命中）：

- `.trellis/spec/backend/error-handling.md:23`：伪码第 2 步 `withScope(req, { target, action }, handler)`，并写「**缺这一步即视为漏洞，不是"少个校验"**」
- `.trellis/spec/backend/error-handling.md:24`：「handler 内所有查询必须携带 scope（ScopedQuery），拿不到 scope 的仓储方法直接抛」
- `.trellis/spec/backend/quality-guidelines.md:29`：「裸表访问 → 失败（**lint**）」
- `.trellis/spec/backend/quality-guidelines.md:35`：「鉴权漏挂：`/api/**` handler 无 `withScope()` → **失败**」——**这一行在标题为「**CI 必须拦得住**的东西（人工审不算拦）」的表里**
- `.trellis/spec/backend/index.md:41`：未勾选清单「每个 handler 内部有 `withScope()`」
- `.trellis/spec/backend/directory-structure.md:21 / :62 / :96`、`src/app/README.md:5`、`src/app/lib/server/README.md:3,10`
- `docs/tech-stack-decision.md:255, 276, 511, 529`、`docs/implementation-plan-v1.md:26, 51, 201`、`docs/PRD-phase1-permission-design-draft.md:123`

**实现面**：`rg 'withScope|ScopedQuery'` 在 `src/` 与 `tools/` 下**零命中**（只有 docs/CHANGELOG/journal 命中）。

**实际落点是 `withActor()`**（`http.ts:185-191`）+ 服务层的 `scopedWhere()`（`scope/visibility.ts`，20 处调用点）。两者是真的，但**签名里没有 `target` 与 `action`**——恰好就是拒绝钩子需要的那两个参数。

**同类特征完全吻合**：一个被声明成架构骨架的东西，既没有代码，也没有实现它的门禁；`quality-guidelines.md:29/35` 那两行「CI 必须拦得住」是**承诺了一个不存在的检查**——比"声明了效果但没实现"更进一步，它是"声明了守卫但没实现守卫"。`README.md:10` 倒是诚实的（「待 W2-1 落地」），`lint-guard/README.md:40-44` 也诚实（「待挂进来的第五条（W2-1）… 故意不实现」）。**不一致的是 spec 那两张表。**

### 4.2 `NON_AUDIT_TRIGGERING_COLUMNS` 描述的触发器子系统不存在 ✅ 已核

`src/shared/enums/audit.ts:198-207` 用注释定义了"`*_UPDATED` 只在业务字段变化时写"，并列出 4 个**不触发日志的派生列**。

- 全仓 `rg 'TRIGGER'` 在**所有迁移 SQL** 里只有 `automation_rule.trigger_type` / `trigger_target_type` 这两个**列名**，**没有一条 `CREATE TRIGGER`、没有一条 `CREATE FUNCTION`**。
- 该常量在 `src/` 里**零次 import**；唯一另一处提及是 `services/matters.ts:1179` 的**注释**。
- `logging-guidelines.md:70` 把它列为「常见错误」第 1 条的前提（"用 ORM 插件/拦截器自动写审计，结果派生列也记日志"）——**而这正是当前唯一在用的写法**（服务层手写 `logActivity`）。

**净结论**：这条纪律目前是靠"每个调用点自己记得别在这些列变化时调 `logActivity`"来守的，**和业务日那条一模一样的形状**。

### 4.3 六个审计不变量常量，零消费者 ✅ 已核

| 常量 | 定义 | `src/`+`tools/`+`.trellis` 里的命中数 |
|---|---|---|
| `REASON_REQUIRED_ACTIONS` | `audit.ts:172-177` | **1**（只有定义行本身） |
| `REASON_CONDITIONAL_ACTIONS` | `audit.ts:179` | **1** |
| `REASON_OPTIONAL_ACTIONS` | `audit.ts:181-185` | **1** |
| `PAYLOAD_ACTIONS` | `audit.ts:188-192` | **1** |
| `FIELD_DIFF_ACTIONS` | `audit.ts:194` | **1** |
| `NON_AUDIT_TRIGGERING_COLUMNS` | `audit.ts:202-207` | **2**（定义 + `matters.ts:1179` 注释） |

**四条 reason 必填位（`ARCHIVED/UNARCHIVED/UNCONVERT/NODE_CANCELLED`）在服务层是三份手写重复**：`matters.ts:505`、`matters.ts:680`、`risks.ts:651`，各自 `if (!reason?.trim()) return { why: "reason_required" }`。今天三处都对；**第四处不会知道自己该查表**。`logging-guidelines.md:26` 写的是「必填由服务层校验，不靠调用方自觉」——**服务层确实校验了，但校验的判据没有来自那份表**。

**诚实降级**：这六条里没有一条已经造成缺陷（与 `ACCESS_DENIED_WRITE` 不同）。它们属于"声明了、当前也守住了、但守住的是巧合不是机制"。我把它们列出来，是因为它们**精确地演示了本次调查的命题**：`AUDIT_ACTIONS` 有门禁（`enum-check.spec.ts`），而这些**紧挨着它的**声明一个都没有。

### 4.4 已经有解药的那一实例（作为对照）

`AUDIT_ACTIONS` 的 46 个值 ↔ 写入点，`enum-check.spec.ts:594-913`（`a781bf8`）已经做了：扫生产 `.ts`/`.tsx`（`SCAN_ROOTS = ["src","worker"]`，`:630`）、剥注释（`:673-677`）、只认 `logActivity(` 与 `.insert(activityLog).values(`（`:806`）、只认对象字面量的 depth-0 `action:` 字段（`:757-790`），然后 `:841` 算出 `deadActions`、`:858-891` 是一份逐条写明理由的白名单。

**这个先例说明两件事**：(a) 这类检查在本仓是**做得出来**的，工具箱现成；(b) 它采用的是**"钉住这笔账 + 新增即红"**，而不是"消灭它们"——白名单里 17 条有 16 条是"等票"，`ACCESS_DENIED_WRITE` 是唯一一条被明写为「**没有承载点，也没票**」的真缺口（`:879-880`）。

### 4.5 没找到的

**除了 `risks.ts:228`（+ `import.ts:249` 委托），我没有找到第二个"业务日语义值取错时区"的写入点。** 具体核过的邻近面：

- 全部 `new Date().toISOString()` 命中（80 处扫描）逐条分类：落点全是 `timestamptz` 列（`updated_at` / `created_at` / `completed_at` / `converted_at` / `last_progress_at` / `sent_at` / `published_at` / `deleted_at` / `last_login_at`），UTC ISO 串对它们是**正确**的。
- 全部 `date(...)` 列（`schema/hosts.ts:84,85,133,352,384` + `schema/collab.ts:131`）的写入点：只有 `discover_date` 有"今天"默认值；`filing_date`/`occurred_date`/`progress_date` 都只从入参取值，无默认值。
- SQL 侧"今天"：`rg -i 'current_date|now\(\)::date|LOCALTIME|AT TIME ZONE'` 在 `src/` 只有 4 处，**3 处是注释在解释为什么不能用**，第 4 处是 `services/numbering.ts:25` 的 `date_trunc('day', now() at time zone 'Asia/Shanghai')::date`——**正确**。
- `.format("YYYY-MM-DD")` 的 5 处（§1.3）是用户选定的日期，不是"今天"。

**业务日这一类：1 处真缺陷（2 条到达路径），0 处新发现。**

---

## 五、提议的接缝

### 5.1 业务日：扩 `check.mjs` 的源码断言，不要碰 eslint

**推荐 (c)：在 `tools/lint-guard/check.mjs` 里加第三条源码断言。**

理由（全部已核，不是推测）：

1. `check.mjs` **已经有这个机制的成品**：`assertNoSubtitleSlots()`（`:176-200`）与 `assertRichTextWhitelist()`（`:222-243`）都是"递归 walk `src/**/*.ts(x)` → 读文件 → 正则 → 命中即 failure"。加一条是 ~20 行，**复用现成的 walk 与 failure 收集**，不引入新文件、不引入新 fixture、不引入新 config 段。
2. **eslint 那条路在这个形状上是错的**：`check.mjs:11-21` 自己写明六道断言的前提是"存在一条 eslint 规则、可挂载到某路径"。而 eslint 的 `no-restricted-syntax` 表达不了"你**必须** import 某个东西"（只能表达"你不得 import 什么"或"某个节点形态不得出现"）。选项 (b) 在机制上就落不了地。
3. **注释不会误伤，这一点是实测出来的**：`matters.ts:419` 的注释里写的是 `` `now.slice(0, 10)` ``——**没有 `toISOString()`**；`matters.spec.ts:36` 是 `SHANGHAI_LATE_NIGHT.slice(0, 10)`，同样没有，且 `.spec.ts` 天然可排除。所以用**窄形态** `/toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/` 扫，今天的命中**恰好 3 条**：`risks.ts:228`、`export-file-button.tsx:41`、`parties-view.tsx:76`。零误伤。`check.mjs` 里那两条现有源码断言刻意避开裸词匹配的理由（`:158-162`、`:212-214`）在这里**不适用**——窄到含 `toISOString()` 就已经天然排除了"注释里为了解释而写出这个表达式"的情形。

**代价 / 抓不到什么（必须写清）：**

- 抓不到换一种拼法的同一个缺陷：`substring(0,10)`、`substr(0,10)`、`split("T")[0]`、`new Date().toISOString().split("T")[0]`。
- 抓不到**换一种库**的同一个缺陷：`dayjs(x).format("YYYY-MM-DD")` 少了 `.tz()`（本仓 `format.ts:19-21` 就是这个形状，见 §2.3）、`formatBusinessTime` 被绕过、手写 `+8`。
- 抓不到**语义**：一条正则分不出 `risks.ts:228`（落库、真错）和 `parties-view.tsx:76`（文件名、轻微错）。它只能"全拦"或"全放"。**全拦就得顺手把那两处文件名戳也改掉**（我建议改——它们本来就是同一条纪律，代价是一次 `businessDateKey(new Date())` 的客户端导入）；**全放就得写死 allowlist**，而 allowlist 一旦写出来就会变成下一轮没人更新的第二事实源。
- 抓不到**间接**落库：`import.ts:249` 那种"把 `null` 传给一个会兜底的函数"的路径，正则看不见。

**配套的第二小步（同样便宜，且我建议一起做）：** `zh-cn.spec.ts` 目前**没有一条断言测 `businessDateKey`**。加一条照抄 `notification.spec.ts:149-162` 的形状——把 `process.env.TZ` 临时改成 UTC，**先断言反面**（`dayjs(iso).format("YYYY-MM-DD")` 确实给错的那天），再断言 `businessDateKey(iso)` 给对。这条把"helper 本身"从"调用点的测试"里独立出来，是 §2.2 那张表里唯一一个能真正堵住的洞。

**不要做的：** 把 `zh-cn.ts` 改成不导出 `BUSINESS_TIMEZONE` / 或给 `slice` 起一个 `@ts-expect-error` 标记。这只会把"没人在意"换成"有人在意的三层"。

### 5.2 拒绝留痕：先决定它该不该存在，再决定 hook 长什么样

**这里不是工程选择题，是产品选择题。** 两条路，诚实列各自代价：

#### 路 A：把它做出来（"写拒绝必须留痕"是真的需求）

最小形状不是新 hook，而是**把 spec 里已经写过的那句话变成代码**：

1. **迁移**：让 `target_id` 可空（或加一个 `'access_attempt'` 取值 + 一个合成 id），否则建案类拒绝无处落地——`0000_mn_baseline.sql:340` + `0006:42-43`。**这一条不做，后面全白做。**
2. **改一条 spec**：`error-handling.md:64` 的"审计同事务、审计失败＝整笔回滚"必须为拒绝开口子，否则 403 会因日志写失败变成 500。
3. **把 `withActor` 升级成 `withScope`**：`http.ts:185-191` 的签名加上 `{ targetType, targetId, action }`，由它拥有拒绝留痕。**这条路顺带把 §4.1 的 9 份文档兑现掉**——`error-handling.md:23` 写的就是 `withScope(req, { target, action }, handler)`，参数一模一样。
4. **9 处内联 `fail(403, "forbidden", …)` 必须收编**，否则漏的就是它们。

代价：**至少一次迁移 + 一份 spec 修订 + 53 个路由文件里那 40 个写 handler 的参数补齐**，外加"拒绝日志独立事务"这个新语义的全部后果（写失败怎么办、要不要重试、日志表会不会被拒绝灌爆——§3.3 已指出枚举表 `:122` 自己担心的正是反向灌满）。

#### 路 B：把它退役（按 §5.3 废弃流程删掉）

`src/shared/enums/audit.ts:13-16` 已经为 `SENSITIVE_FIELD_READ` 做过一次**完整的先例**：IQ-12 裁定取消后，它**留在清单与 DB CHECK 里**（历史行仍可反查），但一期不写、前端不展示，文件头写明原因并说「别在别处再写它」。

`ACCESS_DENIED_WRITE` 可以照抄这个处置：**从 `AUDIT_ACTIONS` 与迁移 CHECK 里删掉、在 `AUDIT_WITHOUT_WRITESITE`（`enum-check.spec.ts:858-891`）里换一条写明理由的条目**。代价：库要改（CHECK 值域）、`PRD-phase1-enums-and-schemas.md:122` 与 `logging-guidelines.md:29` 两处 spec 要改、引用计数要更新。收益：**这一类立刻从"17 条里的 1 条真缺口"变成 0**，且不需要任何新机制。

#### 我的推荐

**路 B**，除非"写拒绝留痕"是合规硬要求（若是，那它是路 A，且我不该替这个决定选边）。理由：路 A 真正的前置是**一次 schema 迁移 + 一条 spec 修订**，那已经是独立一票的体量；而在"拒绝到底要不要留痕"这个问题被回答之前，**先写 hook 是把一个未定的问题编码进库**。这与 `enum-check.spec.ts` 对这 17 条的处理完全一致——**先把账钉住，不要用代码假装问题不存在**。

**无论走哪条，都有一件小事是现在就该做的、且与选择无关**：`logActivity` 的第三个参数是必填 `targetType: string; targetId: bigint`（`services/activity.ts:17-26`），类型上就**排除了 targetless 的日志**。也就是说"拒绝时记谁"这个问题，**在类型层面已经被回答成"必须有 target"**，只是没人说过这是刻意的。把它写进 `activity.ts` 的文件头，胜过让下一个人重新推一遍。

---

## 六、我没能核实的

诚实列出，按重要性：

1. **没有复现"11 处 / 2 处业务日"这个上一轮的数**。我独立扫到 7 处 / 1 处 + 1 条委托路径。若上一轮把 `.format("YYYY-MM-DD")` 之类算进去，数字能凑到 11；但我判定那 5 处 DatePicker 的 `.format()` **不是**这一类（用户选定的日期，与时区无关）。**如果那个"2 处业务日"指的是另一条我没归为业务日的**，我的分类需要复核——我只对 §1.1 表格里的 7 行逐行给了 file:line 与理由，这 7 行是可核的。
2. **110 处拒绝 return / 40 个写 handler / 53 个路由文件**是 `rg | Measure-Object` 的计数，**正则口径**（`return (notFound|…)\(\)|return fail\(\s*[45]|return denied`）。它会漏掉写成 `return someVar;`（`requirePrivilege` 那几处 `const denied = …; if (denied) return denied;`）或包在 `return` 里的间接返回。**数字是量级，不是精确枚举。**
3. **没有跑 `pnpm db:check`**，所以 C4（会话钉 UTC）/ C6（日界口径）我是**读 `tools/db-check.mjs:142-171` 的代码与 `numbering.ts:9-11` 的注释**得出的，不是实机证据。DDL 约束（`0000:340/343/350`、`0006:42-43/53-56`）我是**读迁移 SQL**得出的，也没有对着库核实迁移是否真的都跑过。
4. **没有实证 `risks.ts:228` 在生产里真的落过错值**。逻辑推导是完整的（`toISOString()` 按 UTC 定义 + `discover_date` 是 `notNull()` 的 `date` 列 + `hosts.ts:133` + `exports.ts:324` 读它），但我没有跑过一个"上海 07:00 建事项然后读回 `discover_date`"的探针。`matters.spec.ts:34-38` 证明了 UTC/上海在某个瞬时分属两天，**不等于**证明了 `risks.ts` 在那个窗口被走过。
5. **没有跑完整的 `pnpm verify`**（只跑了 3 个 spec 文件 / 50 tests，全绿）。**没有跑 `pnpm build`**（按约束）。所以"现有门禁全绿"这句话只覆盖那 3 个文件。
6. **`ACCESS_DENIED_WRITE` 零写入点**这一条，我核了两遍：读 `enum-check.spec.ts:879-880` 的自述，**并**独立扫了 `src/` 全部 `logActivity(` 与 `.insert(activityLog).values(` 的实参（见 §3.1 的 94 处命中表）里没有出现该字面量。但**我没有运行门禁自己的扫描器**把 `deadActions` 打出来对照，所以两份证据是"同向"而不是"交叉验证"。
7. **`withScope` / `ScopedQuery` 零代码命中**这条我是用 `rg` 全仓（含 `docs/`、`CHANGELOG.md`、`.trellis/`）确认"只在文档里"的。**我没有查 `.trellis/tasks/` 下是否有在途任务正准备落它**——也没有查 Paca（按约束）。若有在途票，§4.1 的措辞要改。
8. **`format.ts:19-21` 缺 `.tz()` 的实际影响面未知**（§2.3）。这是浏览器时区问题，我**没有任何证据**表明本项目真实用户里存在非 Asia/Shanghai 时区的浏览器，也**没有跑过实测**。它目前是"口径分叉"，不是"已复现缺陷"。
9. **PowerShell 输出对部分 SQL 文件显示乱码**（`0012_automation_rule.sql`、`0006_activity_log_user_scope.sql` 的中文注释）。我只用了这些文件里的 ASCII 部分（DDL 关键词、约束名、值列表），**没有引用过它们的注释内容**；`numbering.ts` 的中文注释我是直接用 `read` 工具读的原文。
10. **`worker/` 目录今天只有一份 README、0 个 `.ts`**（已核）。`enum-check.spec.ts:626-628` 把它列为扫描根是给将来用的。**我据此判断"worker 侧没有第二个业务日写入点"是当下为真的事实，不是永久保证**——将来提醒调度落地时，这条不变量会在一个不在 `src/` 的根上第一次被考验。

---

## 附：一页速查

| 类 | 现状 | 最小接缝 | 我的选择 |
|---|---|---|---|
| 业务日 | 1 处真缺陷（`risks.ts:228`）+ 1 条委托路径（`import.ts:249`）；`businessDateKey` 零 enforcement；helper 本身无单测 | `check.mjs` 加第三条源码断言（窄形态 `toISOString().slice(0,10)`，今日恰好 3 命中、零误伤）+ `zh-cn.spec.ts` 补一条 TZ=UTC 的 helper 单测 | **做**。约 20 行 + 1 条用例，两天 |
| 拒绝留痕 | 110 处拒绝 return、10 个构造器、**没有一个带 tx 或 target**；库上 `target_id NOT NULL` + 7 值 CHECK 把建案类拒绝堵死；`error-handling.md:64` 的同事务口径会把它变成 500 | 要么把 `withActor` 升级成 spec 里已经写过的 `withScope(req,{target,action},handler)`（需一次迁移 + 一条 spec 修订），要么按 `SENSITIVE_FIELD_READ` 的先例从枚举与 CHECK 里退役它 | **先退役**（路 B）。hook 是"未定问题的编码"，而 `enum-check.spec.ts` 已经有"先把账钉住"的成熟做法 |
| 同类实例 | `withScope`/`ScopedQuery`（9 份文档、含一条假的 CI 行，零代码）；`NON_AUDIT_TRIGGERING_COLUMNS`（全库零 trigger）；6 个审计不变量常量零消费者 | 不在本次两票范围内，但 `withScope` 那条**与拒绝留痕是同一件事**——路 A 顺手兑现它 | 记账，不单独动 |
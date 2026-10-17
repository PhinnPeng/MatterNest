# Issue Tracker

Two linked surfaces, one authoritative order. **Paca is the todo source of
truth; Trellis is the record surface.** This order comes from
`docs/implementation-plan-v1.md` §2 (跟踪归位, 2026-09-27) — the ruling is
verbatim: *"待办一律登记在 Paca … markdown 里的编号不算登记"*. Any skill that
creates work items must register on Paca first. A Trellis task directory alone
is **not** a registered todo.

| Concern | Surface |
|---|---|
| Todo registration, board, claim, status, blocking edges | **Paca** (project `MatterNest`, prefix `MATT`) |
| Task record: PRD, design notes, durable context | Trellis `.trellis/tasks/<yyyy-mm>/<id>/` |
| Lifecycle mirror of the record | Trellis `task.json.status` via `task.py` |
| Triage labels | Paca `tags` (see `triage-labels.md`) |

## Connection facts (verified 2026-10-12)

- **Paca MCP server `paca-matternest` is live**, but注意**同一个服务器有三份互不相通的配置面**，
  各自喂不同的工具，别再混为一谈（这是本节 2026-10-10 版写错的地方）：

  | 配置落点 | 谁读它 | 状态 |
  |---|---|---|
  | `.dsh/@wingsky-1/dsh-mcp-manager/mcp.json` | **DSH**（本 harness 的 `ws_mcp_*`） | ✅ 2026-10-12 新建并实测连通 |
  | 项目 `.qoder/settings.json` | Qoder IDE | 存在，DSH 不读 |
  | 根 `.mcp.json` / 项目 `opencode.json` | 其它 harness（Claude 系 / opencode CLI） | 存在，DSH 不读服务器定义 |

  DSH 的 `dsh-mcp-manager` 只吃**它自己**的项目级落点 `<root>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json`
  （全局那份在 `~/.dsh/@wingsky-1/…`）；根 `.mcp.json` 在它代码里**只当项目根探测标记**，
  服务器条目一律不从那里加载。实测反证：`.qoder/settings.json` 与 `.mcp.json` 都在的时候
  `ws_mcp_list` 报 0 servers，补上 `.dsh/@wingsky-1/…/mcp.json` 才被发现并连上。

  调用形如 `ws_mcp_call(server="@F:\WorkSpace\MatterNest/paca-matternest", tool="list_tasks",
  arguments={projectId: "8c42f9be-…"})` —— **`projectId` 必须显式传**，env 里那个只配置服务器进程；
  参数面以 `ws_mcp_detail` 为准。名字约束 `^[A-Za-z0-9_-]{1,32}$`，transport 只认 `stdio` / `streamable-http`。

  ⚠ **这个新落点含真实 API key，已用 `.gitignore` 的 `.dsh/@wingsky-1/` 挡掉**（`.dsh/` 其余内容
  如 `DSH.md`、`skills/` 是入库的，所以只忽略这一层）。改动本目录前先看这条。
- 旧的「Paca 不能走 MCP」说法来自**三个错钉的 single-project 连接器**（全局那份的
  agileidentity / uniondesk / youmeng），与 MatterNest 无关。

  **2026-10-12：所有 REST 协助脚本已删除**（`agent-work/paca*.mjs` 共 16 个）。一律走 MCP。
  删它们的直接原因是一次事故：`paca.mjs` 按标题幂等 upsert，**跑一次就覆盖了 32 张卡的描述**
  （含本图正文），而它存在的前提（MCP 不可用）早已不成立。**REST 兜底路径不再存在，
  也不应重建**——踩着它的每一步都可能静默改写板上内容。

  ⚠ 配置指向的是 **npx 缓存路径**（`_npx/<hash>/node_modules/@paca-ai/paca-mcp/...`），
  版本为 `0.14.0-rc.1`（npm 最新 `0.19.0`）。缓存清理或哈希变化会让它失效，且没有版本锚定。
  修法是把依赖**落到 `devDependencies`**（`@paca-ai/paca-mcp@<pin>`），配置指向
  `node_modules/.bin/paca`。此事已登记，见 MATT-58。
- Project id `8c42f9be-d3f6-4635-951d-0a2cf911a8f7`; 33 tasks, all type `Task`;
  statuses: `Backlog` (default) / `Todo` / `In Progress` / `Done`.
- Native relationships that exist and are usable:
  - **parent/child**: `create_task` / `update_task` accept `parentTaskId`
    (Task-under-Task works);
  - **blocking**: task links with `linkType: "blocks"` (endpoint
    `/tasks/{id}/links`);
  - **labels**: the task `tags` string array.
- `MATT-1`「一期落地地图：从可跑 Demo 到 M0–M7 收口」is the map card
  (id `dd3fbb57-…`). The 8 milestone cards (MATT-2/7/9/12/18/22/26/29 = M0…M7)
  **are physical children of it**. Caveat (verified 2026-10-10): the REST
  `list tasks` response does **not** include `parentTaskId` — parent/child is
  only visible via MCP `get_task` (its Subtasks section) or per-task fetch.
  Never conclude "no children" from a REST list.

## The link (Trellis ⇄ Paca)

Trellis id `demo-slice` ⇄ Paca task number. Store the Paca number back into
Trellis:

```
python ./.trellis/scripts/task.py set-meta <dir> paca_task <number>
```

and embed `trellis:<id>` in the Paca task description. That pair is the join.

## Creating a ticket

1. **Register on Paca**（`paca-matternest` 的 MCP 工具）：
   `create_task` with title/description; set `parentTaskId` when it belongs to
   a milestone or map card; apply triage tags at creation.
2. **Then** create the Trellis record if the work needs durable notes/PRD:
   `task.py create …`, `set-meta paca_task`. Do not hand-write task dirs.
3. Report both identifiers (Paca `MATT-<n>` and Trellis dir).

## If Paca is unreachable

Say so and stop. Do **not** create a local markdown issue file as a fallback,
and do not invent a Paca id.

**"Unreachable" 现在的含义只有一种：MCP 工具取不到。** 自 2026-10-12 起没有 REST 兜底路径
（协助脚本已全删，理由见上）。**也不要为了"先恢复通路"重新拼一个** —— 这正是上一次
事故的来源：一个按标题 upsert 的脚本静默覆盖了 32 张卡的描述。

## Reading current state

```
list_tasks  (projectId 8c42f9be-d3f6-4635-951d-0a2cf911a8f7)
python ./.trellis/scripts/task.py list [--status in_progress]
```

**分页是实测过的坑（2026-10-12）**：`list_tasks` 一页只回 20 条，而 `offset` 参数
**被服务端忽略**（传了也返回同一批）。所以「翻页」拿不到全量，**不能据此断言某张票不存在**
（本会话就因此误判过 MATT-38/39 不存在，实际它们在）。

缺的取法有两条，都验证过：

- 按 `statusId` 过滤，把目标区间捞进第一页（找 #5x 时用的就是这条）；
- 已知 uuid 时直接 `get_task`（**不接受** `MATT-55` / `55` 这类编号，只吃 uuid）。

### `status_id` ⇄ 状态名（project `8c42f9be-…`，2026-10-17 实测）

| `status_id` | name | category | position |
|---|---|---|---|
| `cabde200-a779-4653-bbd0-62efad6f4e7d` | Backlog | `backlog` | 1 |
| `c1976711-d256-4881-ae65-4eeeb55314da` | Todo | `todo` | 2 |
| `0fe789f5-c15d-4681-a50f-9e5b4d33487a` | In Progress | `inprogress` | 3 |
| `3c67e704-3ddb-4016-9b37-e20998ed87b0` | Done | `done` | 4 |

**`list_tasks` 不返回状态名。** 返回的条目只带 `status_id`（以及 `task_type_id`、`tags` 等），
没有 name 字段 ⇒ 名字只能**从本表查**或**从状态列表工具查**，没有第三条路。

刷新本表只有一条 sanctioned 路径：Paca MCP 工具 **`list_task_statuses`**。
REST 协助脚本已全部删除且**不应重建**（见上），所以**不要**去 curl API —— 指 `list_task_statuses`。

它除 `position` 外还返回 **`category`**（`backlog` / `todo` / `inprogress` / `done`），
所以统计可以**按 category 分组**而不硬编码 uuid。

⚠ **凭 uuid 顺序或 `position` 猜映射 = 静默把整份报告反过来。** 本会话真实发生：
据此报成「Done 5 / Backlog 72」，真值是「Done 70 / Backlog 15」，**完全颠倒**，
而**全程没有任何一处报错** —— 一个自信的错结论，看起来和正确的一模一样。
所以要映射就**每次都从 `list_task_statuses` 取**、或读本表，**绝不从 uuid 排序或 position 推**。

## 寻址：把 `MATT-n` 换成 uuid

**`list_tasks` 不返回编号。** uuid 与编号的对应只能靠 `Task #N:` 行头按位次对齐 ⇒ **位置错配是结构性的，不是偶发**。

**取 uuid：** 在同一次 `execute` 里用 `get_task_by_number` 取并用正则提，**不要跨消息手抄**：

```js
const idOf = async (n) => {
  const t = await tools["paca-matternest"].get_task_by_number({ projectId, taskNumber: n });
  return (typeof t === "string" ? t : JSON.stringify(t)).match(/\*\*ID:\*\*\s*(\S+)/)[1];
};
```

**核对回显：** 每次写操作的响应都带 `Task updated successfully: Task #N: …`。**读那个 N，对不上就当场回退**（`delete_task_comment` + 状态复原 + 留更正评论），不要留到下一轮。这个回显是免费的确定性检查。

**真实翻车记录（2026-10-13，一次会话两次）**：

- MATT-58 的 uuid 被误配到 MATT-36 ⇒ **误关了一张需人裁定的票**，还贴了一条关于 @提及的核对评论。回读响应时 `Task #36` 就在眼前，没看。
- MATT-35 的 uuid 少打一个字符 ⇒ `add_task_comment` 报 `invalid task id`。这个反而是好事：uuid 写错会被服务端挡下，**编号写错不会**。

## ⚠ 改状态用 `update_task({ statusId })`，**不要**用 `update_task_status`

2026-10-15 实测（一次关 9 张票，全部没关成）：

| 工具 | 回显 | 实际 |
| --- | --- | --- |
| `update_task_status({ projectId, taskId, statusId })` | `Task status updated successfully` + 完整状态块 | **状态没变** |
| `update_task({ projectId, taskId, statusId })` | `Task updated successfully: Task #N: …` | 真的改了 |

两边的回显都是「成功」，但只有后者落库。发现方式是**复取全量快照**（`list_tasks` 分状态翻页）时发现 `Backlog 29 / Todo 15 / Done 41` 与写入前逐字相同 —— 当时 `add_task_comment` 已经落了，只有状态没动。

⇒ 这条比上面「核对回显里的 `Task #N`」更强：**回显里的 `Task #N` 只证明它找到了哪张票，不证明它改了任何东西**。凡是「批量写操作 + 回显成功」的组合，写完都要**重新读一次**：

```js
// 写完立刻回读，不信回显
const t2 = await tools["paca-matternest"].get_task_by_number({ projectId, taskNumber: n });
(/^\*\*Status:\*\*\s*(.+)$/m.exec(String(t2))?.[1] ?? "?").trim();   // 断言它真的是 Done
```

`delete_task_comment` 需要 `taskId` **和** `commentId` 两个参数，只给 `commentId` 会被服务端挡下。

## 在 `execute` 里拼长 Markdown

代码是 JS，正文里几乎必有反引号。**用占位符，末尾统一还原**，这是唯一试过就一路没再出错的写法：

```js
const G = "§";                       // 正文里写 § 代替 `
const body = [...].join("\n").split(G).join("\u0060");
```

另外四个坑（每个都真实浪费过一轮）：模板字符串里嵌反引号；双引号字符串里塞真实换行；用 `const` 声明后才在上面的数组里引用它（TDZ）；双引号被提前闭合导致后面的标点跑到字符串外。

**为什么这两条是规程而不是脚本：** REST 兜底路径已被明令废除（一个按标题 upsert 的脚本一次覆盖 32 张卡的描述）。Paca 只经 MCP，所以寻址纪律只能落在文档里，落不成可执行检查。

## Wayfinding operations

How `/wayfinder` maps onto this tracker (all verified against the live API):

- **Map** = `MATT-1`, tagged `wayfinder:map` (add the tag to it when a map
  effort starts; the card already exists — **reuse, never create a second map**).
  The map body (Destination / Notes / Decisions so far / Not yet specified /
  Out of scope) lives in MATT-1's `description`, updated via `update_task`.
- **Ticket** = child issue: `create_task` with `parentTaskId = MATT-1's id`,
  titled `W: <question>`, tagged `wayfinder:research` | `wayfinder:prototype`
  | `wayfinder:grilling` | `wayfinder:task` (tags are the only labels Paca
  has; no native label field).
- **Claim** = `update_task assigneeId=<your project-member id>` (Member ID
  from `list_project_members`, **not** the user id), **before any work**.
- **Blocking** = native links: `create_task_link(taskId=<blocker>, targetTaskId=<blocked>, linkType="blocks")`.
  The blocker is the source; read frontier via `list_task_links` per candidate.
- **Frontier query** (no single endpoint): open children of MATT-1
  (`list_tasks parentTaskId=…`) → drop any with an assignee → drop any whose
  `blocks` links include an *open* blocker. What remains is takeable.
- **Resolve** = post the answer as a task comment (`add_task_comment`), set
  status `Done`, then append one line to MATT-1's Decisions-so-far.
- One ticket per session (research tickets excepted), per the wayfinder skill.

## For `to-tickets`, `to-spec` and `triage`

These skills assume one tracker that owns labels. In this repo:

- **Publish tickets directly to Paca** as children of the relevant milestone
  card (or `MATT-1` for wayfinder tickets) — Paca-first, per the table above.
  Blocking edges go in as native `blocks` links at creation time.
- Triage state ("ready-for-agent" etc.) is the Paca-side **tag**; Trellis
  `task.json` has **no label field** (verified), so never read triage back
  from Trellis. See `triage-labels.md`'s vocabulary table.
- Trellis `create`/`add-subtask` is for the *record* side only (PRD/notes
  directories), not for the todo itself.

## 多分支施工：**关票前先证「已并入」**

2026-10-17 一次会话里连着踩了两次，形态是同一个：**「票关了」与「交付落到集成分支上」
是两件事，而后者没有任何一步会替你检查。**

| 事故 | 症状 | 谁抓到的 |
|---|---|---|
| 修复提交 `43407cd` **从未并入** | 一次 `git merge` 因主工作区有未提交改动而 abort；补完那次改动后**忘了重跑 merge**。分支上文件是新的、主工作区是旧的 ⇒ 冒烟脚本每次崩在同一个参数错上，还往共享库留管理员账号（把 `db:check` C14 弄红） | 全组冒烟的 `db:check` C14 |
| `ticket/matt67` **整支未并入**，票已关 | 更隐蔽：该分支自己 `verify` 全绿、单测全绿，全组冒烟也不报错（导入页不在任何冒烟脚本的必经路径上）⇒ **代码根本不在集成分支里，而票是 Done** | 清理 worktree 时手工核的 |

**确定性的守卫**（一行、离线、不需要库）：

```bash
for b in $(git branch --list 'ticket/*' --format='%(refname:short)'); do
  git merge-base --is-ancestor "$b" HEAD && echo "✓ $b" || echo "✗ $b 未并入"
done
```

⚠ **`ticket/*` 不能裸用（`for b in ticket/*`）—— 那是文件名通配，不是分支通配。**
repo 里没有 `ticket/` 目录，通配符不展开，循环只跑一次、`$b` 是字面量 `ticket/*`：

```
fatal: Not a valid object name ticket/*
✗ ticket/* 未并入
```

⇒ **无论全并入还是一个没并入，都只印同一行 `✗`**。一条恒假的门禁比没有门禁更糟：
它让下一个人以为这一步是机械检查，实际它什么也没查。分支名只能由 **`git branch --list`**
枚举（上面那版）。

跑法：`pnpm branches:merged`（= `node tools/branch-merged.mjs ['<glob>']`，默认 `ticket/*`）。
同一判据，另外**扫到 0 个分支即判失败** —— 通配符写歪时不允许静默通过。

⚠ **它不进 `pnpm verify`，这是刻意的，不要"顺手"加进去。** `verify` 在 CI 上跑，而
`actions/checkout`（未配 `fetch-depth`）只拉**一个 ref、depth=1**：那种工作区里
`git branch --list 'ticket/*'` 匹配 **0 支**，于是 canary 会把 CI 每次跑都判红。
（实测过：`git clone --depth 1 --no-local . ` 之后 `ticket/*` 分支数 = 0。）
它与 `board:drift` 同类 —— **需要本地分支/板面状态的本地守卫，只能在关票那一侧手工跑**，
不能进 CI 门禁链。这条区分值得记住：判据越依赖"本地那棵工作树"，越不该挂 CI。

关票**之前**跑它。为什么必须是机械检查而不是"记得"：
两次都不是粗心，而是**中断后没回头**——第一次被 abort 打断、第二次在等代理回收时切走了。
"被打断"是这类施工的常态（并行 worktree + 后台代理 + 长任务），所以任何
「必须回头做」的步骤都得有东西替你回头看。

**为什么全组冒烟不足以兜住它**：冒烟只看**已并入的代码**的行为。
一张票的交付若完全不在集成分支上，冒烟连它的边都碰不到（导入页那条就是这样）。
所以这条守卫必须在**关票动作**这一侧，不在测试这一侧。

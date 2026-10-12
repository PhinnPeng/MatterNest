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

## Connection facts (verified 2026-10-10)

- **Paca MCP server `paca-matternest` is live** in this repo，配置在**项目** `.qoder/settings.json`
  （不是全局那份——全局只有 agileidentity / uniondesk / youmeng 三个 single-project 连接器）。
  旧的「Paca 不能走 MCP」说法来自**那两个错钉的 single-project 连接器**，与 MatterNest 无关。

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

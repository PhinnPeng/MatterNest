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

- **Paca MCP server `paca` is live** in this repo, registered as
  `mcp-paca-matternest` in `~/.dsh/cordis.patch.yml` (DSH's real MCP source;
  the old "Paca 不能走 MCP" note was about wrongly-pinned single-project
  connectors, not about MatterNest). Fallback for scripting: `agent-work/paca.mjs`
  / `paca-lib.mjs` (REST, key in project `.qoder/settings.json` — never print it).
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

1. **Register on Paca** (`mcp__paca__*` tools, or REST fallback):
   `create_task` with title/description; set `parentTaskId` when it belongs to
   a milestone or map card; apply triage tags at creation.
2. **Then** create the Trellis record if the work needs durable notes/PRD:
   `task.py create …`, `set-meta paca_task`. Do not hand-write task dirs.
3. Report both identifiers (Paca `MATT-<n>` and Trellis dir).

## If Paca is unreachable

Say so and stop. Do **not** create a local markdown issue file as a fallback,
and do not invent a Paca id. ("Unreachable" now means MCP **and** the
`paca.mjs` REST path both fail — check REST before declaring it down.)

## Reading current state

```
mcp__paca__list_tasks  (projectId resolved from project name MatterNest; do not hardcode at call sites outside this repo's scripts)
python ./.trellis/scripts/task.py list [--status in_progress]
```

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

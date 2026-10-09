# Issue Tracker

Work is tracked on two deliberately linked surfaces. Trellis owns the task
record; Paca owns the board. Neither replaces the other.

| Concern | Surface |
|---|---|
| Task identity, PRD, design notes | Trellis `.trellis/tasks/<yyyy-mm>/<id>/` |
| Lifecycle state (`planning` → `in_progress` → `completed`) | Trellis `task.json.status`, flipped by `task.py` |
| Portfolio / sprint board, rollups, automation | Paca |
| Triage labels | Paca (see `triage-labels.md`) |

## The link

Trellis id `demo-slice` ⇄ Paca task number. The Paca number is stored back into
Trellis with:

```
python ./.trellis/scripts/task.py set-meta <dir> paca_task <number>
```

and the Trellis id is embedded in the Paca task description as `trellis:demo-slice`.
That pair is the join — there is no other linkage.

## Creating a ticket

**Trellis first.** Never hand-write task directories, and never create a
`.scratch/` markdown tree — `.trellis/tasks/` already is that.

```
python ./.trellis/scripts/task.py create "<title>" --description "<desc>" --priority P0|P1|P2|P3
python ./.trellis/scripts/task.py add-subtask <parent-dir> <child-dir>
python ./.trellis/scripts/task.py start <dir>          # → in_progress
python ./.trellis/scripts/task.py archive <task-dir>   # → completed + move to archive/
```

Then mirror to Paca so the work reaches the board:

1. `list_projects` → pick the project whose name matches MatterNest. Resolve by
   name at runtime; do not hardcode a project id.
2. `create_task` with the Trellis title/description and `trellis:<id>` embedded.
3. `set-meta` the returned task number back into the Trellis task.

Report both identifiers — the Trellis task dir and the Paca task number.

## If the Paca MCP server is not connected

Say so and stop. Do **not** create a local markdown issue file as a fallback,
and do not invent a Paca id. The Trellis record is already durable and git
tracked, so the mirror can happen later without loss. The `paca` skill states
this same rule; this file agrees with it.

## Reading current state

```
python ./.trellis/scripts/task.py list
python ./.trellis/scripts/task.py list --status in_progress
python ./.trellis/scripts/task.py list-archive [month]
```

## For `to-tickets`, `to-spec` and `triage`

These skills assume one tracker that owns labels. In this repo:

- create and break down through Trellis (`create`, `add-subtask`) — not as loose
  markdown files
- mirror to Paca for board visibility
- treat the five triage labels as **Paca-side** vocabulary; see the caveat in
  `triage-labels.md` before assuming a label is readable back from `task.json`
<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

## Agent skills

### Issue tracker

Two linked surfaces: Trellis `.trellis/tasks/` owns the task record and lifecycle, Paca owns the board view. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, each label equal to its name; they live on the Paca side because Trellis `task.json` has no label field. See `docs/agents/triage-labels.md`.

### Domain docs

single-context — one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

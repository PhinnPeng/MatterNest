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

### UI 文案与结构

**旁白**（复述紧邻已经写着的东西、或把规则/排序/权限/为什么为空讲成一句散文）一律删；一句话要么是事实、要么是动作，要么落进四类落点（空态/错误态、控件说明、tooltip、字段表），规则类的话搬到动作发生处。触发点：写或改任何界面文案、新增页面或区块结构、**写原型 HTML**（它在 `prototype/*` 分支上，lint-guard 的源码断言扫不到）。细则见 `.trellis/spec/frontend/component-guidelines.md`「副标题纪律」。

### 对话回答

对话一律中文。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

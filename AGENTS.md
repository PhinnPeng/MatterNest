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

### 文件编码

源码与文档一律 **UTF-8（无 BOM）**，`pnpm verify` 的 `tools/encoding-check.mjs` 守着。

Windows 下不要用 PowerShell 的 `>` / `Out-File` 写中文文件：5.1 默认 UTF-16LE，`Get-Content` 默认按 ANSI(GBK) 解码，来回一次就把中文固化成 U+FFFD，**不可逆**。写文件用编辑工具或显式 `-Encoding utf8`；临时产物落在 `.gitignore` 已忽略的目录。

命令输出乱码不等于文件坏了：本机控制台代码页是 gb2312，先 `chcp 65001`（或 `[Console]::OutputEncoding = [Text.UTF8Encoding]::new()`）再跑 git / verify。

### 本地起服务

`pnpm dev` 用独立进程启动（`Start-Process cmd /c "pnpm dev > %TEMP%\mn-dev.log 2>&1"`），再轮询 `/login`。后台 shell 被判定结束时 Next 子进程可能残留并占住 3777：表现为页面 502、重跑 `EADDRINUSE`；先 `Get-NetTCPConnection -LocalPort 3777` 找到属主，再决定是否结束进程。

### 改页面前

先读 `.trellis/spec/frontend/index.md`。DataTable、`useListState`、`rulesFor` 这些硬约定写在分册里，不读就会在 review 被抓。

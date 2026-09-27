# Bootstrap Task: Fill Project Development Guidelines

**You (the AI) are running this task. The developer does not read this file.**

The developer just ran `trellis init` on this project for the first time.
`.trellis/` now exists with empty spec scaffolding, and this bootstrap task
exists under `.trellis/tasks/`. When they want to work on it, they should start
this task from a session that provides Trellis session identity.

**Your job**: help them populate `.trellis/spec/` with the team's real
coding conventions. Every future AI session — this project's
`trellis-implement` and `trellis-check` sub-agents — auto-loads spec files
listed in per-task jsonl manifests. Empty spec = sub-agents write generic
code. Real spec = sub-agents match the team's actual patterns.

Don't dump instructions. Open with a short greeting, figure out if the repo
has any existing convention docs (CLAUDE.md, .cursorrules, etc.), and drive
the rest conversationally.

---

## Status (update the checkboxes as you need to complete each item)

- [x] Fill backend guidelines（5 份 + `index.md`）
- [x] Fill frontend guidelines（6 份 + `index.md`）
- [x] Add code examples —— **口径修正见下**：本仓当前**零应用代码**（只有 `docs/` 与 `.trellis/`），所以"引用仓库内真实示例"做不到。示例一律写成**待落地的目标形态**并标注出处，代码落地后由后续票回填真实路径
- [x] `.trellis/config.yaml` 的 `packages` 段：已实测，**结论是不填**（理由见"本票的两条裁定"第 2 条）

---

## 本票映射：落地方案 W0-7

票面出处：`docs/implementation-plan-v1.md` §3 M0 的 **W0-7**（标注为"审"票，且是 §7 的**硬派单前置**）。

**内容来源（只从这几处抄，不再自创规则）**：

| 来源 | 用作 |
|---|---|
| `docs/tech-stack-decision.md` §13.5 | 现行八条禁令 + 两条部署级（**明写不要抄 §12.3 的 v4 版**） |
| 同上 §13.3 / §13.2 | Next 侧四条硬约束；Nuxt 结论的继承/作废 |
| 同上 §4 | 设计约束 → 技术落点对应表（本票各文件的目录） |
| 同上 §3.3 / §3.4 / §3.5 / §3.6 / §5 / §6 / §12.5 | 样式三条、双通道登录、advisory lock、明确不做、仓库拓扑、部署四条、缓存决定 |
| `docs/PRD-phase1-enums-and-schemas.md` §5.1–§5.4、§4.4 | 单一事实源、三条 CHECK 模板、加值规则、`scope_key` 向量 |
| `docs/PRD-phase1-permission-design-draft.md` §4/§4.1/§7.3/§10 | ScopeResolver、可见用户集、脱敏导出、契约矩阵 |
| `docs/implementation-plan-v1.md` §4 | 八条规范的措辞（与 §13.5 对齐） |

**验收（本票自证的判据）**：
1. 12 份模板里不再出现 `(To be filled by the team)` 与 `To fill`；每份的每条硬规则都带**出处到章节号**。
2. §13.5 八条禁令**逐条落进对应 spec 文件**，一条不丢、一条不改写语义（① `src/shared` 纯 TS ② Drizzle `.where()` ③ 生成列 ④ 禁 `push` ⑤ `/api/**`+`withScope` ⑥ 页面壳零业务数据 ⑦ 唯一组件体系 ⑧ 表格服务端分页 ≤100）。
3. 未证实项不得写成既有能力：`research-nextjs-stack.md` §5 的 N1–N7、§12.4 各项，一律标 `UNVERIFIED`。
4. `py -3 ./.trellis/scripts/get_context.py --mode packages` 仍能列出 backend/frontend 两层（即没被 packages 段打断）。

---

## 本票的两条裁定

**1. spec 语言 = 中文**（覆盖模板结尾的 "All documentation should be written in **English**"）。
这正是技术选型 §7 末尾挂着的那条未决口径冲突。裁定理由：八条禁令与枚举表必须**逐字引用**，译成英文会引入翻译漂移，而这条 spec 的唯一读者是派单子代理——它同时读中文设计文档。标题与目录结构保持模板原样，便于 `trellis update` 做块级替换。

**2. `packages` 段维持注释、不填**（这条**推翻**技术选型 §5 最后一行的判断）。
实测（`.trellis/scripts/common/config.py:396` `get_spec_base()` + `packages_context.py:30` `_scan_spec_layers()`）：一旦声明 `packages`，spec 基准目录就从 `spec/` 变成 `spec/<package>/`。往里塞 `backend: {path: src/lib/server}` / `frontend: {path: src/app}` 后，`get_context.py --mode packages` 打印的是：

```text
### backend
Path: src/lib/server
Spec: not configured      ← 反而拿不到东西
```

本仓是**单个 Next.js 应用**（§5 自己写的"仍是一个 app，不是回到 apps/server + apps/web"），Trellis 的单仓模式正好匹配现有的 `spec/backend/` + `spec/frontend/` 两层布局。要真用 packages，得先把 spec 整体搬进 `spec/<package>/<layer>/`——那是 monorepo 拆分时才值得付的成本，一期不拆。结论写进 `config.yaml` 注释里，防止下一个人"顺手补上"。

---

## Spec files to populate


### Backend guidelines

| File | What to document |
|------|------------------|
| `.trellis/spec/backend/directory-structure.md` | Where different file types go (routes, services, utils) |
| `.trellis/spec/backend/database-guidelines.md` | ORM, migrations, query patterns, naming conventions |
| `.trellis/spec/backend/error-handling.md` | How errors are caught, logged, and returned |
| `.trellis/spec/backend/logging-guidelines.md` | Log levels, format, what to log |
| `.trellis/spec/backend/quality-guidelines.md` | Code review standards, testing requirements |


### Frontend guidelines

| File | What to document |
|------|------------------|
| `.trellis/spec/frontend/directory-structure.md` | Component/page/hook organization |
| `.trellis/spec/frontend/component-guidelines.md` | Component patterns, props conventions |
| `.trellis/spec/frontend/hook-guidelines.md` | Custom hook naming, patterns |
| `.trellis/spec/frontend/state-management.md` | State library, patterns, what goes where |
| `.trellis/spec/frontend/type-safety.md` | TypeScript conventions, type organization |
| `.trellis/spec/frontend/quality-guidelines.md` | Linting, testing, accessibility |


### Thinking guides (already populated)

`.trellis/spec/guides/` contains general thinking guides pre-filled with
best practices. Customize only if something clearly doesn't fit this project.

---

## How to fill the spec

### Step 1: Import from existing convention files first (preferred)

Search the repo for existing convention docs. If any exist, read them and
extract the relevant rules into the matching `.trellis/spec/` files —
usually much faster than documenting from scratch.

| File / Directory | Tool |
|------|------|
| `CLAUDE.md` / `CLAUDE.local.md` | Claude Code |
| `AGENTS.md` | Codex / Claude Code / agent-compatible tools |
| `.cursorrules` | Cursor |
| `.cursor/rules/*.mdc` | Cursor (rules directory) |
| `.windsurfrules` | Windsurf |
| `.clinerules` | Cline |
| `.roomodes` | Roo Code |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `.vscode/settings.json` → `github.copilot.chat.codeGeneration.instructions` | VS Code Copilot |
| `CONVENTIONS.md` / `.aider.conf.yml` | aider |
| `CONTRIBUTING.md` | General project conventions |
| `.editorconfig` | Editor formatting rules |

### Step 2: Analyze the codebase for anything not covered by existing docs

Scan real code to discover patterns. Before writing each spec file:
- Find 2-3 real examples of each pattern in the codebase.
- Reference real file paths (not hypothetical ones).
- Document anti-patterns the team clearly avoids.

### Step 3: Document reality, not ideals

**Critical**: write what the code *actually does*, not what it should do.
Sub-agents match the spec, so aspirational patterns that don't exist in the
codebase will cause sub-agents to write code that looks out of place.

If the team has known tech debt, document the current state — improvement
is a separate conversation, not a bootstrap concern.

---

## Quick explainer of the runtime (share when they ask "why do we need spec at all")

- Every AI coding task spawns two sub-agents: `trellis-implement` (writes
  code) and `trellis-check` (verifies quality).
- Each task has `implement.jsonl` / `check.jsonl` manifests listing which
  spec files to load.
- The platform hook auto-injects those spec files + the task's `prd.md`
  into every sub-agent prompt, so the sub-agent codes/reviews per team
  conventions without anyone pasting them manually.
- Source of truth: `.trellis/spec/`. That's why filling it well now pays
  off forever.

---

## Completion

When the developer confirms the checklist items above are done with real
examples (not placeholders), guide them to run:

```bash
python ./.trellis/scripts/task.py finish
python ./.trellis/scripts/task.py archive 00-bootstrap-guidelines
```

After archive, every new developer who joins this project will get a
`00-join-<slug>` onboarding task instead of this bootstrap task.

---

## Suggested opening line

"Welcome to Trellis! Your init just set me up to help you fill the project
spec — a one-time setup so every future AI session follows the team's
conventions instead of writing generic code. Before we start, do you have
any existing convention docs (CLAUDE.md, .cursorrules, CONTRIBUTING.md,
etc.) I can pull from, or should I scan the codebase from scratch?"

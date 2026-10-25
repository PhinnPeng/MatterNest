# AI 时代的分支管理：agent 并发、worktree 与「分支绿 ≠ 合并后绿」

> 归属：版本控制 / 并发施工。触发：同一个 repo 上同时跑多个 AI 会话（本次实测 3 个 worktree），上一轮只定了命名空间与清理判据，没定「会话 — worktree — 分支」三者的对应关系。
> 承接：`docs/research-branch-strategy-2026-10-25.md`（下称「上一轮」）。**本文只写增量**：清理判据、`git branch -d` 的 upstream 陷阱、squash 只能看 PR 状态，一律引上一轮章节号（§3.2 / §3.4 / §5.1 / §6.3），不复述。
> 版本基线：git **2.51.0.windows.1**（实测）、远端 `PhinnPeng/MatterNest`、3 个 worktree、主树 114 个未提交改动（上一轮为 112）。
> 证据纪律：Matt Pocock 只认他本人站点 / 仓库 / 本人 issue 回复 / 本人演讲；第三方转写单独标注。核验日期 **2026-10-25**。

---

## 1. 结论

| 问题 | 答案 |
|---|---|
| Matt Pocock 讲过「仓库/分支怎么管」吗 | **讲过执行层，没讲过仓库卫生层**。他讲的是「一个 ticket 一个 worktree、汇到一条集成分支」，并把它做成了库（`sandcastle` 有三种 `branchStrategy`）；仓库是否 monorepo、分支怎么命名、分支怎么清、PR 该多大，**没有一手材料**，其中 PR 大小是他本人承认未解决的一项。见 §2 |
| AI 时代变了什么 | 三件事有官方一手依据：①并行 agent = 并行 worktree（git / Anthropic / OpenAI 三家文档）；②短命分支的「一个开发者」单位扩成「一个开发者 + 他的 agents」，2 天上限不变，且**每棵树独立计时**；③官方承认「分支上的绿 ≠ 合并后的绿」（required status checks 的 loose 模式原文）。见 §3 |
| 本仓要改什么 | 五个命名空间**不动**；新增一张 **worktree 合同表**（位置 / 目录名 / 一树一会话 / 回收四条判据）；`wip/*` 的 7 天上限改成 2 天；删除判据加第 4 问「有活会话在写吗」；合并判定改成「回主树、在 `main` 上重跑一次」。见 §4 |

**与上一轮相比，改了什么**

1. `wip/<owner>/<slug>` 的 **≤7 天** → **≤2 天**。上一轮自认这个数字「没有一手依据」；现在 TBD 明文把 2 天规则延伸到 agent 分支，且「每棵树各自计时」。
2. 删除三问（内容在哪 / 谁在用 / 删了丢什么，上一轮 §3.1）加**第 4 问**：有没有活会话正在这棵树上写。`git worktree list` 证明的是「被 checkout」，不是「有人在写」——2026-10-18 的撞车正是**一条分支、一个 worktree、两个会话**。
3. 新增 **worktree 合同**（§4.2）：这不是第六个命名空间，是同一命名空间下的位置与回收约定。现状两支 worktree 的目录名都不合规（`MatterNest-prototype`、`matt66`）。
4. 合并判定从「合并动作之后跑一次守卫」升级为「**在 `main` 所在的那棵树、对 `main` 重跑 `pnpm verify`**」。多 worktree 之后 `HEAD` 不再是单数，上一轮 §6.3 记的「判 HEAD 不判 main」从便利问题变成结构问题。

**没改什么**：五个命名空间与「`main` 唯一集成分支」（上一轮 §5.1）；清理判据与 `-d` 不可信（§3.2）；合并即删远端、已落地不推（§4.2）；`branches:merged` 不进 `pnpm verify`（§6.3）；不引入 stacked PR / merge queue（§3.3 给判据）。

---

## 2. Matt Pocock 的一手材料核查

### 2.1 他讲过的（原文 + 链接 + 日期）

**P1 · 一个 ticket 一个 worktree，汇到一条集成分支。** 他的 `/implement-spec` 技能文档（本人站点，2026-10-05 更新）原文：

> 「hands each ticket to an implementer subagent working in its own git worktree, merges each finished branch into a single **integration branch**, runs code-review over the result, and resolves the tickets.」
> 前置条件原文：「A harness that runs subagents in the background and gives each one a git worktree.」
> 落地顺序原文：每个 implementer「merges the integration branch tip into its own branch before reporting done, so landing it is a fast-forward.」
> — <https://www.aihero.dev/skills-implement-spec>

这条与本仓的形态对得上：`feat/*` 就是 integration branch，`ticket/*` 就是一个 ticket 一个分支（上一轮 §5.1）。差别是他用 **worktree 强制隔离**，本仓靠人记得。

**P2 · `/implement` 保持单会话，并行只发生在 `/implement-spec`。** 他在自己仓库的 issue 里回复（2026-10-06，Owner）：

> 「`/implement-spec` runs each ticket's implementer in its own worktree and merges into one integration branch. `/implement` stays single-session.」
> — <https://github.com/mattpocock/skills/issues/493#issuecomment-6016346749>

同一个 issue 的提议方（二手，非他本人）把失败形态写得很具体：两个会话共享一棵树时，`--amend` 改写兄弟提交、`git stash` 往返开 30 秒窗口、兄弟 WIP 污染全树 typecheck。这三条与本仓 2026-10-18 撞车的代价同形。

**P3 · 分支策略是库的第一等概念，不是口头约定。** `sandcastle` README 原文：

> 「Sandcastle handles sandboxing the agent with a configurable **branch strategy**.」
> 三种：「**Head** — The agent writes directly to the host working directory. No worktree, no branch indirection.」「**Merge-to-head** — … creates a temporary branch in a git worktree … changes are merged back to HEAD when done.」「**Branch** — Commits land on an explicitly named branch in a git worktree.」
> 示例分支名：`branchStrategy: { type: "branch", branch: "agent/fix-42" }`
> — <https://github.com/mattpocock/sandcastle>（README，无日期戳；本次抓取 2026-10-25）

**P4 · worktree 复用默认开启，脏树保留而不是删。** 他的 ADR 0003：

> 「**Clean worktree** … → reuse it, and emit one `console.log` line so the user knows the starting state wasn't fresh. **Dirty worktree** … → reuse it, and emit a warning … The agent starts with whatever state is there.」
> 刷新只在「干净 + 严格落后 origin」时做 `git merge --ff-only`，「If the worktree is dirty, or the branch has diverged … the refresh is skipped」。
> — <https://github.com/mattpocock/sandcastle/blob/main/docs/adr/0003-reuse-worktree-by-default.md>

对本仓的用法是反的：他复用，我们**回收**。但判据可以借用——「dirty 就不动它」是两边都成立的安全边界。

**P5 · worktree 不消除冲突，只把冲突推迟到 merge；且树里只有 git 跟踪的东西。** 同一篇技能文档原文：

> 「Worktrees don't remove collisions; they postpone them to merge time.」
> 「A worktree holds only what git tracks. Tests that read gitignored fixtures, local databases, or credentials can silently skip there. For a ticket whose verification depends on untracked material, tell the orchestrator to run it in the main checkout instead.」
> — 同 P1

第二条是本仓最该抄的一条：冒烟要真库、要 `.env`（`AGENTS.md:65` 的起服务流程），在 worktree 里只会**静默跳过**，看起来是绿的。

**P6 · `AGENTS.md` 的取舍标准（用于 §4.5）。** 技能文档原文：

> 「`CLAUDE.md` loads into every session unconditionally. Material behind a pointer costs only the pointer's own line until it fires. Anything that applies in one session out of ten costs context load in the other nine.」
> 「Reference that only one branch needs sits behind a pointer rather than in the main file.」
> — <https://www.aihero.dev/skills-writing-for-agents>（2026-08-24 更新）

### 2.2 他没讲过的（明确「未找到」）

| 话题 | 结论 |
|---|---|
| monorepo vs 多仓 | **未找到一手材料**。他的公开仓库里没有仓库拆分/合并的论证；技能文档只假定「一个 repo」 |
| trunk-based vs PR 流 | **只有半个立场**：P1 说「PR 只在你的 tracker 用 PR 收活时才开，否则停在集成分支上」——这是「PR 可选」，不是团队级分支模型判据 |
| 分支命名规范 | **未找到规则**。唯一可引的是 P3 的示例字面量 `agent/fix-42`，那是 README 的示例值，没有「应该这样命名」的说法 |
| commit 粒度 | **未找到**。`/implement` 只说「commit to the current branch」，没有一条多/一条少的判据 |
| PR 大小 | **他本人承认没解决**：AI Engineer Europe 2026 的 talk（1:04:58 段落）转写原文「he does not present a complete solution for reconciling rapid implementation with small, self-contained pull requests」。**这是二手转写**（<https://ai.engineer/talks/ai-coding-workflow>），原始视频 <https://www.youtube.com/watch?v=-QFHIoCo-Ko> |
| 分支清理 / 删除判据 / tag 冻结 / reflog | **未找到**。这一层他全部交给工具的 `close()` / `wt.close()`，没有分支卫生的成文规则 |
| worktree 目录该放哪 | **未找到成文规则**；`sandcastle` 实现放在 `.sandcastle/worktrees/<name>/`（ADR 0003 原文），这只是实现选择 |

**搜过的位置**：`mattpocock.com`（首页无 git 内容）、`aihero.dev/posts` 索引与其技能页（`skills-implement`、`skills-implement-spec`、`skills-writing-for-agents`、`skills-setup-matt-pocock-skills`）、GitHub `mattpocock/skills`（README + issue #493）、`mattpocock/sandcastle`（README + ADR 0003）、`ai.engineer` 的 talk 转写页。**没读**：他的 X/Twitter 时间线（需登录，本次无凭据）、YouTube 视频原文（只读了转写页与章节摘要）、`totaltypescript.com` 的 blog 全文（只经搜索摘要确认无 git 分支主题）。⇒ 上面「未找到」的结论限定在这批材料内。

---

## 3. AI 时代的一手证据（四条线）

### 3.1 并行 agent = 并行 worktree　【一致，需补两条限制】

- **git 官方**：`git worktree` 的定位是「Manage multiple working trees attached to the same repository … allowing you to check out more than one branch at a time」，且「sharing everything except per-worktree files such as `HEAD`, `index`」⇒ **refs 与对象库共享**，所以上一轮「同一 `.git` 下的 linked worktree 不需要推」继续成立（上一轮 §4.2）。
  两条限制原文：`add` 默认「refuses … when `<commit-ish>` is a branch name and is already checked out by another worktree」（`--force` 可破）；BUGS 段「Multiple checkout in general is still experimental, and the support for submodules is incomplete. It is NOT recommended to make multiple checkouts of a superproject.」— <https://git-scm.com/docs/git-worktree>（2.56 手册，本机 2.51 命令集一致）
- **Anthropic 官方**：`claude --worktree <name>` 在 `.claude/worktrees/<name>/` 建树、分支名 `worktree-<name>`；`.worktreeinclude` 把 gitignored 的 `.env` 等复制进新树；退出时按「干净 / 有改动 / 分支被占 / 状态不可判」四类分别删除、询问、保留；后台会话与子代理的树由周期性清扫按 `cleanupPeriodDays` 回收，「The sweep leaves a worktree in place … The worktree still holds work: changed or untracked files, or unpushed commits.」— <https://code.claude.com/docs/en/worktrees.md>
- **OpenAI 官方**：Codex 在 `$CODEX_HOME/worktrees` 建树，「The worktree isn't checked out as a branch. It's in a detached HEAD state. This lets Codex create several worktrees without polluting your branches.」；默认保留最近 15 个受管树；分支限制原文「Git only allows a branch to be checked out in one place at a time」，报错样例 `fatal: 'feature/a' is already used by worktree at '<WORKTREE_PATH>'`。— <https://learn.chatgpt.com/docs/environments/git-worktrees>

**需补的两条**：①「被 checkout」≠「被占用写」，工具侧的隔离靠**一树一会话**，不是靠 git 的拒绝；② 官方工具都会自动回收（Claude 清扫 / Codex 保留 15 个），本仓没有任何自动回收，所以回收判据必须自己写（§4.2）。

### 3.2 短命分支与合并频率　【需修改上一轮】

TBD 官方页已经把 agent 写进去了，原文：

> 「**With agentic coding:** the unit is one developer and their coding agents. A branch with one developer and three agents working on it is still one unit, as long as it is that developer's agents and that developer's intention. Two developers' agents congregating on the same branch is two units.」
> 「the branch should only last a couple of days. Any longer than two days, and there is a risk of the branch becoming a long-lived feature branch.」
> 「If you do have more than one worktree in play … Each branch in each worktree is still bound by the two-day rule, independently.」
> 「Delete the worktree (`git worktree remove`) when its branch is merged and deleted. `git worktree list` tells you what you have forgotten about.」
> — <https://trunkbaseddevelopment.com/short-lived-feature-branches/>

同一页还给了本仓最像的一条风险描述：「The risk: one developer, many branches … Worktrees remove the friction, so it becomes easy to have four or five branches open … every one is a merge you have not yet done.」

⇒ **需修改**：上一轮 `wip/*` 的 7 天没有依据（它自己也这么写），改成 2 天；`ticket/*` 的「≤2 天」从 TBD 拿到依据，不再是 TBD（待定）。`feat/*` 的 2 周收口线仍无一手依据，保留为**本仓自定**，但表述改成「超过 2 天就已经违约，2 周是拆分 deadline 不是许可」。

### 3.3 stacked PR / 小步合并　【新增，但本仓暂不引入】

GitHub 已把 stacked PR 做成产品能力（public preview，2026-07-30 changelog：<https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview>），官方文档原文：

> 「Stacked pull requests let you open a new pull request on top of one that is still open … each one shows only the diff for its layer.」
> 「Fit for high-volume development — When you generate a lot of code at once, often with AI agents, a stack gives each change a place to go. An agent completes one task, then starts the next task that builds on it.」
> 「Stacks support merge commit, squash, and rebase merge methods … pull requests must merge from the bottom up.」
> — <https://docs.github.com/en/pull-requests/get-started/about-stacked-prs>

第三方工具侧（官方 docs，只作存在性证据）：`git-spice` 的「Merge submitted CRs bottom-up from the command line. git-spice waits for each CR to be ready, merges it, then restacks and updates branches above it.」— <https://abhinav.github.io/git-spice/>

**本仓判据**：满足全部三条才引入 —— ①同一条 `feat/*` 上同时挂着 ≥2 个未合并且互相依赖的改动；②这些改动的评审必须发生（有人要看 diff）；③分层的 base 关系能写清。现状三条都不成立：PR 不是主路径（21 个 merge commit / 1 个 PR，上一轮 §2），合并在本地做。⇒ **不装 `gh stack`，不建栈**；上面三条任一变化时再回来看。

### 3.4 agent 产出的可核验性　【新增】

- **「分支绿 ≠ 合并后绿」是官方承认的**。required status checks 的两种模式原文：**Strict**（要求分支与 base 同步）vs **Loose**（不要求）——Loose 的代价栏写的是「Status checks may fail after you merge your branch if there are incompatible changes with the base branch.」— <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches>
  ⇒ 本仓在本地 merge（不走 PR 门禁），所以这条只能用**流程**补：合并后在 `main` 上重跑，而不是相信分支上那次绿。
- **merge queue 的适用面**：官方说它「particularly useful on branches that have a relatively high number of pull requests merging each day from many different users」，作用是「ensuring the branch is never broken by incompatible changes」（同页）。本仓每天 0–1 次合并、单人 ⇒ **不启用**，理由有官方原文支撑，不是偏好。
- **CI 的 checkout 默认只拉一个 commit**：`actions/checkout` README 原文「Only a single commit is fetched by default, for the ref/SHA that triggered the workflow」，`fetch-depth` 默认 `1`（<https://github.com/actions/checkout>，本仓 `.github/workflows/ci.yml:84` 用的 `actions/checkout@v4` 未传 `fetch-depth`）。这就是「依赖本地分支状态的守卫不能进 CI」的机制来源（上一轮 §6.3 已有结论，这里补上官方原文）。
- **本仓的门有哪些**：`pnpm verify` = `format:check && encoding-check && lint && typecheck && test && lint-guard && anchors:check && canon:check && deploy:check`（`package.json:35`，**不含 build**，CI 另跑 `pnpm build`，`.github/workflows/ci.yml:153-154`）；`pnpm smoke` 需要真库 + dev server 3777（`package.json:34`）；CI 只在 `main` 的 push / PR 上跑（`.github/workflows/ci.yml:3-7`）。
- **提交这一侧的门跑在哪棵树**：`.githooks/pre-commit:34` 是 `cd "$(dirname "$0")/../.."`，而 worktree 共享主仓 `.git/hooks` ⇒ **从 linked worktree 提交时，`pnpm verify` 跑在主树上**（该文件 `:25-28` 已记录这个选择）。⇒ 一条分支的提交能不能过，取决于**另一棵树**的脏状态。

---

## 4. 落到本仓的增量

### 4.1 五个命名空间：不动

上一轮 §5.1 的判据是「命名空间 = 可被门禁区分的合并合同」。agent 并发不改变任何一条合同：`ticket/*` 仍必须落地、`prototype/*` 仍永不落地、`wip/*` 仍不合并。**worktree 是「这条合同占用的物理位置」，不是新合同**，所以不进表。

`wip/*` 只改一处数字：**≤7 天 → ≤2 天**（§3.2）。到期动作不变：要留的提交先 `git cherry-pick` / `format-patch` 拾走再删（上一轮 §5.1）。

### 4.2 worktree 合同（新增，写进 `docs/agents/branching.md`）

| 项 | 规则 | 机械判据 |
|---|---|---|
| 位置 | 非主树一律放 `F:/WorkSpace/mn-wt/`；主树 `F:/WorkSpace/MatterNest` 是唯一例外 | 路径的父目录是 `mn-wt` |
| 目录名 | = 分支名把 `/` 换成 `-`，如 `feat-matter-form-slim`。**不用票号、不用产品名** | `basename <path>` 与 `%(refname:short)` 逐字对应 |
| 一树一会话 | 同一棵树上不得有两个会话同时写。新建树前先 `git worktree list` | `git worktree list` + 15 秒 mtime 探针（`docs/agents/issue-tracker.md:326`） |
| 基数 | 从 `main` 开；合并前 `main` 必须是本分支的祖先（等价于 P1 的「先把 integration tip 合进来再落地」） | `git merge-base --is-ancestor main <branch>` 退出 0 |
| 回收四条 | ①分支已落地或已删 ②树干净 ③无活会话 ④不是主树。四条同时成立才 `git worktree remove` | 见下方命令 |

```bash
git for-each-ref --format='%(refname:short)	%(worktreepath)' refs/heads   # 分支→树 的唯一映射；2.51 实测有 %(worktreepath)
git -C <wt> status --porcelain          # 空 = 干净；有输出 = 脏，得 --force 才能删
git -C <wt> log -1 --format=%cI         # 最后一次提交；距今 > 2 天且无活进程 ⇒ 到期
git worktree remove <wt>                # 只删树，分支还在
git worktree prune -n                   # 目录被手工删掉后的管理记录（宽限期见上一轮 §7 第 10 行）
git worktree move <wt> F:/WorkSpace/mn-wt/<slug>   # 改名不改内容（2.51 有该命令）
```

**现状两支（本次实测，均干净、均无提交 7 天以上）**：

| 树 | 分支 | 最后提交 | 处置 |
|---|---|---|---|
| `F:/WorkSpace/MatterNest-prototype` | `prototype/p5-p6-2026-10-11` | 2026-10-16 23:52 | 目录名不含 `mn-wt`、也不是分支名 ⇒ 先 `git worktree move` 到 `mn-wt/prototype-p5-p6-2026-10-11`；分支本身按上一轮 §3.5 **不删**（本地领先远端 44） |
| `F:/WorkSpace/mn-wt/matt66` | `prototype/p9-p18-2026-10-17` | 2026-10-17 15:33 | 目录名是票号，读不出分支 ⇒ `git worktree move` 到 `mn-wt/prototype-p9-p18-2026-10-17` |

两支都是 `prototype/*`，按合同「永不落地」，所以**回收的是树，不是分支**；需要看原型时再 `git worktree add <path> <branch>` 重建即可（两分钟的事，和 8 天不用它的代价相比不亏）。

### 4.3 要不要加 `agent/<session>`：不加

判据（沿用上一轮 §5.1）：**新命名空间只在「门禁需要对它区别对待」时才加**。`agent/*` 想要的合同是「不合并、不推远端、到期即删」——与 `wip/<owner>/<slug>` 逐条相同。加一个同合同的前缀，收益是名字更醒目，代价是六个命名空间变七个、`branch-merged.mjs` 的 glob 清单再长一条、清理时要多判一类。P3 里的 `agent/fix-42` 是库的示例值，不是政策。

真正的缺口不在前缀，而在**归属**：`wip/<owner>/<slug>` 的 `<owner>` 在 agent 场景下没人填得对。补法不是新前缀，是让 `<owner>` 取**能定位到会话的值**（如 `wip/sess-a978e27d/<slug>`），这样 `git worktree list` + 目录名就能回答「这棵树是谁的」。

### 4.4 并发冲突面：三分，越界的不写进分支政策

| 冲突面 | 归属 | 处置 | 依据 |
|---|---|---|---|
| 同一文件被两个会话改 | **分支策略** | 一条分支一个写者；发现第二个写者立刻停手、由人裁定主线 | 一树一会话（§4.2）+ `issue-tracker.md:329` 的停手判据 |
| 从 worktree 提交却跑主树的 `verify` | **分支策略** | 合并/提交判定一律以主树为准；worktree 里的绿不算 | `.githooks/pre-commit:25-34` |
| 需要真库 / 真 `.env` 的验证（`pnpm smoke`） | **分支策略（只写一条）** | 冒烟**只回主树跑**；worktree 里不许跑，也不许把「没跑」当绿 | P5 原文 + `package.json:34` |
| 端口 3777、开发库 30432、`node_modules` | **环境约定**，不写进分支政策 | 一棵树一套端口/库；`3777` 钉死在 `package.json:11`，要多树并行就得改成可覆盖 | TBD 原文「they will fight over the same TCP ports, the same local database, the same Docker container names」 |
| `.next` 缓存 | **环境约定**（且上一轮的担心要修正） | `.next` 在各自树内，**跨树不共享**；真正的冲突是同一棵树里 `dev` 与 `build` 并发（`ci.yml:137-139` 已写明） | `AGENTS.md:71`、`.github/workflows/ci.yml:137-139` |

一句话边界：**「哪条分支能合、合到哪、绿了没有」写进分支政策；「怎么让两棵树同时跑起来」写进环境约定。** 后者越界写进 `branching.md` 只会让那份文档变成第二本 `AGENTS.md`。

### 4.5 `AGENTS.md` 加一行，还是只写 `branching.md`

按 P6 的判据：`AGENTS.md` 每会话无条件加载，指针只花一行。**「开工先看有没有别的会话在同一棵树上」必须每次会话都生效**，其余（位置、命名、回收）只在开/删分支时用 ⇒ 前者进 `AGENTS.md`，后者进 `branching.md`。

`AGENTS.md` 候选原文（两行，插在「本地起服务」之前）：

```markdown
### 会话与工作树

开工前跑 `git worktree list`；一个分支只允许一个会话写，发现第二个写者立刻停手问人。
```

`branching.md` 增加「工作树」一节，内容 = §4.2 的表 + 命令。理由：`AGENTS.md` 已经 75 行、且被 `next dev` 的托管块占了一段，再塞一张表就是给每次会话加固定成本。

---

## 5. 与 `docs/agents/branching.md` 的差异表

| 现有条文 | 建议改成 | 依据 |
|---|---|---|
| `wip/<owner>/<slug>`：`7 天内删` | `2 天内删`（到期先拾走提交） | §3.2 TBD 原文；上一轮自认 7 天无依据 |
| 「一个分支只属于一行」 | 追加：「一棵 worktree 只属于一个会话」 | §3.1 三家官方文档 + 2026-10-18 撞车 |
| 「被占用的先 `git worktree remove`」（删分支三步的第 2 步） | 先判「有没有活会话在写」（mtime 探针），再判 checkout | `git worktree list` 只证明 checkout |
| 无 | 新增「工作树」节：位置 `mn-wt/`、目录名=分支名、回收四条、现成命令 | §4.2 |
| 合并：`pnpm branches:merged`（判 HEAD） | 追加：「在 `main` 所在的那棵树跑；多树环境下 HEAD 是复数」 | 上一轮 §6.3 + 本次 3 树实测 |
| 合并后「立刻跑一次关票守卫」 | 追加：「并在主树的 `main` 上重跑 `pnpm verify`；分支上的绿不算」 | §3.4 loose checks 原文 |
| 门禁边界：`branches:merged` 不进 `verify` | 不动，补一句机制来源：checkout 默认 `fetch-depth: 1` | §3.4 |
| 无 | 新增一句：「`pnpm smoke` 只在主树跑」 | P5 原文（worktree 只有跟踪文件） |
| `feat/*` 上限 2 周 | 保留 2 周为拆分 deadline，并注明「2 天是寿命上限」 | §3.2 |

---

## 6. 命令与设置清单

| # | 目的 | 命令 | 出处 / 备注 |
|---|---|---|---|
| 1 | 分支 → 树 的唯一映射 | `git for-each-ref --format='%(refname:short) %(worktreepath)' refs/heads` | `%(worktreepath)` **本机 2.51 实测存在**（实测输出见 §7） |
| 2 | 列树（含锁 / 可清） | `git worktree list --porcelain` | [git-worktree](https://git-scm.com/docs/git-worktree)；`locked` / `prunable` 字段 |
| 3 | 建树（新分支） | `git worktree add F:/WorkSpace/mn-wt/<slug> -b <branch> main` | 同上；`-b` 已存在则拒绝 |
| 4 | 建树（已有分支） | `git worktree add <path> <branch>` | 分支已被别处 checkout 时拒绝，`--force` 可破（不建议） |
| 5 | 改名 | `git worktree move <wt> <new-path>` | 2.51 有该命令；主树与含 submodule 的树不可移 |
| 6 | 删树 | `git worktree remove <wt>` | 只删干净树；脏树要 `--force`；主树不可删 |
| 7 | 清孤儿记录 | `git worktree prune -n` → `git worktree prune` | 宽限期 `gc.worktreePruneExpire`（默认 3 个月，上一轮 §7 第 10 行） |
| 8 | 锁住不想被清的树 | `git worktree lock --reason <txt> <wt>` | 官方：防止管理文件被 prune，也阻止 move/delete |
| 9 | 判「这条分支已含 main」 | `git merge-base --is-ancestor main <branch>; echo $LASTEXITCODE` | 0 = 已同步（上一轮 §3.2 的三态语义） |
| 10 | 判「树干净」 | `git -C <wt> status --porcelain` | 空输出才算干净 |
| 11 | 判「树多久没动」 | `git -C <wt> log -1 --format=%cI` | 配合 §4.2 的 2 天判据 |
| 12 | 树里有没有人正在写 | 两次 `Get-Item <file> \| % LastWriteTime`，间隔 15 秒 | `docs/agents/issue-tracker.md:326` 的实测形态 |
| 13 | 看某个 worktree 的锁 | `git worktree list -v` | 锁原因只在 verbose 输出里 |

设置类：GitHub required status checks 分 strict / loose 两种（§3.4）；本仓 `main` 无 protection、`rulesets=[]`（上一轮 §2），**本文不建议开**——单人直推、CI 只在 main 跑，开了只会挡住自己；要开的那天，先定「哪个 job 是 required」。

---

## 7. 来源

**Matt Pocock（一手）**

- <https://www.aihero.dev/skills-implement-spec>（2026-10-05 更新）：P1、P5。
- <https://github.com/mattpocock/skills/issues/493#issuecomment-6016346749>（2026-10-06，Owner 回复）：P2。
- <https://github.com/mattpocock/sandcastle>（README）：P3，`branchStrategy` 三形态、`agent/fix-42` 示例。
- <https://github.com/mattpocock/sandcastle/blob/main/docs/adr/0003-reuse-worktree-by-default.md>：P4。
- <https://www.aihero.dev/skills-writing-for-agents>（2026-08-24 更新）：P6。
- <https://ai.engineer/talks/ai-coding-workflow>：AI Engineer Europe 2026 talk 的转写（**二手编辑**），PR 大小未解决那条在 1:04:58 段；原始视频 <https://www.youtube.com/watch?v=-QFHIoCo-Ko>。

**git 官方**

- <https://git-scm.com/docs/git-worktree>：定位、per-worktree 文件、`add` 拒绝重复 checkout、`remove` 只删干净树、主树不可删、`lock` / `move` / `prune`、BUGS 段的「still experimental」。

**Anthropic 官方**

- <https://code.claude.com/docs/en/worktrees.md>：`.claude/worktrees/<name>`、`worktree-<name>` 分支、`.worktreeinclude`、退出时的四类判定、周期性清扫与 lock。
- <https://docs.claude.com/en/docs/claude-code/common-workflows>：`claude --worktree feature-auth` 的入口说明。

**OpenAI 官方**

- <https://learn.chatgpt.com/docs/environments/git-worktrees>：`$CODEX_HOME/worktrees`、detached HEAD、保留最近 15 个、`.worktreeinclude`、`fatal: 'feature/a' is already used by worktree` 的原文。

**方法论**

- <https://trunkbaseddevelopment.com/short-lived-feature-branches/>：2 天规则、agent 单位、每树独立计时、worktree 回收、共享工作站抢端口/库、worktree 不消除冲突。

**GitHub 官方**

- <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches>：required status checks 的 strict / loose 差异、merge queue 的适用面。
- <https://docs.github.com/en/pull-requests/get-started/about-stacked-prs>：stacked PR 的定义、AI 高产出场景、bottom-up 合并。
- <https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview>：public preview 日期、`gh extension install github/gh-stack`。
- <https://github.com/actions/checkout>：`fetch-depth` 默认 1、「Only a single commit is fetched by default」。

**第三方工具的官方 docs（只作存在性证据）**

- <https://abhinav.github.io/git-spice/>：bottom-up 合并与 restack 的行为描述。

**仓内**

- `docs/research-branch-strategy-2026-10-25.md`：上一轮全部判据（§2 现状、§3.2 删除判据、§4.2 合并即删、§5.1 命名空间、§6.3 门禁缺口）。
- `docs/agents/branching.md`：现有条文（§5 逐行对照）。
- `docs/agents/issue-tracker.md:307-331`：2026-10-18 两会话撞车的完整记录与 mtime 探针；`:291-296` 为什么 `branches:merged` 不进 CI。
- `.githooks/pre-commit:25-34`：从 worktree 提交跑主树 `verify` 的原因与已知代价。
- `.github/workflows/ci.yml:3-7, 84, 137-139, 153-154`：只在 main 触发、checkout 未传 `fetch-depth`、dev 与 build 共享 `.next` 的冲突、`pnpm build` 不在 `verify` 里。
- `package.json:11, 34, 35`：`dev --port 3777`、`smoke`、`verify` 的组成。
- `AGENTS.md:63-71`：起服务与 `.next` 的现有环境约定。

**本次实测（可复现）**

```bash
git worktree list                 # 3 棵：主树 / MatterNest-prototype / mn-wt/matt66
git config --get-regexp '^worktree'   # 无输出：没有任何 worktree.* 配置
git for-each-ref --format='%(refname:short) %(worktreepath)' refs/heads   # 2.51 支持
git -C F:/WorkSpace/MatterNest-prototype status --porcelain   # 空
git -C F:/WorkSpace/mn-wt/matt66 status --porcelain           # 空
git log -1 --format=%cI prototype/p5-p6-2026-10-11            # 2026-10-16T23:52:14+08:00
git log -1 --format=%cI prototype/p9-p18-2026-10-17           # 2026-10-17T15:33:08+08:00
git status --porcelain | Measure-Object -Line                 # 114
git worktree move -h                                          # usage 存在
```

---

## 8. 未能回答 / 需要拍板

1. **`wip/*` 的 2 天上限要不要按「会话」而不是「分支」计**：TBD 说每条分支独立 2 天，但一个会话可能横跨两天、两条分支。本次没找到能同时满足两者的表述。
2. **`<owner>` 用什么值**：§4.3 建议用会话 id（`wip/sess-a978e27d/<slug>`），但本仓的会话 id 在 OpenCode / ZCode / Codex 三处格式不同，哪个能稳定拿到没核。
3. **端口/库的多树方案**：`3777` 钉死在 `package.json:11`，要真正并行起两个 dev server 就得改成 `PORT` 可覆盖 + 每树一个库名。这是环境约定，本文只标边界、没给方案。
4. **`.githooks/pre-commit` 要不要按树跑**：现在从 worktree 提交跑主树 `verify`（`:25-28` 已标注这是刻意不改），代价是「A 树的提交被 B 树的脏文件挡住」。改它等于改所有树的提交流程，需要先决定 worktree 是否都装 `node_modules`。
5. **两支 prototype worktree 的处置**：本文给的是「移树保分支」，但 `prototype/p5` 本地领先远端 44 个提交（上一轮 §3.5）——如果原型已经没人看，正确动作可能是「打 annotated tag 后连分支带树一起清」，这只有你知道。

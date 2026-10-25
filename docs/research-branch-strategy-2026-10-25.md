# 分支策略：清理判据、远程约定与有限命名空间

> 归属：版本控制 / 多分支施工。触发：仓里已有 `main`、`ticket/*`、`feat/*`、`research/*`、`prototype/*`、临时 WIP 六种形态，但没有一份成文的分支模型；同时「稳定之后要不要清掉所有分支、推不推远程」没有判据。
> 版本基线：**git 2.51.0.windows.1**（`git --version` 实测）、GitHub 远端 `PhinnPeng/MatterNest`、`gh` 2.102.0。
> 证据纪律：git 侧只引 `git-scm.com` 官方手册并逐条在本机 2.51 上验过命令是否存在；GitHub 侧只引 `docs.github.com` 与 `cli.github.com`；仓内事实全部来自本次实测命令与文件原文。核验日期 **2026-10-25**。
> 本文只写判据和命令，不写「强烈建议」。所有「本仓现状」数字都是 2026-10-25 当次快照。

---

## 1. 结论

| 问题 | 答案 |
|---|---|
| 稳定之后该不该「清掉所有分支」 | **不该把「清空」当目标**。目标是「每个 ref 都有归属和到期判据」。本仓现有 6 支本地分支里，**3 支可删、3 支不可删**：`prototype/p5-p6-2026-10-11` 的本地副本比远端多 44 个提交（`git rev-list --left-right --count` 实测 `44 0`），删了就是丢东西 |
| 删分支的机械判据是什么 | 两条：①内容已在集成分支（`git merge-base --is-ancestor` 退出 0，或 `git cherry` 全 `-`，或 PR 状态 `MERGED`）；②没有被任何 worktree 占用（`git branch -vv` 的 `+` 与 `git worktree list`）。两条都成立才删 |
| 已合并的分支要不要推远程 | **不需要**。内容在 `main` 里，远程再放一个同名 ref 只是重复指针。只有「未合并 + 别人/别的机器要取」才推；同一个 `.git` 下的 linked worktree 共享 refs，连推都不需要（[git-worktree](https://git-scm.com/docs/git-worktree)） |
| 备份用 branch、tag 还是都不要 | 已合并 → **都不要**（`main` 就是备份）。永不合并但要冻结 → **annotated tag**。还要继续写 → branch。本仓 `backup/main-2026-10-24` 与 lightweight tag `backup-main-2026-10-24` 指向同一个 commit，**没有增加任何保护**（实测两者都是 `7b5885a`） |
| 远程分支什么时候删 | 合并验证通过后**立刻**删；攒批只省几次网络操作，代价是 `git branch -r` 与 PR 列表长期带噪声。GitHub 侧可从已关闭 PR 恢复 head branch（[GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/deleting-and-restoring-branches-in-a-pull-request)） |
| 分支模型定成什么 | 一个长期分支 `main` + 五个有限命名空间：`ticket/matt<n>`（短命）、`feat/<slug>-<yyyy-mm-dd>`（临时集成线）、`research/<slug>-<yyyy-mm-dd>`（结论落盘即结束）、`prototype/<slug>-<yyyy-mm-dd>`（永不合并）、`wip/<owner>/<slug>`（本地、≤7 天）。见 §5 |
| 已有的 `branch-merged.mjs` 怎么用 | 它是**关票前**的检查，不是清理后的验收：删光 `ticket/*` 之后它必然红（canary 设计，`tools/branch-merged.mjs:122-132`）。而且它判 `HEAD` 不判 `main`（`tools/branch-merged.mjs:88`），当前主工作树 HEAD 是 `feat/matter-form-slim`，落后 `main` 一个提交 |

---

## 2. 现状盘点（2026-10-25 实测）

```
$ git branch -a -vv
  backup/main-2026-10-24                             7b5885a
* feat/matter-form-slim                              511aea6
  main                                               852577a [origin/main]
+ prototype/p5-p6-2026-10-11                         2fccf8b (F:/WorkSpace/MatterNest-prototype)
+ prototype/p9-p18-2026-10-17                        060e5f5 (F:/WorkSpace/mn-wt/matt66) [origin/prototype/p9-p18-2026-10-17]
  research/env-portability-2026-10-16                3a303df [origin/research/env-portability-2026-10-16]
```

`+` 的含义：该分支被某个 linked worktree 占用（[git-branch](https://git-scm.com/docs/git-branch)：checked out in linked worktrees 会标 `+`）。

| ref | tip | 与 `main` 的关系 | worktree | 远端 | 判定 |
|---|---|---|---|---|---|
| `main` | `852577a` | `= origin/main` | 无（主工作树在 `feat/matter-form-slim` 上） | 有 | 长期分支，不删 |
| `feat/matter-form-slim` | `511aea6` | 祖先，`--is-ancestor` 退出 **0** | **主工作树 HEAD** | 无 | 内容已在 `main`；可删，但删前必须先把主工作树切走 |
| `backup/main-2026-10-24` | `7b5885a` | 祖先，退出 **0** | 无 | 无 | 与 tag `backup-main-2026-10-24` 同点，冗余；可删 |
| `research/env-portability-2026-10-16` | `3a303df` | **非**祖先（退出 1），但 `git cherry main` 输出 `-` | 无 | 有（同 tip） | 内容以另一个提交（`852577a`，同名 message）等价落到 `main`；本地与远端都可删 |
| `prototype/p5-p6-2026-10-11` | `2fccf8b` | 非祖先（`+`） | `F:/WorkSpace/MatterNest-prototype` | 有，但**落后本地 44 个提交** | 本地是唯一完整副本；不删 |
| `prototype/p9-p18-2026-10-17` | `060e5f5` | 非祖先（`+`） | `F:/WorkSpace/mn-wt/matt66` | 有（同 tip） | 明确不进 `main`（提交信息原文），按留存判据处理，不参与常规清理 |

其它同时成立的事实：

- **已合并 PR 只有 1 个**（`gh pr list --state merged` → `#1 feat/visual-rebuild-2026-10-18 → main`，2026-10-24）。仓里实际有 **21 个 merge commit**（`git rev-list --count --merges main`），说明绝大多数集成本地完成，PR 不是主路径。
- **GitHub 仓库设置**：`deleteBranchOnMerge = false`、`rulesets = []`、`main` 无 branch protection（`gh repo view --json deleteBranchOnMerge`、`gh api .../rulesets`、`gh api .../branches/main/protection` 均实测）。所以「合并即删」目前完全靠人。
- **主工作树有 112 个未提交改动**（`git status --porcelain`）。这是清理动作真正的第一道阻塞：任何 `git switch main` 或 merge 都会先被它挡住——这正是 `tools/branch-merged.mjs:9-12` 记录的事故形态（merge 因未提交改动 abort，之后忘了重跑）。
- 远端只有 4 个 head：`main` + 上面 3 支非 `main` 分支（`git ls-remote --heads origin`）。

---

## 3. 清理分支的判据

### 3.1 先回答三个问题，再碰命令

1. **内容在哪？** 该分支的每个提交，是否已在集成分支里（祖先、补丁等价、或 PR 已合并）。
2. **谁在用？** 是否有 worktree 把它 checkout 着；删分支前必须先摘 worktree。
3. **删了谁会失去唯一副本？** 本地 tip 是否领先远端、是否没有任何 tag 指向它、提交是否只存在于这条分支。

三个问题的答案都可以机械取得，见 3.2。

### 3.2 机械判定阶梯

**第 0 步：列出分支与占用关系。**

```bash
git branch -vv          # + 号 = 被 linked worktree 占用；* = 当前工作树 HEAD
git worktree list       # 三列：路径 / HEAD / 分支
```

`git branch -vv` 的 `+` 与 worktree 路径都是官方输出的字段（[git-branch](https://git-scm.com/docs/git-branch)）。被占用的分支不能直接删：必须先 `git worktree remove`。该命令的文档明确：只有干净的工作树（无未跟踪文件、无已跟踪文件改动）能删，脏的或含 submodule 的要 `--force`，**主工作树不能删**（[git-worktree](https://git-scm.com/docs/git-worktree)）。

**第 1 步：祖先判定（真 merge 形态）。**

```bash
git merge-base --is-ancestor <branch> main; echo $?
# 0 = 是祖先（内容全在 main）；1 = 不是；其它非零 = 命令出错
# 上面是 bash。PowerShell 里 echo $? 不成立，看 $LASTEXITCODE。
```

官方语义原文：退出 0 表示真、1 表示假，**「错误」用非 1 的非零状态表示**（[git-merge-base](https://git-scm.com/docs/git-merge-base)）。所以脚本里不能把「非零」一律当「未合并」——`tools/branch-merged.mjs:94-98` 就是为此原样抛出异常。

`git branch --merged main` 是同一判据的列表形态；手册对它的用途写得很直白：`--merged` 用来找「可以安全删除」的分支，因为它们的 tip 完全被 `HEAD` 包含（[git-branch](https://git-scm.com/docs/git-branch)）。

```bash
git branch --merged main --format='%(refname:short)'
git branch --no-merged main --format='%(refname:short)'
```

**第 2 步：补丁等价判定（rebase / cherry-pick 形态）。**

```bash
git cherry -v main <branch>
# '-' = 上游已有等价补丁；'+' = 没有
```

等价性按去掉空白与行号后的 diff 判定，官方点名它能识别 `cherry-pick` / `am` / `rebase` 搬过去的提交（[git-cherry](https://git-scm.com/docs/git-cherry)）。

本仓有一个现成样本：`research/env-portability-2026-10-16` 的 `--is-ancestor` 退出 **1**，但 `git cherry -v main` 输出 **`-`**，`main` 上 `852577a` 的 message 与它逐字相同。⇒ **只看祖先会把它误判成「未合并」**。这也是 `tools/branch-merged.mjs` 的已知盲区（它只做祖先判定）。

**第 3 步：squash 是 git 侧的盲区，要回到 PR 状态。**

2026-10-25 在一个临时仓实测（不进本仓）：两条提交的分支 squash 进 `main` 后——

```
git merge-base --is-ancestor feat-one main   → 退出 1
git cherry main feat-one -v                  → 两条都是 '+'
git branch -d feat-one                       → error: the branch 'feat-one' is not fully merged
```

也就是说 **多条提交被 squash 成一条之后，git 的判据都证明不了内容已落地**：祖先不成立、单提交补丁也不等价（两条被压成一条）、`-d` 拒绝。本仓 GitHub 允许 squash（`gh repo view` 实测 `squashMergeAllowed: true`），所以这条必须写进流程：**若用 squash/rebase 合并，落地的唯一权威是 PR 的 `MERGED` 状态**：

```bash
gh pr view <n> --json state,mergedAt,headRefName,baseRefName
```

**第 4 步：删。**

```bash
git branch -d <branch>     # 安全删：不满足条件会拒绝
git branch -D <branch>     # 强制删：只有在第 1/2/3 步已给出「内容已落地」的证据后才用
```

`-d` 的官方判据：分支必须**完全并入它的 upstream**；**没有设 upstream 时，并入 `HEAD`** 即可（[git-branch](https://git-scm.com/docs/git-branch)）。这里有个坑，而且是**实测确认的坑**：分支只要推到过自己的同名远端，`origin/<同名分支>` 就是它的 upstream 且与本地同 tip，`-d` 会直接放行。2026-10-25 临时仓实测：`topic` 推到 `origin/topic` 后 `--is-ancestor topic main` 退出 1，`git branch -d topic` 仍以 **exit 0** 删除成功，只打了一行 warning「merged to 'refs/remotes/origin/topic', but not yet merged to HEAD」。⇒ **有 upstream 的分支，`-d` 不构成「已并入集成分支」的检查。** 本仓 `prototype/p9-p18-2026-10-17` 与 `research/env-portability-2026-10-16` 都是这种形态（upstream 与本地同 tip）。没有 upstream 的 `feat/matter-form-slim`、`backup/main-2026-10-24` 则判的是 `HEAD`——而 `HEAD` 未必是 `main`。**删除前一律显式跑一次 `git merge-base --is-ancestor <b> main`，不要只信 `-d`。**

> git 2.56 的手册里有 `git branch --delete-merged <pattern>`（按 upstream 批量删已合并分支，[git-branch](https://git-scm.com/docs/git-branch)）。**本机 2.51.0 实测不认识这个选项**（`error: unknown option 'delete-merged'`），所以本文的流程不依赖它。

### 3.3 删了会丢什么（按丢失顺序）

| 删掉的东西 | 是否立刻不可用 | 依据 |
|---|---|---|
| 分支 ref 本身 | 是 | 删除后 `<branch>@{n}` 这类表达式失效 |
| **该分支的 reflog** | 是 | 手册原文：分支若有 reflog，**reflog 也一并删除**（[git-branch](https://git-scm.com/docs/git-branch)） |
| 提交对象 | **否**，有宽限期 | `git gc` 保留被 refs、index、reflog 引用的对象；不可达对象按 `gc.pruneExpire` 默认 **2 周前**才清（[git-gc](https://git-scm.com/docs/git-gc)） |
| HEAD reflog 里的旧位置 | 否，默认留 90 天 | `gc.reflogExpire` 默认 90 天，`gc.reflogExpireUnreachable` 默认 30 天（[git-gc](https://git-scm.com/docs/git-gc)） |
| 分支名与提交顺序 | 是 | 兜底只能拿到裸对象，拿不回「这串提交属于哪条线」 |

兜底命令（只读）：

```bash
git fsck --lost-found --no-progress
# dangling commit → .git/lost-found/commit/；其它类型 → .git/lost-found/other/
```

官方语义：把 dangling 对象写进 `.git/lost-found/commit/` 或 `.git/lost-found/other/`（[git-fsck](https://git-scm.com/docs/git-fsck)）。本仓当前 `git fsck --dangling` 有 **143 行**输出，说明这套兜底确实能捡到东西；但它给不出分支名，也恢复不了 `git log` 的叙事。

真正不可逆的动作只有一个：

```bash
git gc --prune=now     # 关掉 2 周宽限期，立即清不可达对象
```

手册对它有明确警告：`--prune=now` 无视对象年龄、并发写仓时有损坏风险（[git-gc](https://git-scm.com/docs/git-gc)）。**不要在有未提交改动或未确认分支状态时跑它。**

### 3.4 branch / tag / 都不要：三种留存形态的判据

| 需求 | 用什么 | 判据 | 依据 |
|---|---|---|---|
| 内容已在 `main` | **都不要** | 第 1/2/3 步任一给出「已落地」 | `main` 的提交历史本身就是留存 |
| 永不合并，但已冻结、只需可读 | **annotated tag** | 不会再往里提交；需要日期/说明 | 轻量 tag 只是对象的名字；annotated tag 才是「发布用」的（[git-tag](https://git-scm.com/docs/git-tag)） |
| 永不合并，还要继续长 | **branch** | 还会追加提交 | 分支可以继续提交，tag 不行 |
| 只是「怕丢」 | **都不要** | 没有「已落地」证据时，先证明落地，而不是加副本 | 加副本不解决「票 Done 但代码不在集成分支」 |

tag 的两个操作性事实：

1. **`git push` 默认不推 tag**。`--tags` 的语义是「把 `refs/tags` 下所有 ref 都推上去」，反过来说明默认 refspec 不含 tag；`--follow-tags` 只推**annotated** 且从被推 ref 可达的 tag（[git-push](https://git-scm.com/docs/git-push)）。
2. **lightweight tag 不会随 `--follow-tags` 走**。所以「用 tag 做备份」必须显式 `git push origin <tag>`，或者打 annotated tag 再 `--follow-tags`。

本仓的现成反例：`backup/main-2026-10-24`（branch）与 `backup-main-2026-10-24`（lightweight tag）都指向 `7b5885a`，且 `7b5885a` 已是 `main` 的祖先。**两份 ref 指向同一个已在 main 的 commit，安全性增量为零**；删 branch 留 tag 只是保留一个日期锚点，删两者也不丢内容。

### 3.5 本仓逐支判定（结论，不执行）

| ref | 结论 | 前置条件 |
|---|---|---|
| `main` | 保留 | — |
| `feat/matter-form-slim` | 可删 | 先处理 112 个未提交改动 → `git switch main` → 再 `git branch -d` |
| `backup/main-2026-10-24` | 可删（tag 可留作日期锚点） | 无 |
| `research/env-portability-2026-10-16` | 本地可删、远端可删 | 已用 `git cherry` 证明等价落地；删远端用 `git push origin --delete` |
| `prototype/p5-p6-2026-10-11` | **不删** | 本地领先远端 44 个提交；先决定「推远端」还是「打 annotated tag 后删本地」 |
| `prototype/p9-p18-2026-10-17` | 不删（按留存判据） | 与远端同 tip；若裁定为冻结，可打 annotated tag 后删分支 |

**清完后的目标集合**：`main` + 两支 `prototype/*` = **3 支**；若 p5 先冻结成 annotated tag，则 2 支。这就是「稳定之后」的形状——不是 0 支，也不是把所有东西推一份到远程。

---

## 4. 远程分支怎么删

### 4.1 三个不同的「删」，别混

| 动作 | 命令 | 删的是什么 | 依据 |
|---|---|---|---|
| 删服务器上的分支 | `git push --dry-run origin --delete <branch>` → 去掉 `--dry-run` | 远端 `refs/heads/<branch>` | `--delete`：列出的 ref 全部从远端仓库删除（[git-push](https://git-scm.com/docs/git-push)） |
| 删本地的远程跟踪 ref | `git fetch --prune` 或 `git remote prune --dry-run origin` → `git remote prune origin` | 本地的 `refs/remotes/origin/*` | `--prune`：取回前先删掉远端已不存在的 remote-tracking ref（[git-fetch](https://git-scm.com/docs/git-fetch)）；`remote prune` 是同一件事但不 fetch（[git-remote](https://git-scm.com/docs/git-remote)） |
| 删本地分支 | `git branch -d <branch>` | 本地 `refs/heads/<branch>` | 见 §3.2 |

关键区别：**`git fetch --prune` 永远不会删服务器上的分支**，它只清本地那面镜子。`git branch -r -d` 也一样，手册专门提醒：删 remote-tracking 分支只在「远端已不存在」或「配置了不再 fetch」时才有意义，否则下次 fetch 又回来（[git-branch](https://git-scm.com/docs/git-branch)）。

### 4.2 合并即删 vs 攒一批

| 维度 | 合并即删 | 攒批 |
|---|---|---|
| 内容安全 | 相同——已合并的提交在 `main` 里 | 相同 |
| 误删风险 | 低：删除紧挨着「合并验证」这一步 | 高：几周后已记不清哪支并过，容易 `-D` 蒙 |
| 噪声 | `git branch -r` / PR 列表保持短 | 长期累积；本仓现在 3 支远程分支，其中 1 支（research）内容已在 main |
| 网络操作 | 每次合并一次 | 一次一批 |
| 恢复路径 | GitHub 可从已关闭 PR 恢复 head branch（[GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/deleting-and-restoring-branches-in-a-pull-request)） | 同上，但 PR 可能已被归档/遗忘 |

本仓的真实风险不在「删早了」，而在「**票 Done 了但分支从没并进集成分支**」——删除时机不改变这个风险，`tools/branch-merged.mjs` 才改变（见 §6）。因此：**合并验证通过就删，不需要攒；但删除必须发生在验证之后，而不是代替验证。**

不参与「合并即删」的三类：

1. `prototype/*` —— 明确不进 `main`，没有 PR，GitHub 的自动删除**不会被触发**（自动删除只作用于 PR 合并）。
2. `research/*` —— 未合并前不能删；合并/结论落盘后才删。
3. 被 worktree 占用或本地领先远端的分支 —— 先摘 worktree / 先推。

### 4.3 GitHub 侧：三个开关的现状与作用

| 设置 | 本仓现值 | 作用 | 依据 |
|---|---|---|---|
| Automatically delete head branches | **关**（`deleteBranchOnMerge=false`） | PR 合并后自动删 head branch；只对 PR 合并生效 | Settings → General → Pull Requests（[GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)） |
| Ruleset 的 Restrict deletions | **无 ruleset**（`[]`） | 默认勾选；勾上后只有 bypass 权限的人能删匹配分支 | [GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) |
| Branch protection 的 Allow deletions | **`main` 无 protection**（API 404） | 保护规则默认禁止删除匹配分支；`Allow deletions` 是放开项 | [GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) |

两条容易被忽略的交互：

- **保护规则会阻止「自动删除」生效**。GitHub 原文：branch protection rules and repository rules can also prevent branches being automatically deleted（同上自动删除页）。
- **自动删除对 fork 来的 PR 用的是 head 仓库（fork）的设置**，不是 base 仓库。本仓是单人直推 + 偶尔 PR，暂时碰不到，但写进约定避免以后踩。

`gh` 侧的等价动作：`gh pr merge <n> --delete-branch`，手册原文「Delete the local and remote branch after merge」（[gh pr merge](https://cli.github.com/manual/gh_pr_merge)）。注意它**同时删本地和远程**——如果本地还有未推提交，会先失败或留下本地分支，删前先看 `git status`。

---

## 5. 分支模型建议

### 5.1 有限命名空间

| 命名空间 | 用途 | 从哪开 | 生命周期 | 推远端 | 合并目标 | 删除时机 | 本仓实例（含历史） |
|---|---|---|---|---|---|---|---|
| `main` | 唯一长期集成分支 | — | 永久 | 是 | — | 不删 | `main` |
| `ticket/matt<n>` | 单票交付 | `main` 或当前 `feat` 线 | **≤ 2 天**（TBD 的短命判据） | 仅跨机协作时 | 有 `feat` 线 → `feat`；无 → `main` | 并入判据绿 + 票 Done 后立即 | `ticket/matt63`、`ticket/matt67`、`ticket/matt99`、`ticket/matt101`、`ticket/matt102` |
| `feat/<slug>-<yyyy-mm-dd>` | 多票共用的**临时**集成线 | `main` | 到收口条件满足；**> 2 周即视为第二个 trunk，必须拆** | 是（作为 PR head） | `main`（经 PR） | PR 合并后立即 | `feat/visual-rebuild-2026-10-18`（6 天，5 票）、`feat/matter-form-slim`、`feat/reports-recent-progress`、`feat/closeout-2026-10-18` |
| `research/<slug>-<yyyy-mm-dd>` | 调研；产物落 `docs/research-*.md` | `main` | 结论落盘即结束 | 仅需他人审阅时 | `main`（可只合文档） | 结论进 `main` 后立即 | `research/env-portability-2026-10-16` |
| `prototype/<slug>-<yyyy-mm-dd>` | 一次性原型，**明确不进 main** | `main` | 到裁定（进 ADR / 设计文档） | 是（产物就是给人看的） | **永不** | 裁定后：冻结 → annotated tag 再删分支；继续 → 保留 | `prototype/p5-p6-2026-10-11`、`prototype/p9-p18-2026-10-17` |
| `wip/<owner>/<slug>` | 未成形试验、临时 WIP | 任意 | **≤ 7 天**，不跨会话 | **否** | 不合并 | 到期即删；要留的提交先 `git cherry-pick` / `format-patch` 拾走 | 本仓暂无（新增约束） |
| tag `backup-<what>-<yyyy-mm-dd>` | 冻结锚点（不是分支） | — | 永久 | 按需显式推 | 不适用 | 按保留期清理 | `backup-main-2026-10-24` |

**为什么是这六个分支命名空间而不是更多**：命名空间的作用是让「这条分支的合同是什么」在名字里就能读出来。`ticket/*` 的合同是「必须并入」；`prototype/*` 的合同是「必须不并入」；`research/*` 的合同是「结论必须落盘」。三种合同互相冲突，所以不能共用一个前缀，否则门禁无法判断「红色是失败还是预期」。

> 「实例」列里，只有 `main`、`feat/matter-form-slim`、两支 `prototype/*`、`research/env-portability-2026-10-16` 现在还存在于本地；`ticket/*`、`feat/reports-recent-progress`、`feat/closeout-2026-10-18` 来自合并提交与 HEAD reflog（`git reflog` 实测），分支本身已删——这三条正是「合并即删」已经发生过的样本。

### 5.2 仓里已有的五类形态怎么映射

| 已有形态 | 映射到 | 本仓证据 |
|---|---|---|
| 长期集成分支 `main` | `main` | 唯一有 upstream（`origin/main`）的分支；CI 只在 `push`/`pull_request` 到 `main` 时跑（`.github/workflows/ci.yml:3-6`） |
| 按票 `ticket/matt63` | `ticket/matt<n>` | `tools/branch-merged.mjs` 默认 glob 就是 `ticket/*`；两起事故都发生在这个命名空间 |
| 按功能 `feat/visual-rebuild-2026-10-18` | `feat/<slug>-<yyyy-mm-dd>` | MATT-98…102 五张票的 `task.json` 都写着 `branch=feat/visual-rebuild-2026-10-18`、`base_branch=main` |
| 调研 `research/env-portability-2026-10-16` | `research/<slug>-<yyyy-mm-dd>` | 远端同名分支存在；结论已等价落到 `main` |
| 一次性原型 `prototype/p5-p6-2026-10-11` | `prototype/<slug>-<yyyy-mm-dd>` | 远端提交信息原文含「一次性产物，不进 main」 |
| 临时 WIP | `wip/<owner>/<slug>` | 仓里没有实例；这是补上的空位，不是对现状的描述 |

### 5.3 四条硬规则

1. **一个分支只属于一个命名空间。** 不建裸 `matt63`、`test`、`tmp`、`new`。名字里没有命名空间的分支，清理时无法判断合同。
2. **票分支必须登记。** `task.py set-branch <task> <branch>` 写分支名，`task.py set-base-branch <task> <branch>` 写 PR 目标（`.trellis/workflow.md:64-65`），PR 由 `task.py create-pr` 生成（`.trellis/workflow.md:73-74`）。未登记的票分支在关票时不会被 `branch-merged.mjs` 之外任何东西发现。
3. **`feat` 线开张时必须写收口条件**（哪几张票、什么验收、最晚哪天）。本仓 `feat/visual-rebuild-2026-10-18` 从分支名日期到 PR 合并是 6 天、跨 5 票；再长就会变成事实上的第二个 `main`，而两个 `main` 之间没有合并判据。
4. **`prototype` 的「不进 main」要写在提交信息或 PR 描述里**，不能只靠口头。本仓已有先例（远端 p5 的提交信息），这是可 grep 的证据。

---

## 6. 机械门禁：把 `branch-merged.mjs` 接进关票流程

### 6.1 它现在做什么

- 枚举：`git branch --list <glob> --format='%(refname:short)'`，不用 shell 通配（`tools/branch-merged.mjs:69-84`）。
- 判定：`git merge-base --is-ancestor <branch> HEAD`，退出 1 判未并入，其它非零原样抛错（`tools/branch-merged.mjs:86-99`）。
- canary：**匹配 0 个分支即失败**，不允许「通配符写歪」退化成静默通过（`tools/branch-merged.mjs:122-132`）。
- 只读、离线；用法 `node tools/branch-merged.mjs ['<glob>']`（`tools/branch-merged.mjs:41-47`），`pnpm branches:merged` 是它的别名（`package.json:30`）。

### 6.2 接进流程的三个时点

| 时点 | 命令 | 判据 |
|---|---|---|
| 开始合并前 | `pnpm branches:merged 'ticket/*'` | 列出所有还没并入的票分支；红是预期（还没合） |
| 合并动作之后（**尤其是 abort 之后**） | 同上 | 必须绿；红 = 有一票的代码不在当前 HEAD |
| 关票前 | 同上，把输出贴进票面 | 绿才允许把 Paca 票改成 Done |

第二行是 2026-10-17 两起事故的直接对应物：一次 merge 因主工作区有未提交改动 abort、之后忘了重跑；一次 `ticket/matt67` 整支没并、票已 Done，冒烟和单测都碰不到（`tools/branch-merged.mjs:6-15`、`docs/agents/issue-tracker.md:258-305`）。

⚠ **它的红不等于「必须合并」**。只对「合同是必须并入」的命名空间跑：`ticket/*`、`feat/*`、`research/*`。**不要**把 `prototype/*` 接进去——原型永远不合并，接进去就是把预期状态报成失败。

### 6.3 三个已实测的缺口

| 缺口 | 证据 | 规避方式 |
|---|---|---|
| **判 `HEAD`，不判 `main`** | `tools/branch-merged.mjs:88` 固定传 `HEAD`；当前主工作树 HEAD 是 `feat/matter-form-slim`（`511aea6`），而 `main` 是 `852577a` | 跑之前先 `git switch main`（但本仓有 112 个未提交改动，会先被挡）；或给脚本加显式集成分支参数（需改代码，不在本文范围） |
| **canary 与「清光分支」冲突** | 删完 `ticket/*` 后脚本必红（`:122-132`） | 把它当「关票前检查」，清理后的验收改用 `git branch --merged main` |
| **只认祖先，漏 squash** | 临时仓实测：squash 后 `--is-ancestor`=1、`git cherry` 全 `+`、`-d` 拒绝 | squash 场景以 `gh pr view <n> --json state` 为准；`research/*` 用 `git cherry` 补判 |

它**刻意不进 `pnpm verify`**：CI 的 `actions/checkout` 默认只拉一个 ref、depth=1，那种工作区里 `ticket/*` 匹配 0 支，canary 会把每次 CI 判红（`docs/agents/issue-tracker.md:291-296`）。这条区分要保留：**判据越依赖「本地那棵工作树」，越不该挂 CI。**

### 6.4 清理阶段该跑的只读命令（不需要改脚本）

```bash
git branch --merged main --format='%(refname:short)'      # 可安全删的
git branch --no-merged main --format='%(refname:short)'    # 需要逐支判定的
git branch -vv                                             # 谁被 worktree 占用
git worktree list                                          # 三个工作树的路径与 HEAD
```

---

## 7. 命令清单（git 2.51 实测存在）

> 片段按 bash 写；PowerShell 下 `$?` 要换成 `$LASTEXITCODE`，`;` 连接仍然可用。

| # | 目的 | 命令 | 出处 / 备注 |
|---|---|---|---|
| 1 | 盘点本地分支 + worktree 占用 + upstream | `git branch -vv` | [git-branch](https://git-scm.com/docs/git-branch)；`+` = linked worktree |
| 2 | 盘点 worktree（脚本友好） | `git worktree list --porcelain` | [git-worktree](https://git-scm.com/docs/git-worktree) |
| 3 | 判「已并入 main」 | `git merge-base --is-ancestor <branch> main; echo $?` | 0/1/其它非零，[git-merge-base](https://git-scm.com/docs/git-merge-base) |
| 4 | 列可安全删的分支 | `git branch --merged main --format='%(refname:short)'` | [git-branch](https://git-scm.com/docs/git-branch)（`--merged` 的用途即此） |
| 5 | 列未合并分支 | `git branch --no-merged main --format='%(refname:short)'` | 同上 |
| 6 | 判「补丁已等价落地」 | `git cherry -v main <branch>` | `-` 已等价、`+` 未落地，[git-cherry](https://git-scm.com/docs/git-cherry) |
| 7 | 安全删本地分支 | `git branch -d <branch>` | 判 upstream 或 HEAD，[git-branch](https://git-scm.com/docs/git-branch) |
| 8 | 强制删（已证等价后） | `git branch -D <branch>` | 同上；仅在 3/6/PR 状态给出证据后 |
| 9 | 摘 worktree | `git worktree remove <path>` | 只删干净工作树；`--force` 用于脏树/含 submodule；主工作树不可删（[git-worktree](https://git-scm.com/docs/git-worktree)） |
| 10 | 清孤儿 worktree 记录 | `git worktree prune -n` → `git worktree prune` | 默认宽限 `gc.worktreePruneExpire` 3 个月（[git-gc](https://git-scm.com/docs/git-gc)） |
| 11 | 预演删远程分支 | `git push --dry-run origin --delete <branch>` | [git-push](https://git-scm.com/docs/git-push) |
| 12 | 删远程分支 | `git push origin --delete <branch>` | `--delete`：列出的 ref 从远端删除，同上 |
| 13 | 清本地已失效的远程跟踪 ref | `git fetch --prune` 或 `git remote prune origin` | 只清本地镜像，[git-fetch](https://git-scm.com/docs/git-fetch)、[git-remote](https://git-scm.com/docs/git-remote) |
| 14 | 打冻结 tag | `git tag -a backup-<what>-<yyyy-mm-dd> -m "<说明>" <commit>` | annotated tag 才随 `--follow-tags` 走，[git-tag](https://git-scm.com/docs/git-tag)、[git-push](https://git-scm.com/docs/git-push) |
| 15 | 推 tag | `git push origin <tag>` | 默认 `git push` 不带 tag，同上 |
| 16 | 捞回已删分支的提交 | `git fsck --lost-found --no-progress` | 输出到 `.git/lost-found/commit/`，[git-fsck](https://git-scm.com/docs/git-fsck) |
| 17 | 确认 PR 是否已合并 | `gh pr view <n> --json state,mergedAt,headRefName,baseRefName` | 已在本仓 PR #1 上实测 |
| 18 | 看仓库是否自动删 head branch | `gh repo view PhinnPeng/MatterNest --json deleteBranchOnMerge` | 实测 `false` |

> 第 7 行 `-d` 的 upstream 陷阱见 §3.2：upstream 指向 `origin/<同名分支>` 时，`-d` 可能放行「只并入了同名远程分支、没并入 main」的分支。**先用第 3 行判一次 `main`。**

---

## 8. 来源

### 8.1 git 官方手册（命令存在性均在本机 2.51.0 用 `git <cmd> -h` 复核）

- [git-branch](https://git-scm.com/docs/git-branch)：`-d` 的 upstream/HEAD 判据、`-D` 语义、删除分支连带删 reflog、`--merged` 的「可安全删除」用途、`+` 标记 linked worktree、删除 remote-tracking 分支的注意事项。2.56 新增的 `--delete-merged` 在 2.51 实测不存在。
- [git-merge-base](https://git-scm.com/docs/git-merge-base)：`--is-ancestor` 的 0/1/其它非零语义。
- [git-cherry](https://git-scm.com/docs/git-cherry)：`-`/`+` 的含义、按 diff 判等价、可识别 cherry-pick/am/rebase。
- [git-fetch](https://git-scm.com/docs/git-fetch)：`--prune` 删除远端已不存在的 remote-tracking ref；`--dry-run`。
- [git-remote](https://git-scm.com/docs/git-remote)：`prune` 的语义、与 `fetch --prune` 等价、`--dry-run`。
- [git-worktree](https://git-scm.com/docs/git-worktree)：`remove` 只删干净工作树、`--force` 条件、主工作树不可删、`prune`、多个 worktree 共享同一仓库（per-worktree 文件除外）。
- [git-push](https://git-scm.com/docs/git-push)：`--delete`、`--dry-run`、`--tags` 与 `--follow-tags` 的差别（后者只带 annotated 且可达的 tag）。
- [git-gc](https://git-scm.com/docs/git-gc)：`gc.pruneExpire` 默认 2 周、`gc.reflogExpire` 90 天、`gc.reflogExpireUnreachable` 30 天、`gc.worktreePruneExpire` 3 个月、`--prune=now` 的风险警告。
- [git-fsck](https://git-scm.com/docs/git-fsck)：`--lost-found` 写入 `.git/lost-found/commit|other`、`--no-reflogs` 的用途。
- [git-tag](https://git-scm.com/docs/git-tag)：lightweight vs annotated 的定位。

### 8.2 外部方法论

- [Trunk Based Development · Short-Lived Feature Branches](https://trunkbaseddevelopment.com/short-lived-feature-branches/)：分支只该活「一两天」；一个分支一个开发者（含其 agents）；合并后删分支、删 worktree；`git worktree list` 用来发现被遗忘的工作树。

### 8.3 GitHub 官方

- [Managing the automatic deletion of branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)：Settings → General → Pull Requests；保护规则可阻止自动删除；fork 场景用 head 仓库设置。
- [Deleting and restoring branches in a pull request](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/deleting-and-restoring-branches-in-a-pull-request)：只能删已合并/已关闭 PR 的分支；可 restore head branch。
- [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)：默认禁止删除匹配分支，`Allow deletions` 是放开项。
- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)：`Restrict deletions` 默认勾选。

### 8.4 仓内文件

- `tools/branch-merged.mjs`：头注记录的两起事故（`:6-15`）、只读/离线与用法（`:41-47`）、HEAD 判定（`:88`）、canary（`:122-132`）。
- `docs/agents/issue-tracker.md`：多分支施工一节（`:258-305`）、`pnpm branches:merged` 与「不进 verify」的理由（`:288-296`）。
- `.trellis/workflow.md`：`set-branch` / `set-base-branch`（`:64-65`）、`create-pr`（`:73-74`）。
- `.github/workflows/ci.yml`：CI 只在 `main` 的 push/PR 触发（`:3-6`）。
- `package.json`：`branches:merged` 脚本（`:30`）。
- `docs/retro-2026-10-17.md`：候选 2 的坏守卫与修法（`:54-72`）。
- `docs/retro-2026-10-18.md`：`git fsck` 捞回不可达 blob 的先例（候选 2）。

### 8.5 本次实测（可复现）

```bash
git --version                                     # 2.51.0.windows.1
git branch --merged main --format='%(refname:short)'
git branch --no-merged main --format='%(refname:short)'
git merge-base --is-ancestor research/env-portability-2026-10-16 main; echo $?   # 1
git cherry -v main research/env-portability-2026-10-16                          # '-'
git rev-list --left-right --count prototype/p5-p6-2026-10-11...origin/prototype/p5-p6-2026-10-11  # 44 0
(git fsck --no-progress --dangling | Measure-Object -Line).Lines   # 143（PowerShell）
gh repo view PhinnPeng/MatterNest --json deleteBranchOnMerge,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
gh api repos/PhinnPeng/MatterNest/rulesets         # []
gh api repos/PhinnPeng/MatterNest/branches/main/protection   # 404 Branch not protected
gh pr list --state merged                          # 仅 #1
git branch --delete-merged origin/main --dry-run   # 2.51 实测：unknown option

# 临时仓（不进本仓）两个形态实验：
# 1) 两条提交 squash 进 main → is-ancestor=1 / cherry 全 '+' / branch -d 拒绝
# 2) topic 推到 origin/topic → is-ancestor topic main=1，但 branch -d 仍 exit 0
#    （只打 warning: merged to 'refs/remotes/origin/topic', but not yet merged to HEAD）
```

---

## 9. 这份文档没能回答 / 需要你拍板

- **`ticket/*` 到底并入 `main` 还是并入 `feat` 线**：两种都真实发生过（MATT-99/101/102 → `feat/visual-rebuild`；MATT-63/67 → 直接 `main`）。这条决定 `branch-merged.mjs` 该拿谁当判据，也决定 `set-base-branch` 填什么；本文只给了「有 feat 线就进 feat」的默认值。
- **`prototype/p5` 那 44 个本地领先提交怎么处置**：推远端、打 annotated tag、还是接受只存在于本机 `.git`。这是唯一一支「删了真的会丢」的分支，而它是否还有价值只有你知道。
- **`main` 要不要开 ruleset / branch protection**：现在 `deleteBranchOnMerge=false`、`rulesets=[]`、`main` 无 protection，三者都是实测。一旦开 PR 常态，需要同时定 required checks 用哪几个（CI 目前只有 `verify` 一个 job）。
- **`wip` 的 7 天上限与 `feat` 的 2 周收口线**：TBD 只给「短命分支一两天」，这两个数字是本仓自定的，没有一手依据；需要按实际节奏校准。
- **是否给 `branch-merged.mjs` 加显式集成分支参数**：改代码不在本文范围。在此之前，跑它之前必须人在 `main` 所在的 HEAD 上，否则判的是别的分支（本仓当前正踩在这个状态上）。

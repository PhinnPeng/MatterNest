# 分支

> 触发：开分支、合并、删分支、清理分支、开树、收树。
> 判据的出处与实测证据在 `docs/research-branch-strategy-2026-10-25.md` 与 `docs/research-ai-era-branching-2026-10-25.md`，本文只写合同与命令。

## 开分支

按「这条线的合同」挑命名空间，分支名以命名空间开头。

| 命名空间                       | 合同                                | 从哪开          | 合并目标                     | 到期                             |
| ------------------------------ | ----------------------------------- | --------------- | ---------------------------- | -------------------------------- |
| `ticket/matt<n>`               | 必须落地                            | `main` 或 feat  | 有 feat 线进 feat，否则 main | 票 Done 后立刻删                 |
| `feat/<slug>-<yyyy-mm-dd>`     | 多票共用的临时集成线，必须落地      | `main`          | `main`（经 PR）              | 2 天是寿命上限，2 周是拆分期限   |
| `research/<slug>-<yyyy-mm-dd>` | 结论必须落盘到 `docs/research-*.md` | `main`          | `main`（可只合文档）         | 结论进 main 后立刻删             |
| `prototype/<slug>-<yyyy-mm-dd>` | 永不落地                            | `main`          | 不合并                       | 裁定后冻结成 tag 并删分支        |
| `wip/<slug>`                   | 不合并、不推远端                    | 任意            | 不合并                       | 2 天内删；要留的提交先拾走       |

一个分支只属于一行，一棵 worktree 只属于一个会话。名字里没有命名空间的线（`test`、`tmp`、`new`）不建：删它的时候没人能读出合同。

**完成判据**：分支名能在上表唯一落到一行；落在 `ticket/*` 的，`python ./.trellis/scripts/task.py set-branch` 与 `set-base-branch` 都已写好——未登记的票分支在关票时不会被任何门禁发现。

`feat` 线开张时把收口条件写进票面或 PR 描述：哪几张票、什么验收、最晚哪天。写不出这三项，说明它其实是几条独立的 `ticket/*`。

## 工作树

非主树一律放 `F:/WorkSpace/mn-wt/`，目录名是分支名把 `/` 换成 `-`（`feat-matter-form-slim`）；主树 `F:/WorkSpace/MatterNest` 是唯一例外。

| 项         | 规则                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| 一树一会话 | 同一棵树上只有一个会话在写；开工前 `git worktree list`                            |
| 基数       | 从 `main` 开；落地前 `git merge-base --is-ancestor main <branch>` 必须退出 0      |
| 回收四条   | ①分支已落地或已删 ②树干净 ③无活会话 ④不是主树，四条同时成立才回收                 |

回收前逐条取证：

```bash
git for-each-ref --format='%(refname:short) %(worktreepath)' refs/heads   # 分支 → 树
git -C <wt> status --porcelain      # 空 = 干净；有输出就得 --force
git -C <wt> log -1 --format=%cI     # 最后一次提交；距今多久
git worktree remove <wt>            # 只删树，分支还在
git worktree prune -n               # 目录被手工删掉后，清管理记录
```

目录名与分支名对不上时用 `git worktree move <wt> F:/WorkSpace/mn-wt/<分支名>` 归位，内容不动。

回收的是树，不是分支：`prototype/*` 永不落地，按合同不参与常规清理，只在裁定后冻结。

## 合并

`main` 是唯一集成分支，CI 只在此触发（`.github/workflows/ci.yml`）。合并在本地完成后，立刻跑一次关票守卫：

```bash
pnpm branches:merged          # = node tools/branch-merged.mjs，默认 glob 为 ticket/*
```

它判的是当前 `HEAD`，不是 `main`。多 worktree 之后 `HEAD` 是复数，跑之前先确认当前这棵树就在 `main` 上：

```bash
git rev-parse --abbrev-ref HEAD   # 必须是 main
```

合并之后回到主树的 `main` 重跑门禁：

```bash
git switch main
pnpm verify
```

分支上那次绿不算数：GitHub 对 required status checks 的 loose 模式明文承认「合并到 base 之后可能失败」（`docs/research-ai-era-branching-2026-10-25.md` §3.4）；而 `.githooks/pre-commit:34` 让 worktree 的提交跑的是**主树**的 verify。两处指向同一件事——判定的位置在主树的 `main`。

`pnpm smoke`（要真库、要 `.env`）只在主树跑：worktree 里只有 git 跟踪的文件，缺 fixture 的测试会静默跳过，出来的是假绿。

## 删分支

四问，每问都有机械判据。四问同时成立才删。

**1. 内容落地。** 按合并形态选判据：

```bash
git merge-base --is-ancestor <branch> main; echo $LASTEXITCODE   # 0 = 已落地
git cherry -v main <branch>                                      # 全 '-' = 已等价落地（cherry-pick / rebase）
gh pr view <n> --json state                                      # "MERGED" = squash 合并的唯一权威
```

squash 过的分支在 git 侧三条判据全部失效（祖先不成立、补丁不等价、`-d` 也会拒绝），只能看 PR 状态。

`git branch -d` 不是判据：分支有同名 upstream 时，它只证明「并入了远端同名分支」，会把没进 `main` 的分支放行。先用上面三条证明落地，再删。

**2. 没人 checkout。**

```bash
git branch -vv        # 带 '+' 的分支被某个 worktree checkout 着
git worktree list     # 路径 / HEAD / 分支
```

被占用的先 `git worktree remove <path>`；脏工作树要 `--force`，主工作树不可删。

**3. 没有活会话在写。** checkout 只证明这棵树开着，不证明没人在改：

```bash
git -C <wt> log -1 --format=%cI        # 最后一次提交
```

再对一个工作文件取两次 `LastWriteTime`，间隔 15 秒；时间在走就是有人在写，先把会话停掉或换个分支。

**4. 不丢唯一副本。**

```bash
git rev-list --left-right --count <branch>...origin/<branch>   # 形如 '0 0' 才没有本地领先提交
```

输出非 `0 0` 且没有 tag 指向它，就先推远端或打 annotated tag，再删。

**完成判据**：`git branch --no-merged main` 里只剩合同允许未落地的分支（`prototype/*`、`wip/*`）；被删分支的 worktree 已按「工作树」节的四条回收；关票前 `pnpm branches:merged` 仍为绿。

## 远端

- 已落地的分支不在远端留同名 ref：内容在 `main` 里，远端再放一个是重复指针。
- 需跨机器取用的未落地分支才推；同一 `.git` 下的 linked worktree 共享 refs，不需要推。
- 远端分支在合并验证通过后立刻删，攒批只是把「哪支并过」的记忆往后拖：

```bash
git push --dry-run origin --delete <branch>
git push origin --delete <branch>
git fetch --prune        # 只清本地的远程跟踪 ref，不碰服务器
```

- `prototype/*` 例外，它要推远端——产物就是给人看的。
- 冻结用 annotated tag，轻量 tag 不随 `--follow-tags` 走，且 `git push` 默认不带 tag：

```bash
git tag -a backup-<what>-<yyyy-mm-dd> -m "<说明>" <commit>
git push origin backup-<what>-<yyyy-mm-dd>
```

## 门禁边界

`pnpm branches:merged` 只接合同为「必须落地」的命名空间（`ticket/*`、`feat/*`、`research/*`）。`prototype/*` 跳过：它不合并，红是预期状态。

它刻意不在 `pnpm verify` 链上：CI 的 `actions/checkout` 默认只取一个提交（`fetch-depth: 1`），那种工作区里 `ticket/*` 匹配 0 支，canary 会把每次 CI 判红。判据越依赖「本地那棵工作树」，越不该挂 CI。

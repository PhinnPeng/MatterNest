# MATT-92 门禁钩子泄漏 GIT_DIR：临时仓夹具把 init/config/commit 打到真仓上

## Goal

让 `pre-commit` 钩子在跑 `pnpm verify` 之前**不携带任何「指向某个仓」的环境变量**，并把门禁对象切到**当前工作树**；让 `tools/board-drift.spec.ts` 的临时仓夹具在环境不对时**当场红**，而不是静默去写别人的仓。

## Requirements

- 现象与证据见 Paca 票 MATT-92（本文不重复，票面是判据的出处）。
- 修复必须落在**泄漏的源头**，而不是在下游加补丁：
  - 源头一：`.githooks/pre-commit` 把 git 泄漏给钩子的定位变量（linked worktree 提交会注入 `GIT_DIR` / `GIT_INDEX_FILE`）原样传给了 verify。
  - 源头二：`tools/board-drift.spec.ts` 的夹具继承 `process.env`，且**没有任何断言**可以发现自己建的不是临时仓。
- 不许引入新依赖；`pnpm verify` 七道必须全绿。

## Acceptance Criteria

- [ ] `.githooks/pre-commit` 在 `pnpm verify` 之前 `unset` 掉定位类变量（`GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` / `GIT_COMMON_DIR` / `GIT_PREFIX` / `GIT_CEILING_DIRECTORIES` / `GIT_DISCOVERY_ACROSS_FILESYSTEM` / `GIT_CONFIG_*`）。
- [ ] `.githooks/pre-commit` 保留 `dirname $0/../..` 不动（**本票明确不改**）：它让 worktree 提交去门禁主树，是上面那个循环的入口，但改它 = 改别人（原型 worktree）的提交流程 —— 那棵树没有 `node_modules`，改完他们的提交会当场失败。属「要先问人」，已记入 MATT-92 票面。
- [ ] `tools/board-drift.spec.ts` 在 `beforeAll` 里清掉进程环境里的 `GIT_*`。
- [ ] `repo()` 有**两道守卫**：任何 git 命令之前先拒定位变量；`git init` 之后再断言 `rev-parse --absolute-git-dir` 就是刚建的临时仓。
- [ ] 反向红：`GIT_DIR` 指向替身仓时夹具当场拒绝，且**替身仓一个字节没动**（本票新加的用例钉住它）。
- [ ] 主仓恢复：`core.bare` 摘掉、身份回 `phinnpeng <phinnpeng@outlook.com>`（已办，记入票面评论）。

## Notes

- **已知缺口（记账、不在本票范围）**：这道修复没有对应的自动化用例来钉钩子那份 sh 脚本 —— 本仓没有「跑 sh 钩子 + 替掉 pnpm」的地基，硬做会在测试里真跑一次 `pnpm verify`。钩子的修复由**每次提交实际执行**来承担回归，票面已写明。
- 更早的两个受害者不重写历史（`8942797`、`f4c4556` 作者是 `t <t@example.com>`，未推送，由人决定是否 rewrite）。

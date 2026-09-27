# lint-guard

`check.mjs` 是**对 lint 规则本身的测试**。四道断言（A 匹配到文件 / B 违规被拦 / C 合法不误伤 / D 规则确实挂在 `src/shared/` 上），任一失败 exit 1，由 `pnpm verify` 兜住。

为什么要有：`eslint.config.mjs` 里写了一条规则 ≠ 它会触发。glob 打错、`files` 段写错目录、被后面的 config 覆盖，都会让规则静默失效而 CI 全绿——本项目已经因为"自证脚本覆盖面不足"翻过一次车，所以规则也要有回归。

## 待挂进来的第二条（W2-1）

**禁裸 `select()`**（技术选型 §4「ScopeResolver + 禁止裸表访问」行）。本票**故意不实现**：仓储基类还不存在，现在写规则等于对空气执法，而且会把 W0-4 的合法迁移脚本一起误伤。

W2-1 落地时的挂法：对 `src/app/lib/server/db/**` 之外的路径，禁止从 `drizzle-orm` import `select`；例外清单写进 `eslint.config.mjs` 的注释里，逐条给理由。

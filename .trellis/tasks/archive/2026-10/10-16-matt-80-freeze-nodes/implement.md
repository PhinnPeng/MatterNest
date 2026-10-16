# MATT-80 实施计划

> 轻量改动（两个函数各加一道门 + 一组源码断言翻转），不写 `design.md`：技术设计就是「与既有三道逐字同形」，无新契约、无迁移、无跨层新增。下面是有序清单、验证命令与回滚点。

## 有序清单

1. **先反向红一次（TDD 的红）**
   - 在 `src/app/lib/server/services/risks.ts` 的 `addRiskNode` / `setRiskNodeStatus` 里各加一道门：
     `if (isRiskFrozen(<变量>.conversionStatus)) return { ok: false, why: "frozen" };`
   - 同时把两处都**短路**成 `if (false && isRiskFrozen(...))`，验证「门被摘掉时断言会红」这件事本身仍然成立（这是 `risks.spec.ts:288-289` 那条注释记下的坑的回归守卫）。
   - 此时断言应按下面的口径翻成 5 条 / 5 个函数名，并且**红**。记录红点（哪条 it、红在哪一行）。

2. **同步翻断言** `src/app/lib/server/services/risks.spec.ts`
   - `:287` 「恰好三条活门」→ 五条：`expect(gates.map(m => m[1])).toEqual([...])` 期望数组变成 5 个变量名（新增两条各自的入参变量名）。**比对形态不变**：仍是完整正则 `if (…isRiskFrozen(…)…) return { … why: "frozen" }`，不是 `body.includes("isRiskFrozen(")`。
   - `:302` 「三条路径都先问」→ 五条：`guarded` 集合期望加上 `addRiskNode` / `setRiskNodeStatus`（排序后）。
   - `:310` 那条负向断言：把 `addRiskNode` / `setRiskNodeStatus` 从 `mustStayOpen` 清单里**移出**（其余保留：评论 / 关注人 / 软删 / 当事人 / 批量标签 —— 那些是 ADR 0005 的刻意豁免或别票范围）。
   - 更新 `:228-239` 与 `:266` 的 describe / 注释里「三条写路径」这类措辞，使它与五条一致（别让注释和断言打架）。
   - 顺手更新 `services/risks.ts:98` `RISK_FROZEN_MESSAGE` 的注释「三个路由共用」—— 若本票未动路由，此处**不动**（见「不做的事」）。

3. **补回真门**（去掉 `false &&`），使上一步的断言转绿。

4. **本票边界**：不碰 `src/app/api/**`（路由拒绝文案归别的票）；不碰评论 / 关注人 / 标签 / 当事人 / 软删路径。

5. **全量验证**：`pnpm verify`（format / lint / typecheck / 测试 / lint-guard / anchors / deploy:check）。
   - 若 `tools/board-drift.spec.ts` 报 `invalid object … for '.agents/skills/…'` + `Error building trees`：环境瞬时问题，**重跑一次**；连红两次则把原文报回主会话。

## 验证命令

```bash
pnpm test -- risks.spec          # 单文件先跑，快
pnpm verify                      # 全量门禁
```

反向红的执行方式（第 1 步）：把两道门临时改成 `if (false && isRiskFrozen(...))`，跑 `pnpm test -- risks.spec`，确认「恰好五条活门」与「五条路径都先问」两条断言变红（`false &&` 短路后正则不再匹配完整形态，负向断言则会因为函数体仍含 `isRiskFrozen(` 而**继续绿** —— 这正是要保住强度的那条坑）。

## 回滚点

- **R1**：第 1 步之前 = 干净工作区。任何一步出错，`git checkout -- src/app/lib/server/services/risks.ts src/app/lib/server/services/risks.spec.ts` 即回到起点（**本票的改动只在这两个文件**）。
- **R2**：只留服务层两道门、暂不翻断言 → 会出现「实现已锁、断言仍说没锁」的红。这是中间态，不允许提交。

## 执行结果（2026-10-16 实施）

- 反向红：`addRiskNode` / `setRiskNodeStatus` 两道门临时写成 `if (false && isRiskFrozen(...))`，`pnpm test -- risks.spec` 红在
  `src/app/lib/server/services/risks.spec.ts:299` ——
  `五条写路径上少了一道活门，或门被短路了: expected [ 'src', 'cur', 'cur' ] to deeply equal [ 'src', 'cur', 'cur', 'vis', 'node' ]`。
  同时可见「状态流转 /…五条路径都先问 isRiskFrozen」那条**仍然绿**（函数体里还留着 `isRiskFrozen(` 文本）——
  这正是 `:288-289` 注释记下的坑：**只有比对完整门形态的那条断言挡得住**。
- 转绿：去掉两处 `false &&` 后 `pnpm test -- risks.spec` 35 passed。
- 全量：`pnpm verify` 退出码 0（37 test files / 520 tests，lint-guard / anchors 89 条 / deploy:check 全过）。

## 不做的事（原来的边界）

- 路由层 `why: "frozen"` → 422 的映射与文案：`nodes/route.ts` 的 POST 兜底目前回 403「归档是终态，或你不是这条事项的经办人」、PATCH 兜底回 422「目标状态与当前状态相同」。**票面只裁了服务层的门，路由文案不在本票范围**（与 `unconvert/route.ts` 同属文案票）。留给主会话裁决。
- 当事人 / 软删（MATT-81 / MATT-82）、评论 / 关注人 / 标签 / 追加转案件（ADR 0005 刻意豁免）。

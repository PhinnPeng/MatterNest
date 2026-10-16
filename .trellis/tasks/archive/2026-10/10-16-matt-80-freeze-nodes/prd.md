# MATT-80 冻结后节点全锁：addRiskNode / setRiskNodeStatus 补 isRiskFrozen 门

> Paca 票号 80（MATT-80）。裁定来源：MATT-89（2026-10-16），实现口径见 `docs/adr/0005-freeze-covers-business-facts.md`。

## Goal

事项转过案件即冻结（`conversion_status = 1`，判据 `isRiskFrozen`）。冻结目前已覆盖**改状态 / 改业务字段 / 撤销转案件**三条写路径，但**节点不在冻结范围内**：`addRiskNode` 与 `setRiskNodeStatus` 今天只拒 `archived` 与归属不符，不拒冻结。于是：

- 一条已移交案件的事项，在事项侧仍可**新增节点**（举证期 / 开庭日 / 答复期这类硬期限）；
- 已存在的节点仍可在事项侧被**改状态**（完成 / 取消 / 改确认位）。

票面判断：这是三张遗留票里唯一「**无人察觉即造成损害**」的形态 —— 期限的真实推进已在案件侧，事项侧悄悄改一条没人会发现。本票把这两条路径锁上与既有三道同形的冻结门。

## 裁定原文（2026-10-16，MATT-89 会话定）

> **裁定 = (a) 完全锁住**。冻结的事项，节点新增与状态变更都拒：给 addRiskNode（services/risks.ts:1483）/ setRiskNodeStatus（:1562）补 isRiskFrozen 门，与现有三道同形（:1115 改状态 / :1251 改字段 / :731 撤销）。硬期限要紧急调整 → 去**案件**侧改，不在事项台账改（依「事项是台账、案件是战场」）。
> 施工时同步翻 risks.spec.ts:315-338 里「节点路径不含 isRiskFrozen」那组断言，**先反向红一次**。

## Requirements

1. `addRiskNode`（`src/app/lib/server/services/risks.ts`）：事项冻结时拒绝新增节点，返回值带可读的原因，而非笼统的归属失败。
2. `setRiskNodeStatus`（同文件）：事项冻结时拒绝节点状态 / 时间确认位变更，同上。
3. 两道门的**形态与既有三道逐字同形**：`if (isRiskFrozen(<变量>.conversionStatus)) return { ok: false, why: "frozen" };`，且必须排在归属判定之前（冻结是记录自身的属性，与「你是不是经办人」无关）。
4. 判据仍然**只有一处**：`conversion_status === 1` 这个比较在 `services/risks.ts` 里只出现一次（不新增第二个事实源）。
5. `risks.spec.ts` 里看守「冻结门覆盖面」的源码断言同步翻转，并保持强度（见验收判据第 4 条）。
6. 本票**不**动：评论 / 关注人 / 追加转案件 / 标签这些**刻意豁免**的路径（ADR 0005）；也不动当事人与软删（MATT-81 / MATT-82）；也不动 `unconvert/route.ts` 的拒绝文案（另一张票）。

## Acceptance Criteria

- [ ] 冻结事项上新增节点被拒，返回 `why: "frozen"`；未冻结、未归档、且归属允许的事项上新增节点**照旧成功**。
- [ ] 冻结事项上改节点状态（`completed` / `cancelled` / `pending` / `confirm_time`）一律被拒，返回 `why: "frozen"`；未冻结事项照旧成功。
- [ ] 两道门排在该函数内既有的 `archived` / 归属判定**之前**，写法与 `changeRiskStatus` / `updateRiskMatter` / `unconvertFromCase` 三道逐字同形。
- [ ] `risks.spec.ts` 的三条覆盖面断言同步更新且**强度不降**：
  - 「恰好 N 处活的冻结门」计数 3 → 5，且比对的是**完整门形态**（`if (...isRiskFrozen(...)) return { ... why: "frozen" }`），不是「函数体里出现过 `isRiskFrozen(`」；
  - 「N 条路径都先问 isRiskFrozen」的函数名集合变成 5 个；
  - 原先把 `addRiskNode` / `setRiskNodeStatus` 列进「必须保持开放」的那条负向断言，把这两条**移出**清单。
- [ ] **反向红证据**：把新补的两道门各自短路（`if (false && ...)`）时，对应断言必须变红；红完补回，全绿。
- [ ] `pnpm verify` 全绿（format / lint / typecheck / 测试 / lint-guard / anchors / deploy:check）。

## Notes

- 语言：中文（backend spec 语言裁定）。
- 判据 `isRiskFrozen` 只写一处是既有契约，别把 `conversion_status === 1` 抄进新门。
- 「未冻结照旧成功」这条不能只靠读代码确认 —— 反转红时两道门要真的是**唯一**多出来的拒绝分支。

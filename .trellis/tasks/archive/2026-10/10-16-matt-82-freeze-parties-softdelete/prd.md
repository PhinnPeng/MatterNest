# MATT-82 冻结后：当事人与软删补门、标签写成刻意豁免

## Goal

按 MATT-89 于 2026-10-16 的裁定（ADR-0005 的 Consequences 第 1 条），把「冻结覆盖业务事实」
这条线在事项侧补完：**当事人（加/摘）与软删补 `isRiskFrozen` 门**，**批量加标签保持放行但把
「刻意豁免」写进代码并被断言钉住**。评论 / 关注人 / 追加转案件不动。

## Requirements

### R1 冻结语义（不改）

「冻结」= 事项 `conversion_status = 1`，判据唯一纯函数 `isRiskFrozen`
（`src/app/lib/server/services/risks.ts`，全仓唯一比较处）。冻结后业务事实（状态、字段、
经办人、当事人、软删、节点）不可再改；协作面（评论、关注人、追加转案件）与分类（标签）
保持开放。

### R2 当事人 → 锁

- `appendRiskParties`（追加当事人，:348）补门：冻结即拒。
- `removeRiskParty`（摘除当事人挂接，:387）补门：冻结即拒。
- 理由：当事人是业务内容（谁被卷入），不是协作面。

### R3 软删 → 锁

- `deleteRiskMatter`（:1660）补门：冻结即拒。
- 理由：事项是案件的上游台账；正被 N 个案件引用时删掉，案件详情页的「来源事项卡」就断源。

### R4 标签 → 允许加，但必须是「刻意豁免」

- `batchTagRiskMatters` **不加门**，但要在代码里**显式写明这是刻意豁免、以及理由**。
- 验收判据是「说明存在且写清了理由」，不是「加了门」。

### R5 同形与顺序（MATT-80 的教训）

1. 门形态与既有五道**逐字同形**，且排在 `isArchived` 与归属判定**之前**
   （冻结是记录自身的属性，与「你是不是经办人」无关）：
   `if (isRiskFrozen(<row>.conversionStatus)) return { ok: false, why: "frozen" };`
2. 相关查询必须**真的把 `conversionStatus` 选出来**（不能只看 id / ownerId）。
3. **路由层显式接住**：`if (r.why === "frozen") return fail(422, "frozen", RISK_FROZEN_MESSAGE);`
   —— 不接住就掉进兜底，把「转过案件」说成「归档/权限」或别的假原因。
4. `RISK_FROZEN_MESSAGE` 上方注释「N 个路由共用」的 N 改成实际数字。

### R6 不动的东西（既有裁定）

- 评论（`addRiskComment` / `editRiskComment`）、关注人（`addRiskFollowers` /
  `removeRiskFollower`）、追加转案件（`convertToCase`）保持开放（ADR-0003）。
- 判据只写一处：不把 `conversion_status === 1` 抄进新门。

## Acceptance Criteria

- [ ] 冻结事项上追加 / 摘除当事人返回 `why: "frozen"`；未冻结事项照旧成功。
- [ ] 冻结事项上软删返回 `why: "frozen"`；未冻结事项照旧软删成功。
- [ ] 三条服务路径的门与既有五道逐字同形，且排在归档 / 归属判定之前；
      查询真的选出了 `conversionStatus`。
- [ ] 当事人两条路由 + 软删路由显式接住 `frozen` → `422 frozen` + `RISK_FROZEN_MESSAGE`；
      `RISK_FROZEN_MESSAGE` 注释里的路由数改为实际值。
- [ ] `batchTagRiskMatters` 未加门；代码里写明「刻意豁免」与理由；有一条源码断言钉住这一点。
- [ ] `risks.spec.ts` 的「恰好 N 道活门」计数与变量顺序、函数名清单同步为实际值；
      `mustStayOpen` 清单移出三条（只留真正豁免的评论 / 关注人 / 批量标签）。
- [ ] 反向红：把新加的一扇门短路成 `if (false && isRiskFrozen(...))`，对应断言变红且
      「红得说得出话」；改回后重跑绿。
- [ ] `pnpm verify` 全绿（format / lint / typecheck / test / lint-guard / anchors / deploy:check）。
- [ ] 只动本票相关文件；不动 `users-view.tsx` / `workbench.tsx` / `reports.ts` / `public/`
      （另一会话正在改）。

## Notes

- 上游裁定见 `docs/adr/0005-freeze-covers-business-facts.md`。
- 术语「冻结」见 `GLOSSARY.md`。
- 本票不 commit、不 push、不写 Paca。

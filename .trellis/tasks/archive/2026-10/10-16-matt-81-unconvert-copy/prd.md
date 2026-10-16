# MATT-81 撤销转案件：接受现状 + 拒绝文案写明「规则而非故障」

- Paca：#81（`2c74f0ae-d1ad-4727-a34e-51a0ab7dfe65`）
- 父票：#12 M3 主档 CRUD
- 裁定：2026-10-16（#89 会话定向；本票 claim 后施工）

## Goal

撤销转案件关联这个端点，**对任何事项都只会回 422 `frozen`**：

```text
unconvertFromCase 的前提 = 存在关联行 mn_risk_matter_case
关联行只能由 convertToCase 产生
convertToCase 在同一事务里把 conversion_status 置 1
冻结谓词 = conversion_status === 1
⇒ 冻结门永远先命中
```

裁定 = **① 接受现状**：转案件后不可撤销是规则；三道前置检查（进展 / 非预设节点 / 费用）留作备用防线；
**不放宽** `isRiskFrozen` 谓词 —— 那会推翻 2026-10-14「冻结按已转案件算」的已验收裁定。

本票只补裁定里那件小事：**拒绝文案要写明「转案件后不可撤销是规则，不是故障」**，免得用户以为出错。

## Requirements

1. 新增专用对外文案 `RISK_UNCONVERT_FROZEN_MESSAGE`（`services/risks.ts`，紧邻 `RISK_FROZEN_MESSAGE`）：
   - 点明「不可撤销 —— 这是规则，不是出错了」；
   - 留下一步（在案件上继续推进）；
   - **仍含「冻结」二字**：`agent-work/smoke-convert.mjs` 靠它把 `frozen` 与笼统的 `blocked` 分开；
   - 不含 ASCII 分号（`route.spec.ts` 靠它截取正文）。
2. `unconvert/route.ts` 的 `case "frozen"` 改用它；**刻意不复用**共享那句 ——
   共享那句回答的是「哪些字段不能再改、该去哪儿改」，而点撤销的人**不是想改，是想退回**，
   同一句放在这里读起来像权限不够或系统出错。
3. 共享文案注释里的「六个路由共用」→「五个」，并指向专用那句（别让注释撒谎）。
4. 端点与服务层的既有说明补上本次裁定（接受现状 + 文案义务），让「为什么只改文案」留在代码旁。
5. 新增 `unconvert/route.spec.ts` 钉住上面 1–2 三件事。

## Acceptance Criteria

- [ ] `RISK_UNCONVERT_FROZEN_MESSAGE` 存在，含「规则」「不是出错」「案件上」「冻结」，且不含 `;`
- [ ] `unconvert/route.ts` 的 `frozen` 分支走专用文案；文件里**不再**出现 `fail(422, "frozen", RISK_FROZEN_MESSAGE)`
- [ ] `RISK_FROZEN_MESSAGE` 注释说「五个路由共用」并指向专用那句
- [ ] `unconvert/route.spec.ts` 三条断言过；**反向红**：把 route 改回共享文案 ⇒ 立刻红（不许只看「绿了」）
- [ ] `pnpm verify` 全绿（format / lint / typecheck / test / lint-guard / anchors / deploy:check）
- [ ] 只动本票文件：`services/risks.ts`、`unconvert/route.ts`、`unconvert/route.spec.ts`、本任务目录
      （不碰 `users-view.tsx` / `workbench.tsx` / `reports.ts` / `public/` —— 另一会话在用）
- [ ] **不改行为**：不动 `isRiskFrozen`、不动三道前置、**不加** `?force` 之类的逃生门

## Notes

- 票面第二个建议（`REASON_REQUIRED_ACTIONS` 里的 `UNCONVERT` 现在走不到）**已核实**：
  `reason` 必填**仍然成立**，只是由 schema 层拦（`unconvertSchema` 的 `.min(1)` → 400，
  `agent-work/smoke-convert.mjs` 有断言），服务层那条 `reason_required` 退成备用防线（与 `blocked` 同）。
  所以本票不改它 —— 改了反而是把一条**还在生效**的必填规则删掉。
- 前端「撤销」入口保持原样：本票只改文案，不做可见性调整（那是另一件事，没有裁定）。

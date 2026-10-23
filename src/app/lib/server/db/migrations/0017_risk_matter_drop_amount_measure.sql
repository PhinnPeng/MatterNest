-- 0017：事项侧撤下「预估影响」与「已采取措施」（2026-10-22）
--
-- 为什么需要这条：这两栏原先在登记表单上、也在库里，但业务侧裁定它们不再由事项承载——
-- 「已采取措施」说的是处置过程，事项侧那条线本来就走评论（详情页的「处置记录」就是评论时间线，
-- 见 `risk-detail.tsx` 那句"事项的核查走评论，不靠进展"：事项没有进展表）；
-- 「预估影响」说的是金额敞口，那本来就有费用台账（`mn_risk_matter_expense`）在逐笔记。
-- 留在主表上等于同一件事实有第二份口径，而第二份永远没人维护它。
--
-- 撤的是整条链，不是只有表单：列表列（含排序）、详情区块、CSV/DOCX 导出、Excel 导入列、
-- 关键字搜索命中字段、转案件时"各案标的额合计 ≠ 事项预估影响"的对账提示，以及
-- §4.2 规则条件白名单里 `risk_matter` 的 `amount` 一项，都随这两列一起走。
--
-- ⚠ **这是破坏性迁移，存量数据不可回退**：删列即丢值。裁定记录里选的就是"删列"而不是
-- "保留列不再写入"，所以这里不做 `is_deleted` 式的软处理，也不留 `amount_old` 之类的影子列。
-- 真要找回只能从备份库捞。
--
-- `currency` **不动**：它是费用侧的口径锚点（`mn_risk_matter_expense` 没有自己的币种列，
-- 见 `schema/hosts.ts` 里那条"一期 E27 只有 CNY，费用与宿主同币种"），与被删的金额列无关。
--
-- 案件侧的 `mn_matter.amount`（标的额）**不动**：那是案件自己的字段，本次只撤事项侧。
--> statement-breakpoint
ALTER TABLE "mn_risk_matter" DROP CONSTRAINT IF EXISTS "ck_mn_risk_matter_amount";
--> statement-breakpoint
ALTER TABLE "mn_risk_matter" DROP COLUMN IF EXISTS "measure";
--> statement-breakpoint
ALTER TABLE "mn_risk_matter" DROP COLUMN IF EXISTS "amount";

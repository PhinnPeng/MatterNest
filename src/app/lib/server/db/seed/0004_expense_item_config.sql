-- 费用项目 seed（基线 7.6 / master F5-4「费用项目配置：名称、编码、是否启用、排序」）
--
-- 为什么要有这一批行：费用行上的 `item_id` 是**真外键**（迁移 0011），
-- 所以"费用项目走配置"不是一句约定 —— 没有配置行就一笔费用都登记不了。
-- 配置**页**（P16 `/settings/expense-items`）归 M5，本票只放种子并只读消费它。
--
-- id 用 46xx 低号段（40xx 是节点类型、50xx 是标签、60xx 起是演示数据），
-- 与另外两张配置表同一条规矩：seed 要跨环境逐字重放，业务引用一律用 `code` 不用 id。
--
-- 九个项目的划分口径是"这笔钱花在哪个环节"（而不是"付给谁"）：诉讼费与执行费交给法院、
-- 律师费付给外部律师、保全费与保全保险费是一对（担保费与保险费常分两张发票）、
-- 鉴定费与公证费是取证环节、差旅费是办案开销，最后一个兜底。
-- 全部 `is_system = true`：预置项可停用、不可删（停用后新费用选不到它，历史行照常显示）。
INSERT INTO "mn_expense_item_config" ("id", "code", "name", "sort_order", "is_system", "is_enabled")
VALUES
  (4651, 'court_fee', '诉讼费', 1, true, true),
  (4652, 'lawyer_fee', '律师费', 2, true, true),
  (4653, 'preservation_fee', '保全费', 3, true, true),
  (4654, 'preservation_insurance', '保全保险费', 4, true, true),
  (4655, 'appraisal_fee', '鉴定费', 5, true, true),
  (4656, 'notary_fee', '公证费', 6, true, true),
  (4657, 'execution_fee', '执行费', 7, true, true),
  (4658, 'travel_fee', '差旅费', 8, true, true),
  (4659, 'other', '其他', 9, true, true)
ON CONFLICT ("code") DO NOTHING;

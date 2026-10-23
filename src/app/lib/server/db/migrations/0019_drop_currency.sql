-- 0019：删除两处 `currency` 列（2026-10-22 用户裁定）
--
-- ## 为什么删
--
-- 案件的「基本信息」块里不再有币种这一项；再追一层，它本来就没有信息量：
-- E27 只有一个值 `CNY`，界面从来没有第二种币种可选，`amount` 的展示固定按元。
-- 留着一列永远等于 'CNY' 的字段，就是让每个读代码的人先问一句"这列干嘛的"。
--
-- ## 边界：只删「币种」，不删金额
--
-- `amount`（标的额）仍在，语义不变；费用的合计也只认这一种币种，所以本迁移
-- **不碰**费用表（它们本来就没有币种列）。将来真正出现第二种币种时，
-- 要加的是"金额 + 币种"的一对，而不是把这一列原样加回来。
--
-- 事项侧的 `currency` 一并删除：它此前被当作"事项费用金额的口径锚点"，
-- 但一期没有第二种币种，锚点等于常量；留着只会让两宿主结构分叉。
--
-- ## 连带改动（同一笔，代码侧）
--
--   · `mn_matter` / `mn_risk_matter` 的 schema 与 CHECK 同时撤下；
--   · 详情 DTO、导出（案件/事项各一行「币种」）不再有这一项；
--   · 枚举表 E27 的落点回到 `pending-table`（值域保留，等真有多币种时再落库）。
--
-- ## DOWN（前滚优先，但人要看得懂丢了什么）
--
--   ALTER TABLE "mn_matter" ADD COLUMN "currency" varchar(3) DEFAULT 'CNY' NOT NULL;
--   ALTER TABLE "mn_risk_matter" ADD COLUMN "currency" varchar(3) DEFAULT 'CNY' NOT NULL;
--   ⇒ **数据无损**：这列从来没有第二个值，重建后全部是 'CNY'。
--      但 CHECK 约束要一并重建（`ck_mn_matter_currency` / `ck_mn_risk_matter_currency`）。
--> statement-breakpoint

ALTER TABLE "mn_matter" DROP CONSTRAINT "ck_mn_matter_currency";
--> statement-breakpoint
ALTER TABLE "mn_risk_matter" DROP CONSTRAINT "ck_mn_risk_matter_currency";
--> statement-breakpoint
ALTER TABLE "mn_matter" DROP COLUMN "currency";
--> statement-breakpoint
ALTER TABLE "mn_risk_matter" DROP COLUMN "currency";

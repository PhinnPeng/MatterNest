-- 0020：节点三态 + 手工节点不选类型（2026-10-23 用户裁定）
--
-- ## 两件事一起做
--
-- ① **三态**：`not_started` 撤掉，节点只剩 进行中 / 已完成 / 已取消。
--    节点的主要功能是提醒：一条节点要么带着日期在跑、要么结束了，
--    "还没开始"既挡不住提醒，也不改变谁该动手。新节点默认 `in_progress`。
--    现存的 `not_started` 行统一改成 `in_progress`（它们本来就是"还没人标过"，
--    改成进行中与"节点从创建起就在跑"这条新口径一致）。
--
-- ② `node_type_id` 放开 NOT NULL：手工节点只填名称/描述/时间，不选类型
--    （类型是模板的概念，预置节点仍按类型生成、类型列仍可空着）。
--
-- ## 索引
--
-- 提醒扫描的 partial index 原本写 `status IN ('not_started','in_progress')`；
-- 三态之后只剩进行中，改写成 `status = 'in_progress'`（同一条 ix_node_scan）。
-- 必须先 UPDATE 再 ADD CHECK：否则仍带 `not_started` 的旧行会在加约束时整批失败。
--
-- ## DOWN（前滚优先，但人要看得懂丢了什么）
--
--   ALTER … ADD CONSTRAINT … CHECK (status IN ('not_started','in_progress','completed','cancelled'));
--   ALTER … ALTER COLUMN status SET DEFAULT 'not_started';
--   ALTER … ALTER COLUMN node_type_id SET NOT NULL;   -- ⚠ 手工节点（type 为空）会让这条失败
--   ⇒ **三态的信息不可逆**：已经标成"进行中"的行无法区分哪些原来是"未开始"。
--      值域本身可回退，但"默认进行中"这条产品口径回不去。
--> statement-breakpoint

ALTER TABLE "mn_matter_node" DROP CONSTRAINT "ck_mn_matter_node_status";
--> statement-breakpoint
ALTER TABLE "mn_risk_matter_node" DROP CONSTRAINT "ck_mn_risk_matter_node_status";
--> statement-breakpoint

-- 先迁数据，再加新 CHECK
UPDATE "mn_matter_node" SET "status" = 'in_progress' WHERE "status" = 'not_started';
--> statement-breakpoint
UPDATE "mn_risk_matter_node" SET "status" = 'in_progress' WHERE "status" = 'not_started';
--> statement-breakpoint

DROP INDEX "ix_mn_matter_node_scan";
--> statement-breakpoint
DROP INDEX "ix_mn_risk_matter_node_scan";
--> statement-breakpoint
ALTER TABLE "mn_matter_node" ALTER COLUMN "node_type_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mn_matter_node" ALTER COLUMN "status" SET DEFAULT 'in_progress';
--> statement-breakpoint
ALTER TABLE "mn_risk_matter_node" ALTER COLUMN "node_type_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mn_risk_matter_node" ALTER COLUMN "status" SET DEFAULT 'in_progress';
--> statement-breakpoint

CREATE INDEX "ix_mn_matter_node_scan" ON "mn_matter_node" USING btree ("status","deadline_time") WHERE is_time_confirmed AND status = 'in_progress';
--> statement-breakpoint
CREATE INDEX "ix_mn_risk_matter_node_scan" ON "mn_risk_matter_node" USING btree ("status","deadline_time") WHERE is_time_confirmed AND status = 'in_progress';
--> statement-breakpoint

ALTER TABLE "mn_matter_node" ADD CONSTRAINT "ck_mn_matter_node_status" CHECK (status IN ('in_progress','completed','cancelled'));
--> statement-breakpoint
ALTER TABLE "mn_risk_matter_node" ADD CONSTRAINT "ck_mn_risk_matter_node_status" CHECK (status IN ('in_progress','completed','cancelled'));

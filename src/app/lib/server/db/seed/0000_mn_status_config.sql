-- 状态集 seed（修订稿 §3.2 八行：4 语义 × 2 宿主，事项与案件同构）
--
-- 三条口径写在这里，因为它们都是实测出来的约束而不是风格：
--   1. 幂等靠 `ux_status_code`（host_type, code）—— spec 里那句 `ON CONFLICT (code)` 对这张表不成立，
--      因为 matter 与 risk_matter 各有一套同名 code，单列 code 上不存在的唯一索引会让 DO NOTHING 直接报错。
--   2. `is_archive_status` 是 STORED 生成列，**不能出现在插入列清单里**（实测：写它报
--      "column can only be updated to DEFAULT"）。
--   3. id 用预留的低段号段（1–8），不用雪花值：seed 必须跨环境逐字重放，
--      而规则/接口一律引用 `code` 不引用 id（修订稿 §2.4 末行）。
--
-- color 是占位值：M3 视觉定稿后统一替换，不在这里自创配色语义。
INSERT INTO "mn_status_config" ("id", "code", "name", "color", "host_type", "semantics", "is_system", "is_initial_status", "sort_order")
VALUES
  (1, 'pending', '待受理', 'slate', 'matter', 'open', true, true, 1),
  (2, 'in_progress', '进行中', 'blue', 'matter', 'in_progress', true, false, 2),
  (3, 'closed', '已结案', 'green', 'matter', 'closed', true, false, 3),
  (4, 'archived', '已归档', 'gray', 'matter', 'archived', true, false, 4),
  (5, 'pending', '待受理', 'slate', 'risk_matter', 'open', true, true, 1),
  (6, 'in_progress', '进行中', 'blue', 'risk_matter', 'in_progress', true, false, 2),
  (7, 'closed', '已结案', 'green', 'risk_matter', 'closed', true, false, 3),
  (8, 'archived', '已归档', 'gray', 'risk_matter', 'archived', true, false, 4)
ON CONFLICT ("host_type", "code") DO NOTHING;

-- 推荐路径落进 `next_status_codes`（修订稿 §3.3 第 2 条：按 sort_order 串联 semantics 序列）。
--
-- 为什么必须填：这条数组是"偏离判定"的唯一数据源 —— 空数组在服务层等于"不限制"
-- （§3.3 第 3 条），于是**线上永远是零条原因记录**，而 §3.3 设计的那个可解释链路
-- 恰好要靠这些原因才能被审出来。填了它，「待受理 → 已结案」这种跳法才会要求解释。
-- 归档态留空是终态：它没有推荐后继，离开它走的是 `can_unarchive` 那条特权出口。
--
-- 用 UPDATE 而不是把列并进上面的 INSERT：`ON CONFLICT DO NOTHING` 对已存在的八行
-- 不生效，而 seed 要能在跑过第一轮的老库上重放出正确状态（W1-6 的幂等口径）。
UPDATE "mn_status_config" AS s
SET "next_status_codes" = CASE "code"
  WHEN 'pending' THEN '{in_progress}'::text[]
  WHEN 'in_progress' THEN '{closed}'::text[]
  WHEN 'closed' THEN '{archived}'::text[]
  ELSE '{}'::text[]
END
WHERE "is_system" AND "next_status_codes" = '{}';

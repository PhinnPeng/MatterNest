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
  (1, 'pending', '已登记', 'slate', 'matter', 'open', true, true, 1),
  (2, 'in_progress', '进行中', 'blue', 'matter', 'in_progress', true, false, 2),
  (3, 'closed', '已结案', 'green', 'matter', 'closed', true, false, 3),
  (4, 'archived', '已归档', 'gray', 'matter', 'archived', true, false, 4),
  (5, 'pending', '已登记', 'slate', 'risk_matter', 'open', true, true, 1),
  (6, 'in_progress', '进行中', 'blue', 'risk_matter', 'in_progress', true, false, 2),
  (7, 'closed', '已处理', 'green', 'risk_matter', 'closed', true, false, 3),
  (8, 'archived', '已归档', 'gray', 'risk_matter', 'archived', true, false, 4)
ON CONFLICT ("host_type", "code") DO NOTHING;

-- 推荐路径落进 `next_status_codes`（修订稿 §3.3 第 2 条：按 sort_order 串联 semantics 序列）。
--
-- 为什么必须填：这条数组是"偏离判定"的唯一数据源 —— 空数组在服务层等于"不限制"
-- （§3.3 第 3 条），于是**线上永远是零条原因记录**，而 §3.3 设计的那个可解释链路
-- 恰好要靠这些原因才能被审出来。填了它，「已登记 → 已结案」这种跳法才会要求解释。
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

-- 显示名按企业口径改名（IQ-5 / IQ-6，T0）。`code` 一律不动——它是接口与规则的引用键，
-- 改的只是给人看的那一列（枚举表 §5.1「code 不可改是既有契约」）。
--   · `pending` 双宿主 → **已登记**：原名"待受理"带流程暗示，而事项登记后没有任何受理闸门；
--     案件侧同理（收案未指派经办前的暂存态，实际很少停留）。
--   · `closed` 事项侧 → **已处理**（2026-10-14 裁定）："结案"是诉讼词，事项尚未进入法律程序。
--     案件侧**保留**"已结案"——分叉是刻意的，对应"事项是台账，案件是战场"。
--     「了结」是这一轮之前的临时叫法，已被"已处理"取代：它同样绕开了"结案"，
--     但读起来像"这件事有个了断"，而事项侧实际只表示"已处理完、不再跟进"。
-- 同样用 UPDATE：上面 INSERT 的 `ON CONFLICT DO NOTHING` 对老库的八行不生效。
-- WHERE 带上**旧显示名**：改名是幂等的，但不能无条件覆写——将来配置页允许管理员改显示名之后，
-- 这条语句不该把人家的定制冲回默认值（与上面 `next_status_codes` 只补空值同一种克制）。
--
-- ⚠ **旧值必须列全**。`closed` 事项侧这一格先后经过"已结案 → 了结 → 已处理"两次改名，
-- 而守卫只认**当前值还是旧名**才动手。所以漏掉中间那个「了结」的后果是：
-- 跑过上一轮 seed 的库永远停在「了结」，新库却是对的 —— **两侧不一致且没有任何报错**
-- （`name` 不参与任何判定）。这一格每多改一次名，下面 IN 列表就要多收一个旧值。
UPDATE "mn_status_config"
SET "name" = CASE
  WHEN "host_type" = 'matter'      AND "code" = 'pending' THEN '已登记'
  WHEN "host_type" = 'risk_matter' AND "code" = 'pending' THEN '已登记'
  WHEN "host_type" = 'risk_matter' AND "code" = 'closed'  THEN '已处理'
  ELSE "name"
END
WHERE "is_system" AND (
  (("code" = 'pending')  AND "name" = '待受理')
  OR (
    "host_type" = 'risk_matter' AND "code" = 'closed'
    AND "name" IN ('已结案', '了结')
  )
);

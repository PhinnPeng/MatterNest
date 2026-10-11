-- 配置表 seed：风险等级 / 节点类型 / 标签（枚举表 §0 的"配置驱动"那一侧）
--
-- 节点类型这批行同时喂两条路径（修订稿 §4）：
--   · P1「创建时预设」= `preset_on_create = true`，宿主建号时按 `sort_order` 实例化；
--   · P2「状态变更时规则」= 由自动化规则引用，一期不 preset。
-- 事项侧的默认 3 节点（基线 1.1：风险评估 / 处置执行 / 化解确认）就是下面 3 行 `preset_on_create=true`。
--
-- id 用 30xx/40xx 低号段：seed 要跨环境逐字重放，规则与配置引用一律用 code 不用 id（修订稿 §2.4 末行）。
INSERT INTO "mn_risk_level_config" ("id", "code", "name", "sort_order", "is_system")
VALUES
  (3001, 'high', '高', 1, true),
  (3002, 'mid', '中', 2, true),
  (3003, 'low', '低', 3, true)
ON CONFLICT ("code") DO NOTHING;

-- 案件节点：立案(点) → 举证(段) → 开庭(点) → 判决(点)；举证是时间段，故 time_type=range
--
-- ⚠ **事项侧三行的 `preset_on_create` 全是 false，`handle` 的 `time_type` 是 point。**
-- 这是 IQ-5 的直接落点，不是笔误：「事项是台账，案件是战场」——事项侧**无预设节点**，
-- 节点由经办人手动加，且**只支持时间点**（T1 验收标准原文：「不预设任何节点」「不出现时间段控件」）。
-- 改动前的值是 `true` × 3 + `handle='range'`，那正是裁定要排除的形态。
--
-- 为什么**保留这 3 个类型行**而不是删掉：类型是「可以选什么」，preset 是「建号时塞几个」。
-- 裁定否掉的是后者。保留类型，事项侧才仍有可手动添加的节点种类。
INSERT INTO "mn_node_type_config"
  ("id", "code", "name", "host_type", "time_type", "offset_days", "preset_on_create", "default_remind_days", "sort_order", "is_system")
VALUES
  (4001, 'filing', '立案', 'matter', 'point', 0, true, '{7,3,1}', 1, true),
  (4002, 'evidence', '举证', 'matter', 'range', 7, true, '{7,3,1}', 2, true),
  (4003, 'hearing', '开庭', 'matter', 'point', 21, true, '{7,3,1}', 3, true),
  (4004, 'judgment', '判决', 'matter', 'point', 30, false, '{3,1}', 4, true),
  (4101, 'assess', '风险评估', 'risk_matter', 'point', 0, false, '{3,1}', 1, true),
  (4102, 'handle', '处置执行', 'risk_matter', 'point', 3, false, '{7,3,1}', 2, true),
  (4103, 'confirm', '化解确认', 'risk_matter', 'point', 14, false, '{3,1}', 3, true)
ON CONFLICT ("host_type", "code") DO NOTHING;

-- 上面 INSERT 带 `ON CONFLICT DO NOTHING`，对老库的既有行**不生效**——所以要 UPDATE 重放，
-- 与 `0000_mn_status_config.sql` 改名那段同一种做法。
--
-- WHERE 带**旧值**守卫，不是无条件覆写：将来配置页允许管理员改这些列之后，
-- 这条语句不该把人家的定制冲回默认（与那边只补空值同一种克制）。
UPDATE "mn_node_type_config"
SET
  "preset_on_create" = false,
  "time_type" = CASE WHEN "code" = 'handle' THEN 'point' ELSE "time_type" END
WHERE "host_type" = 'risk_matter' AND "is_system" AND (
  ("preset_on_create" = true)
  OR ("code" = 'handle' AND "time_type" = 'range')
);

-- 标签：演示用的四类，供列表页筛选与统计卡分组
INSERT INTO "mn_tag" ("id", "name", "host_type", "color", "sort_order")
VALUES
  (5001, '建设工程', 'matter', 'cobalt', 1),
  (5002, '金融借款', 'matter', 'teal', 2),
  (5003, '劳动争议', 'risk_matter', 'amber', 1),
  (5004, '数据合规', 'risk_matter', 'slate', 2)
ON CONFLICT ("host_type", "name") DO NOTHING;

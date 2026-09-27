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
INSERT INTO "mn_node_type_config"
  ("id", "code", "name", "host_type", "time_type", "offset_days", "preset_on_create", "default_remind_days", "sort_order", "is_system")
VALUES
  (4001, 'filing', '立案', 'matter', 'point', 0, true, '{7,3,1}', 1, true),
  (4002, 'evidence', '举证', 'matter', 'range', 7, true, '{7,3,1}', 2, true),
  (4003, 'hearing', '开庭', 'matter', 'point', 21, true, '{7,3,1}', 3, true),
  (4004, 'judgment', '判决', 'matter', 'point', 30, false, '{3,1}', 4, true),
  (4101, 'assess', '风险评估', 'risk_matter', 'point', 0, true, '{3,1}', 1, true),
  (4102, 'handle', '处置执行', 'risk_matter', 'range', 3, true, '{7,3,1}', 2, true),
  (4103, 'confirm', '化解确认', 'risk_matter', 'point', 14, true, '{3,1}', 3, true)
ON CONFLICT ("host_type", "code") DO NOTHING;

-- 标签：演示用的四类，供列表页筛选与统计卡分组
INSERT INTO "mn_tag" ("id", "name", "host_type", "color", "sort_order")
VALUES
  (5001, '建设工程', 'matter', 'cobalt', 1),
  (5002, '金融借款', 'matter', 'teal', 2),
  (5003, '劳动争议', 'risk_matter', 'amber', 1),
  (5004, '数据合规', 'risk_matter', 'slate', 2)
ON CONFLICT ("host_type", "name") DO NOTHING;

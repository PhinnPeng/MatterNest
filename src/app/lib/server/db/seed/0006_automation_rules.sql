-- 预置自动化规则 9 条（修订稿 §2.3 的表；MATT-43 / T5b）
--
-- ## 为什么这张 seed 与规则 9 同票进来
--
-- 票面 AC 第一条是「规则 9 进 seed，可幂等重放，触发域唯一性由 DB 约束保证」。
-- 而 `mn_automation_rule` 此前只存在于文档里（迁移 0012 才建表）——
-- 所以"规则 8 → 9"这件事的落点是**这张 seed 一次性把 9 条都写进去**，
-- 不是"在某个已有的 8 条里插一行"。
--
-- ## 三条口径
--
-- 1. **取值源是 `src/shared/automation/preset-rules.ts`**，本文件是它的字面量投影。
--    逐字段对拉（含下面这些 `scope_key`）由 `src/shared/automation/preset-rules.seed.spec.ts`
--    现算复核——`scope_key` 手抄错一位不会报错，只会让唯一约束**静默失效**。
-- 2. **`ON CONFLICT ("code") DO NOTHING` 而不是 DO UPDATE**：预置规则是
--    `is_system = true` —— **可停用、可调参**（F5-10）。重放 seed 若把 `is_enabled`
--    与 `action_config` 打回初值，等于管理员每次 `db:seed` 都被重置一次，
--    而"停用规则 9 之后不再产生提醒"这条 AC 会在下一次 seed 后悄悄失效。
--    新增规则靠**新的 `code`**（DO NOTHING 只挡同 code）。
-- 3. **规则引用 `code` 不引用 id**（§2.4 末行）：id 只是低号段占位（8xxx），
--    跨环境重放的锚是 `code`。
--
-- ## 与规则 4 / 规则 9 有关的两条复核结论（写在数据旁边，免得下次有人"顺手统一"）
--
-- · 规则 3/4 的 `host_type` 是 **`matter`（仅案件）**，不是 `all`：IQ-9/Q37 的收窄
--   （事项无预设节点、观察型事项 30 天一催是噪音）。本仓有两处断言盯着它。
-- · 规则 4（`{days:30}`）与规则 9（`{days:14,status_code:"closed"}`）同为
--   `time_no_progress` + `notify`，靠 `trigger_config` 不同而落在**两个触发域**——
--   这就是它们能同时启用的全部理由（`scope_key` 不含动作、含归一化后的触发条件）。
--
-- `scope_key` 由 `computeScopeKey(trigger_type, trigger_target_type, canon(trigger_config))` 算出：
--   base32hex(sha1(normalized))[0:12]，归一化规则见枚举表 §4.4。
INSERT INTO "mn_automation_rule"
  ("id", "code", "name", "host_type", "trigger_type", "trigger_target_type",
   "trigger_config", "action_type", "action_config", "scope_key",
   "priority", "is_system", "is_enabled", "created_by")
VALUES
  -- 1 结案自动归档：破坏性动作，**默认禁用**（master §8）
  (8001, 'preset_01_close_auto_archive', '结案自动归档', 'all', 'status_changed', 'all',
   '{"status_code":"closed"}'::jsonb, 'archive', '{}'::jsonb, 'voa3vu2kch4o',
   10, true, false, 101),
  -- 2 状态变更通知关注人：收件人含 creator（IQ-13-V5 上报人回音）
  (8002, 'preset_02_status_changed_notify', '状态变更通知关注人', 'all', 'status_changed', 'all',
   '{}'::jsonb, 'notify',
   '{"receivers":["follower","creator"],"template_code":"status_changed"}'::jsonb, 'semc88bejpif',
   20, true, true, 101),
  -- 3 进入进行中创建节点：host_type 收窄为仅案件（IQ-9/Q37）
  (8003, 'preset_03_in_progress_create_node', '进入进行中创建节点', 'matter', 'status_changed', 'matter',
   '{"status_code":"in_progress"}'::jsonb, 'create_node',
   '{"template_code":"matter_in_progress","offset_days_from":"status_changed_at","offset_days":0}'::jsonb,
   'oso3etefupob', 10, true, true, 101),
  -- 4 长期未更新提醒：host_type 收窄为仅案件（IQ-9/Q37）；once_per_target + cooldown 必填
  (8004, 'preset_04_stale_30d_notify', '长期未更新提醒', 'matter', 'time_no_progress', 'matter',
   '{"days":30}'::jsonb, 'notify',
   '{"receivers":["owner"],"template_code":"stale_30d","once_per_target":true,"cooldown_days":30}'::jsonb,
   'qmej28gaunbb', 10, true, true, 101),
  -- 5 节点开始提醒：节点类触发跨两张节点表（动作实现内 UNION ALL）
  (8005, 'preset_05_node_before_start_notify', '节点开始提醒', 'all', 'node_before_start', 'all',
   '{"days":3}'::jsonb, 'notify',
   '{"receivers":["owner","follower"],"template_code":"node_start"}'::jsonb, 'qn6vn7h9maho',
   10, true, true, 101),
  -- 6 节点截止提醒：仅 time_type=range 且 end_time 非空的节点（§4.1）
  (8006, 'preset_06_node_before_end_notify', '节点截止提醒', 'all', 'node_before_end', 'all',
   '{"days":3}'::jsonb, 'notify',
   '{"receivers":["owner","follower"],"template_code":"node_end"}'::jsonb, 'r4mead320dr4',
   20, true, true, 101),
  -- 7 转案件后归档：由 risk_converted 领域事件触发（§2.3 末段），不再依赖"已转案件"状态
  (8007, 'preset_07_risk_converted_archive', '转案件后归档', 'risk_matter', 'event_occurred', 'risk_matter',
   '{"event":"risk_converted"}'::jsonb, 'archive', '{}'::jsonb, 'm7e5un5tlhn2',
   10, true, true, 101),
  -- 8 新评论通知关注人：与规则 7 同触发类型、不同 event ⇒ 不同域
  (8008, 'preset_08_comment_added_notify', '新评论通知关注人', 'all', 'event_occurred', 'all',
   '{"event":"comment_added"}'::jsonb, 'notify',
   '{"receivers":["follower","creator"],"template_code":"comment_new"}'::jsonb, 'ur9l322v2tud',
   20, true, true, 101),
  -- 9 结案后材料不全提醒（IQ-16 / F2-26④ / G4 载体）：仅案件、仅经办人、14 天、once_per_target
  (8009, 'preset_09_archive_incomplete_notify', '结案后材料不全提醒', 'matter', 'time_no_progress', 'matter',
   '{"days":14,"status_code":"closed"}'::jsonb, 'notify',
   '{"receivers":["owner"],"template_code":"archive_incomplete","once_per_target":true,"cooldown_days":14}'::jsonb,
   '9hviq69mu3cd', 10, true, true, 101)
ON CONFLICT ("code") DO NOTHING;

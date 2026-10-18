-- 演示数据（**仅 dev**；生产环境这条文件不参与部署，靠 `--seed-only` 时也在清单外）
--
-- 编排原则：让"三档数据范围"在一屏内可被看见差别，所以
--   · 6 个案件的负责人分散在 101/101 名下，其中 2 个的 `created_by` 是专员 101；
--   · 1 个案件把 101 加成协办（L2 能看到、L3 看不到，这就是 §1 的 L2/L3 差异）；
--   · 1 个案件已归档、1 个已结案，用来验证"归档默认隐藏"与状态徽标。
-- 编号与 `mn_code_seq` 同步写：不写的话，从这里建的演示数据会与后续真实取号撞号。
-- 日期都围绕"今天"（建库当日 2026-09-27 前后），临期条才有东西可显示。
--
-- id 用 6xxx/7xxx 低号段，同 seed 的其它文件一致（规则/接口引用 code，不引用这些 id）。

INSERT INTO "mn_party" ("id", "name", "type", "id_type", "id_number", "created_by", "updated_by")
VALUES
  (6001, '江苏恒基建设集团有限公司', 'legal_person', 'unified_social_credit', '91320100MA1X00001A', 101, 101),
  (6002, '南京鼎泰房地产开发有限公司', 'legal_person', 'unified_social_credit', '91320100MA1X00002B', 101, 101),
  (6003, '周敏', 'natural_person', 'id_card', '320102199001011234', 101, 101),
  (6004, '南京云脉数据科技有限公司', 'legal_person', 'unified_social_credit', '91320100MA1X00003C', 101, 101),
  (6005, '南京银行城东支行', 'legal_person', 'unified_social_credit', '91320100MA1X00004D', 101, 101)
ON CONFLICT ("id") DO NOTHING;

-- ── 案件 ────────────────────────────────────────────────
INSERT INTO "mn_matter"
  ("id", "internal_code", "case_no", "name", "cause", "case_type", "procedure", "litigation_role",
   "court", "amount", "level", "owner_id", "status", "is_archived", "filing_date", "closing_date",
   "last_progress_at", "description", "created_by", "updated_by", "updated_at")
VALUES
  (7001, 'AJ-20260921-001', '（2026）苏0102民初4821号', '恒基建设诉鼎泰房地产建设工程施工合同纠纷',
   '建设工程施工合同纠纷', 'civil_commercial', 'first_instance', 'plaintiff',
   '南京市玄武区人民法院', '8420000.00', 'high', 101, 'in_progress', false, '2026-09-21', NULL,
   now() - interval '6 days', '一期主体施工合同结算争议，重点在签证单与工期索赔的举证责任分配。', 101, 101, now() - interval '6 days'),
  (7002, 'AJ-20260921-002', '（2026）苏01民终1130号', '鼎泰房地产上诉建设工程施工合同纠纷二审',
   '建设工程施工合同纠纷', 'civil_commercial', 'second_instance', 'appellant',
   '南京市中级人民法院', '8420000.00', 'high', 101, 'in_progress', false, '2026-09-22', NULL,
   now() - interval '2 days', '一审判决后由发包人提起上诉，争议集中在鉴定意见的采信。', 101, 101, now() - interval '2 days'),
  (7003, 'AJ-20260923-003', '（2026）苏0102民初5017号', '周敏诉南京云脉数据科技劳动争议',
   '劳动合同纠纷', 'civil_commercial', 'first_instance', 'plaintiff',
   '南京市秦淮区人民法院', '186000.00', 'mid', 101, 'pending', false, '2026-09-23', NULL,
   now() - interval '1 day', '解除劳动关系经济补偿与未休年假工资，事实清楚，走简易程序。', 101, 101, now() - interval '1 day'),
  (7004, 'AJ-20260925-004', '（2026）苏宁仲裁字第2210号', '云脉数据科技与被申请人借款合同纠纷',
   '金融借款合同纠纷', 'civil_commercial', 'arbitration', 'respondent',
   '南京仲裁委员会', '2350000.00', 'mid', 101, 'in_progress', false, '2026-09-25', NULL,
   now() - interval '3 hours', '银行主张提前到期，我方抗辩焦点在放款条件是否成就。', 101, 101, now() - interval '3 hours'),
  (7005, 'AJ-20260918-005', '（2026）苏0102执1024号', '恒基建设申请执行建设工程施工合同纠纷',
   '执行实施类案件', 'civil_commercial', 'execution', 'applicant',
   '南京市玄武区人民法院', '5100000.00', 'low', 101, 'closed', false, '2026-09-18', '2026-09-25',
   now() - interval '9 days', '判决生效后申请强制执行，已到位部分款项，剩余以物抵债。', 101, 101, now() - interval '9 days'),
  (7006, 'AJ-20260910-006', '（2026）苏0102民初3390号', '鼎泰房地产与云脉数据科技合作开发合同纠纷',
   '合作开发房地产合同纠纷', 'civil_commercial', 'first_instance', 'defendant',
   '南京市鼓楼区人民法院', '1200000.00', 'low', 101, 'archived', true, '2026-09-10', '2026-09-19',
   now() - interval '17 days', '调解结案后按归档流程处理，用于验证"归档终态 + 列表默认隐藏"。', 101, 101, now() - interval '8 days')
ON CONFLICT ("internal_code") DO NOTHING;

-- 已归档那行补归档时间（归档动作本身另有 activity_log 一条）
UPDATE "mn_matter" SET "archived_at" = now() - interval '8 days', "archived_by" = 101 WHERE "internal_code" = 'AJ-20260910-006' AND "archived_at" IS NULL;

-- ── 参与人：把 101 加成 7001 的协办（L2 能看见，L3 看不见）────────
INSERT INTO "mn_matter_staff" ("id", "matter_id", "user_id", "staff_role")
VALUES
  (8001, 7001, 101, 'owner'),
  (8002, 7001, 101, 'co_owner'),
  (8003, 7002, 101, 'owner'),
  (8004, 7002, 101, 'follower'),
  (8005, 7003, 101, 'owner'),
  (8006, 7003, 101, 'follower'),
  (8007, 7004, 101, 'owner'),
  (8008, 7005, 101, 'owner'),
  (8009, 7006, 101, 'owner')
ON CONFLICT ("matter_id", "user_id", "staff_role") DO NOTHING;

-- ── 当事人（我方代理与对方并列，represented 与角色正交）──────────
INSERT INTO "mn_matter_party" ("id", "matter_id", "party_id", "party_role", "represented", "sort_order")
VALUES
  (8101, 7001, 6001, 'plaintiff', true, 1),
  (8102, 7001, 6002, 'defendant', false, 2),
  (8103, 7002, 6002, 'appellant', false, 1),
  (8104, 7002, 6001, 'appellee', true, 2),
  (8105, 7003, 6003, 'plaintiff', true, 1),
  (8106, 7003, 6004, 'defendant', false, 2),
  (8107, 7004, 6005, 'applicant', false, 1),
  (8108, 7004, 6004, 'respondent', true, 2)
ON CONFLICT ("matter_id", "party_id") DO NOTHING;

-- ── 节点：覆盖 时间点/时间段/待定/已完成/已取消 五种形态 ──────────
INSERT INTO "mn_matter_node"
  ("id", "matter_id", "node_type_id", "name", "time_type", "start_time", "end_time", "is_time_confirmed",
   "status", "source_kind", "sort_order", "owner_id", "cancel_reason", "created_by", "updated_by")
VALUES
  (8201, 7001, 4001, '立案', 'point', now() - interval '6 days', NULL, true, 'completed', 'preset', 1, 101, NULL, 101, 101),
  (8202, 7001, 4002, '举证', 'range', now() + interval '1 day', now() + interval '13 days', true, 'in_progress', 'preset', 2, 101, NULL, 101, 101),
  (8203, 7001, 4003, '开庭', 'point', now() + interval '2 days', NULL, true, 'not_started', 'preset', 3, 101, NULL, 101, 101),
  -- 「判决」时间待定：is_time_confirmed=false 且不参与提醒扫描（修订稿 §6.1）
  (8204, 7001, 4004, '判决', 'point', NULL, NULL, false, 'not_started', 'preset', 4, 101, NULL, 101, 101),
  (8205, 7002, 4003, '二审开庭', 'point', now() + interval '9 days', NULL, true, 'not_started', 'manual', 1, 101, NULL, 101, 101),
  (8206, 7003, 4001, '立案', 'point', now() - interval '1 day', NULL, true, 'completed', 'preset', 1, 101, NULL, 101, 101),
  (8207, 7003, 4002, '举证', 'range', now() + interval '4 days', now() + interval '18 days', true, 'not_started', 'preset', 2, 101, NULL, 101, 101),
  (8208, 7004, 4003, '仲裁开庭', 'point', now() + interval '1 day', NULL, true, 'not_started', 'manual', 1, 101, NULL, 101, 101),
  (8209, 7005, 4003, '执行财产查控', 'point', now() - interval '10 days', NULL, true, 'completed', 'manual', 1, 101, NULL, 101, 101),
  (8210, 7005, 4004, '以物抵债协商', 'point', NULL, NULL, true, 'cancelled', 'manual', 2, 101, '双方改按分期履行，无需以物抵债', 101, 101)
ON CONFLICT ("id") DO NOTHING;

-- ── 事项（其中 1 条已转案件，用来演示"第二徽标 + 与结案正交"）────
INSERT INTO "mn_risk_matter"
  ("id", "code", "name", "type", "level", "source", "description", "measure", "amount",
   "owner_id", "discover_date", "status", "conversion_status", "converted_case_count", "created_by", "updated_by", "updated_at")
VALUES
  (8301, 'FX-20260922-001', '合作开发项目对外担保超授权风险', 'corporate_governance', 'high', 'internal_check',
   '项目部以项目公司名义对外签订连带责任保证，超出授权额度且未走内部决议程序。',
   '已要求补做决议并暂停后续担保用印；对存量担保逐笔核额。', '3000000.00',
   101, '2026-09-22', 'in_progress', 1, 1, 101, 101, now() - interval '2 days'),
  (8302, 'FX-20260924-002', '外包人员访问生产数据合规风险', 'compliance', 'high', 'business_report',
   '外包团队持有生产库只读账号，可访问自然人姓名与证件号，超出必要范围。',
   '回收账号并改为脱敏视图；补充外包协议的数据处理条款。', '0.00',
   101, '2026-09-24', 'pending', 0, 0, 101, 101, now() - interval '1 day'),
  (8303, 'FX-20260926-003', '拖欠外包研发费用被催告', 'debt', 'mid', 'lawyer_letter',
   '收到对方律师函，主张两期研发服务费逾期未付并要求违约金。',
   '核对验收节点与付款条件，拟按分期方案回函。', '760000.00',
   101, '2026-09-26', 'in_progress', 0, 0, 101, 101, now() - interval '3 hours'),
  (8304, 'FX-20260915-004', '历史劳动争议批量解除风险', 'labor_dispute', 'mid', 'customer_complaint',
   '岗位调整后员工集中主张解除补偿，涉及 11 人。', '统一补偿口径并逐人协商。', '430000.00',
   101, '2026-09-15', 'archived', 0, 0, 101, 101, now() - interval '10 days')
ON CONFLICT ("code") DO NOTHING;

UPDATE "mn_risk_matter" SET "is_archived" = true, "archived_at" = now() - interval '10 days', "archived_by" = 101 WHERE "code" = 'FX-20260915-004' AND "is_archived" = false;
UPDATE "mn_risk_matter" SET "converted_at" = now() - interval '6 days', "converted_by" = 101 WHERE "code" = 'FX-20260922-001' AND "converted_at" IS NULL;

-- ── 事项的当事人 ───────────────────────────────────────
-- 这批行不能省：修订稿 §6.2 把"每案 ≥1 个当事人"定成**转案件确认时**的校验，
-- 而映射 §2.6 的新案件当事人是「引用事项已关联的同一批 party 行」。事项这边要是空的，
-- 演示里每条"转案件"都会撞那条校验，功能看着就像坏了。
INSERT INTO "mn_risk_matter_party"
  ("id", "risk_matter_id", "party_id", "party_role", "represented", "sort_order")
VALUES
  (8451, 8301, 6002, 'defendant', true, 1),
  (8452, 8301, 6001, 'plaintiff', false, 2),
  (8453, 8302, 6004, 'defendant', true, 1),
  (8454, 8303, 6004, 'plaintiff', false, 1),
  (8455, 8304, 6003, 'plaintiff', false, 1)
ON CONFLICT ("risk_matter_id", "party_id") DO NOTHING;

INSERT INTO "mn_risk_matter_staff" ("id", "risk_matter_id", "user_id", "staff_role")
VALUES
  (8401, 8301, 101, 'owner'),
  (8402, 8301, 101, 'follower'),
  (8403, 8302, 101, 'owner'),
  (8404, 8303, 101, 'owner'),
  (8405, 8304, 101, 'owner')
ON CONFLICT ("risk_matter_id", "user_id", "staff_role") DO NOTHING;

-- ⚠ 事项节点：**全部 `source_kind='manual'` 且 `time_type='point'`**（IQ-5）。
-- 原值是 `'preset'` × 4 且带 `'range'`，那正是裁定排除的形态：事项侧无预设节点、
-- 节点只支持时间点。改标成 manual 是**如实反映产品现在的行为**——
-- 这些节点代表"经办人手动加的"，而手动加正是事项侧唯一的加节点方式。
-- 保留这四行是为了 demo 仍有节点可看；真建事项时不再自动生成任何节点。
-- 先删掉旧 seed 留下的事项 preset 节点（`ON CONFLICT DO NOTHING` 对它们不生效，
-- 而下面那四行 id 是固定的，删了才能按新口径重插）。迁移 `0004` 已经删过一次，
-- 但 seed 在迁移**之后**跑，会把它们再插回来——所以收敛点必须放在 seed 里。
DELETE FROM "mn_risk_matter_node"
WHERE "risk_matter_id" IN (8301, 8302, 8303, 8304) AND "source_kind" = 'preset';

INSERT INTO "mn_risk_matter_node"
  ("id", "risk_matter_id", "node_type_id", "name", "time_type", "start_time", "end_time", "is_time_confirmed",
   "status", "source_kind", "sort_order", "owner_id", "created_by", "updated_by")
VALUES
  (8501, 8301, 4101, '风险评估', 'point', now() - interval '5 days', NULL, true, 'completed', 'manual', 1, 101, 101, 101),
  (8502, 8301, 4102, '处置执行', 'point', now(), NULL, true, 'in_progress', 'manual', 2, 101, 101, 101),
  (8503, 8302, 4101, '风险评估', 'point', now() + interval '2 days', NULL, true, 'not_started', 'manual', 1, 101, 101, 101),
  (8504, 8303, 4102, '处置执行', 'point', now() + interval '1 day', NULL, true, 'not_started', 'manual', 1, 101, 101, 101)
ON CONFLICT ("id") DO NOTHING;

-- 转案件关联：事项的"来源"靠这张表反查，宿主表上没有 source_risk_id（修订稿 §6.3）
INSERT INTO "mn_risk_matter_case" ("id", "risk_matter_id", "matter_id")
VALUES (8601, 8301, 7002)
ON CONFLICT ("risk_matter_id", "matter_id") DO NOTHING;

-- ── 进展与评论 ─────────────────────────────────────────
INSERT INTO "mn_matter_progress"
  ("id", "matter_id", "node_id", "progress_type", "content", "progress_date", "next_plan", "author_id", "created_by", "updated_by")
VALUES
  (8701, 7001, 8202, 'material_filing', '整理完成一期签证单与监理日志，共 214 页，已编目移交鉴定机构。',
   (now() - interval '5 days')::date, '等待鉴定意见初稿，预计下周到达。', 101, 101, 101),
  (8702, 7002, NULL, 'court_action', '二审提交答辩状并申请鉴定人出庭。',
   (now() - interval '2 days')::date, '开庭前完成证据清单二次核对。', 101, 101, 101),
  (8703, 7004, 8208, 'counterparty', '对方补充提交放款凭证三份，需核对放款条件成就时间。',
   (now() - interval '3 hours')::date, '开庭当日申请庭后对账。', 101, 101, 101)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "mn_comment" ("id", "target_type", "target_id", "body", "author_id", "created_by", "updated_by")
VALUES
  (8801, 'matter', 7001, '签证单里的三份缺监理签字，先按无争议部分主张，避免拖举证期。', 101, 101, 101),
  (8802, 'matter', 7001, '收到，已在举证清单里单列，并在开庭前请法院确认补正方式。', 101, 101, 101),
  (8803, 'matter', 7004, '仲裁庭对提前到期的约定利息口径较严，违约金部分建议调低主张额。', 101, 101, 101),
  (8804, 'risk_matter', 8302, '账号回收已完成，脱敏视图待运维排期，预计本周五前上线。', 101, 101, 101)
ON CONFLICT ("id") DO NOTHING;

-- ── 活动日志：覆盖 CRUD / 状态 / 归档三类载荷形态 ─────────
INSERT INTO "mn_activity_log"
  ("id", "target_type", "target_id", "matter_id", "risk_matter_id", "operator_id", "action", "field_diffs", "payload", "reason", "created_at")
VALUES
  (8901, 'matter', 7001, 7001, NULL, 101, 'MATTER_CREATED', NULL, NULL, NULL, now() - interval '6 days'),
  (8902, 'matter', 7001, 7001, NULL, 101, 'STATUS_CHANGED', '{"status":{"from":"pending","to":"in_progress"}}', NULL, NULL, now() - interval '6 days'),
  (8903, 'matter_node', 8202, 7001, NULL, 101, 'NODE_UPDATED', '{"status":{"from":"not_started","to":"in_progress"}}', NULL, NULL, now() - interval '5 days'),
  (8904, 'matter', 7005, 7005, NULL, 101, 'STATUS_CHANGED', '{"status":{"from":"in_progress","to":"closed"}}', NULL, '执行款部分到位并达成以物抵债外的分期方案', now() - interval '9 days'),
  (8905, 'matter', 7005, 7005, NULL, 101, 'NODE_CANCELLED', '{"status":{"from":"not_started","to":"cancelled"}}', NULL, '双方改按分期履行，无需以物抵债', now() - interval '10 days'),
  (8906, 'matter', 7006, 7006, NULL, 101, 'ARCHIVED', '{"status":{"from":"closed","to":"archived"}}', NULL, '调解书已履行完毕，按归档流程处理', now() - interval '8 days'),
  (8907, 'risk_matter', 8301, NULL, 8301, 101, 'RISK_CREATED', NULL, NULL, NULL, now() - interval '5 days'),
  (8908, 'risk_matter', 8301, 7002, 8301, 101, 'CONVERTED_TO_CASE', NULL, '{"case_ids":["7002"],"from":"FX-20260922-001"}', NULL, now() - interval '6 days'),
  (8909, 'matter', 7004, 7004, NULL, 101, 'PROGRESS_CREATED', NULL, NULL, NULL, now() - interval '3 hours'),
  (8910, 'matter', 7001, 7001, NULL, 101, 'COMMENT_CREATED', NULL, NULL, NULL, now() - interval '4 days')
ON CONFLICT ("id") DO NOTHING;

-- ── 发号器与演示编号对齐：不写这行，后续真实取号会撞上演示号 ────
INSERT INTO "mn_code_seq" ("day_key", "prefix", "value")
VALUES
  ('2026-09-10', 'AJ', 1),
  ('2026-09-18', 'AJ', 1),
  ('2026-09-21', 'AJ', 2),
  ('2026-09-22', 'AJ', 1),
  ('2026-09-23', 'AJ', 1),
  ('2026-09-25', 'AJ', 1),
  ('2026-09-15', 'FX', 1),
  ('2026-09-22', 'FX', 1),
  ('2026-09-24', 'FX', 1),
  ('2026-09-26', 'FX', 1)
ON CONFLICT ("day_key", "prefix") DO NOTHING;

-- ── 停用态演示行（user story 28：「每一页至少有一行是停用状态」）────────────
--
-- ## 为什么这几行住在**演示** seed 而不是 0000 / 0002 那两份
--
-- 那两份是**全环境** seed（生产也跑）：状态集的八行是状态机的定义，往里塞一个停用态
-- 会让生产也长出一个"不可选"的状态；费用项目同理（`item_id` 是真外键，历史行照常显示）。
-- 「演示数据里能看到停用态」是**看库时的演示需要**，不是状态机的定义 ——
-- 所以它属于唯一那份仅 dev 的 seed（本文件头注：生产环境不参与部署）。
--
-- ## 两条硬约束（都实测过，不是风格）
--
-- 1. **状态行必须 `next_status_codes = '{}'`**：`db:check` 的 C13 断言
--    「恰好 6 行非空」（8 个内置态里两宿主的归档态留空）。带后继的停用态会让它变 7 而红。
--    语义上也该如此 —— 停用态不可被选为后继，它不是路径上的一站。
-- 2. **不能是初始态、也不能碰归档语义**：C11 断言每宿主恰好 1 个初始态 + 1 个归档态，
--    而两处 partial unique index 分别兜底。这一行取 `semantics='custom'`。
--
-- id 用 47xx（4601+ 是费用项目、50xx 标签、60xx+ 演示业务数据），与其余 seed 同一条低号段规矩。
INSERT INTO "mn_status_config"
  ("id", "code", "name", "color", "host_type", "semantics", "is_system", "is_initial_status", "next_status_codes", "sort_order", "is_enabled")
VALUES
  (4701, 'suspended_demo', '已暂缓', 'gray', 'matter', 'custom', false, false, '{}', 99, false),
  (4702, 'suspended_demo', '已暂缓', 'gray', 'risk_matter', 'custom', false, false, '{}', 99, false)
ON CONFLICT ("host_type", "code") DO NOTHING;

-- 费用项目：一个停用项。它不在上面 0004 的九项里，所以 `ON CONFLICT ("code")` 不会撞。
-- 「可停用、不可删」是那张表的契约（`is_system = true` 保持不变）——停用后新费用选不到它，
-- 历史行照常显示项目名（这正是"停用而非删除"要保住的东西）。
INSERT INTO "mn_expense_item_config" ("id", "code", "name", "sort_order", "is_system", "is_enabled")
VALUES
  (4660, 'arbitration_fee_demo', '仲裁费', 99, true, false)
ON CONFLICT ("code") DO NOTHING;

-- 风险等级：一个停用等级（同样只是演示行）。表没有 `color` 列 —— 细项页因此没有颜色列可画，
-- 与另外四张配置表不同，那是库的形状不是页面的取舍。
INSERT INTO "mn_risk_level_config" ("id", "code", "name", "sort_order", "is_system", "is_enabled")
VALUES
  (3004, 'negligible_demo', '无风险', 99, true, false)
ON CONFLICT ("code") DO NOTHING;

-- 标签：一个停用标签，供标签细项页看见停用态（同样只是演示行）。
INSERT INTO "mn_tag" ("id", "name", "host_type", "color", "sort_order", "is_enabled")
VALUES
  (5005, '已归档标签', 'matter', 'gray', 99, false)
ON CONFLICT ("host_type", "name") DO NOTHING;

-- 通知模板 8 条（B5 定稿，`docs/PRD-phase1-g-targets-b5-draft.md` 第二部分）
--
-- 文案**逐字照抄**，唯一一处偏差：`node_end` 正文里的 `**这是硬期限**` 去掉星号。
-- 定稿里那对星号是 Markdown 强调（它写在一份 .md 里），而通知正文在界面上是**纯文本**，
-- 原样入库会让用户看到字面的 `**`。强调的词（"这是硬期限"）保留，只去掉标记符。
-- 占位符沿用 payload 字段：{code} {name} {from} {to} {node} {time} {actor} {quoted} {last} {days} {missing}。
-- id 用 70xx 低号段：seed 要跨环境逐字重放（§2.4 末行）。
--
-- ⚠ 这段原先写在迁移 0010 里，本文件是**搬过来的**（本仓惯例：结构进迁移、数据进 seed）。
-- seed 每次 `db:seed` 都全量重放、不记账本，所以必须幂等 —— 靠 `ON CONFLICT ("code") DO NOTHING`。
--
-- ## 2026-10-21：标题去掉「【MatterNest】」前缀
--
-- 前缀是**渠道品牌标记**：同一条模板将来还要服务 `email` 渠道（表约束里 `channel` 有
-- 'email'，只是今天还没有 email 模板、也没有代码路径）。站内通知却是显示在
-- MatterNest 自己的界面里，标题前缀等于「在自家门口再报一次自家名字」——八行
-- 列表每行都顶着一个方括号块，案号被推到中间，是纯噪声。
--
-- ⇒ **前缀在模板层去掉，而不是在渲染层剥**：渲染层剥只治站内这一屏，将来 email
-- 渠道从同一张表取模板时会连品牌标记一起丢。模板按渠道各存一份（唯一键是
-- `event_type + channel`），渠道之间互不干扰。
--
-- ⚠ **存量库不会自动变**：`ON CONFLICT ("code") DO NOTHING` 只保证不重复插入，
-- 不会把已入库行的 `title_tpl` 改回新值。所以下面紧跟一条 UPDATE 负责把
-- 「带前缀」的旧标题就地改成不带前缀的版本——它只动 `title_tpl` 里带前缀的行，
-- 管理员手改过标题的库不受影响（那种行的标题本来就不带前缀，条件不命中）。
INSERT INTO "mn_notification_template"
  ("id", "code", "event_type", "channel", "title_tpl", "body_tpl", "is_enabled")
VALUES
  (7001, 'status_changed', 'status_changed', 'in_app',
   '{code} 状态已变更',
   '{name}：{from} → {to}（{actor}）。点进查看，偏离推荐路径的原因已记入日志。', true),
  (7002, 'comment_new', 'new_comment', 'in_app',
   '{code} 有新评论',
   '{actor} 在「{name}」发布了评论，回复或被 @ 请点进查看。', true),
  (7003, 'mention', 'mention', 'in_app',
   '{actor} 在评论中提到了你',
   '「{name}」（{code}）："{quoted}" —— 回复即接手。', true),
  (7004, 'node_start', 'node_due_start', 'in_app',
   '{code} 的节点「{node}」将于 {days} 天后开始',
   '计划 {time}。请确认准备就绪；无法如期请在节点上更新。', true),
  (7005, 'node_end', 'node_due_end', 'in_app',
   '{code} 的节点「{node}」还有 {days} 天到截止',
   '期限 {time}——这是硬期限（举证/开庭/答复期）。如无法完成请立即联系经办人处置。', true),
  (7006, 'stale_30d', 'stale_30d', 'in_app',
   '案件 {code} 已 30 天无进展',
   '「{name}」自 {last} 后无任何人工更新。请录一条进展，或调整经办人。', true),
  (7007, 'case_archived', 'risk_converted', 'in_app',
   '{code} 已归档',
   '「{name}」进入只读终态（规则自动或 {actor} 手动）。如需补记执行回款等事项，由 full_admin 撤销归档。', true),
  (7008, 'archive_incomplete', 'archive_incomplete', 'in_app',
   '{code} 已结案但归档材料不全',
   '「{name}」缺：{missing}（结案后 14 天未补齐）。请补录后归档；确无法补齐的，归档时写明原因。', true)
ON CONFLICT ("code") DO NOTHING;

-- 存量行去前缀：只命中「标题以【MatterNest】开头」的行，逐条改成去掉前缀的同款文案。
-- 幂等：改完再跑一次，条件不再命中（标题已不带前缀），零行变更。
--
-- ⚠ **按字符切，不按字节**：`substr` 的起点参数在 PostgreSQL 里是**字符数**，
-- 而「【MatterNest】」是 12 个字符 / 16 个 UTF-8 字节。按 16 切会多切掉标题里的
-- 4 个汉字（字节数 ≠ 字符数），这里必须写 13（= 前缀 12 字符 + 1）。
UPDATE "mn_notification_template" SET "title_tpl" = substr("title_tpl", 13)
WHERE "channel" = 'in_app' AND "title_tpl" LIKE '【MatterNest】%';


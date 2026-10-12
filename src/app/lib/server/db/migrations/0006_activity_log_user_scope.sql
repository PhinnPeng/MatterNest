-- 0006：审计日志容纳账号维度的动作（MATT-10 前置，2026-10-12）
--
-- 为什么需要这条：MATT-10「用户与角色页 + 待批队列」的第一件活是**开通本地凭据**——
-- 审计 F1 撤掉 seed 下发的口令摘要之后，六个内置账号全都登不进去，而设置凭据的唯一
-- 入口就是这张票（F6-9）。但这条路的每一步都要落审计，于是撞上两道库里写死的约束。
--
-- 下面两行是**实测**出来的，不是读代码推的（探针逐条试插，只加/不加 host 列对照）：
--
--   ①  target_type='app_user'、不带 host 列  → ck_mn_activity_host 拒绝
--   ②  action='USER_ACTIVATED'、不带 host 列 → ck_mn_activity_host 拒绝
--   ③  target_type='app_user'、带 host 列    → ck_mn_activity_target_type 拒绝
--   ④  action='USER_ACTIVATED'、带 host 列  → 允许
--   ⑤  action='ROLE_CHANGED'、带 host 列    → 允许
--
-- 读出来三件事：
--   · **action 值域已经有 `USER_ACTIVATED` 与 `ROLE_CHANGED`**（⑤ 与 ④），注册表里也在。
--     规格早就写好了（PRD F6-11「管理员批准并当场指定角色，写 USER_ACTIVATED」），
--     只是没人走到这条路，所以约束宽松与否一直没被察觉。**不需要动 action。**
--   · `ck_mn_activity_host` 写死了「每条日志必须挂在某个案件或事项上」，
--     于是**账号维度的动作无处可写**——这是第一道门。
--   · `ck_mn_activity_target_type` 的六个取值里没有 `app_user`，这是第二道门。
--
-- ⚠ 只放宽**到账号维度为止**，业务对象的约束一点没松：
--   新 CHECK 仍然要求 matter/risk_matter 宿主列非空，只是额外放行 `target_type='app_user'`。
--   案件、事项、节点、进展、费用五条线的日志仍然必须带宿主列，
--   也就是说「事件流必须挂在一个真实业务对象上」这条原意**完整保留**。
--
-- 顺带记一笔：`mn_app_user_credential` 表至今不存在——规格写「凭据一律外挂」，
-- 而实现把口令摘要挂在 `mn_app_user.password_hash`（可空列）。MATT-10 的凭据管理
-- 就落在这个列上；是否补一张外挂凭据表是**另一张票**，不在本条迁移范围内。
--> statement-breakpoint

-- 第一道门：target_type 增加账号维度。既有六个取值一个不动。
-- ⚠ 写法必须与 0000 同形（`col IN (...)`），不能用 `= ANY(ARRAY[...])`：
--   `enum-check.spec.ts` 的解析器只认 IN 形状，写成 ANY 它就**整条漏读**，
--   于是拿 0000 的旧六值来比对，报「值数量不同: expected 6 to be 7」——
--   失败信息指向一个"根本没改过"的约束名，极难自查。
ALTER TABLE "mn_activity_log"
  DROP CONSTRAINT IF EXISTS "ck_mn_activity_target_type";
--> statement-breakpoint
ALTER TABLE "mn_activity_log"
  ADD CONSTRAINT "ck_mn_activity_target_type"
  CHECK (target_type IN ('matter','risk_matter','matter_node','risk_matter_node','matter_progress','matter_expense','app_user'));

--> statement-breakpoint
-- 第二道门：宿主列约束放宽到「业务对象仍必须有宿主，账号维度除外」。
-- 写成 target_type='app_user' 而不是「三个宿主列都空就放行」——后者会让一条
-- target_type 填错、宿主列漏填的行悄悄合法，那正是这条约束当初要挡的。
ALTER TABLE "mn_activity_log"
  DROP CONSTRAINT IF EXISTS "ck_mn_activity_host";
--> statement-breakpoint
ALTER TABLE "mn_activity_log"
  ADD CONSTRAINT "ck_mn_activity_host"
  CHECK (
    ("matter_id" IS NOT NULL)
    OR ("risk_matter_id" IS NOT NULL)
    OR (("target_type")::text = 'app_user'::text)
  );
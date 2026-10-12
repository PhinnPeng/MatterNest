-- 内置角色与演示账号（W1-6 seed 的身份部分；角色清单权威源 = 权限草案 §2）
--
-- 三条口径写在这里，因为它们都会被"顺手改一下"破坏：
--   1. 角色与用户是**多对多**（`mn_app_user_role`）。§2 明写"既要管系统又要能撤销归档的人，
--      给他 sys_admin + full_admin 两个角色，靠取最宽并集生效" ⇒ 用户表上没有 role_id 列。
--   2. id 用预留低号段（10–14 / 101–106），不用雪花值：seed 要跨环境逐字重放。
--   3. **`password_hash` 刻意不下发**（审计 F1，2026-10-12）。原来这里是"口令等于用户名"的
--      演示摘要，明文写在 git 跟踪的 SQL 里——拿到仓库就等于拿到全部口令，而 `wangkf`
--      是 `is_admin=true`、直接短路范围谓词。现在账号建成即"没有可用口令"（该列可空，
--      `verifyPassword` 对 null 返回 false），**任何人都无法用仓库里的信息登入**。
--      口令由部署时另行设置，不属于 seed 的职责。
--
-- `sys_admin` 的数据范围刻意是 owned(L3) 而不是 all(L1)：在"可见即可操作"下范围就是读权限，
-- 这样"能管系统但看不到别人案卷"才成立（§2 注）。
INSERT INTO "mn_role" ("id", "code", "name", "data_scope", "can_unarchive", "can_read_plain", "can_manage_user", "can_manage_config", "is_system")
VALUES
  (10, 'sys_admin', '系统管理', 'owned', false, false, true, true, true),
  (11, 'full_admin', '全局管理', 'all', true, true, false, false, true),
  (12, 'full_operator', '全局经办', 'all', false, false, false, false, true),
  (13, 'joined_operator', '参与经办', 'participating', false, false, false, false, true),
  (14, 'self_operator', '承办经办', 'owned', false, false, false, false, true)
ON CONFLICT ("code") DO NOTHING;

-- 六个演示账号：总经理 / 风控总监 / 项目负责人两名 / 专员 / IT
-- 覆盖到 L1/L2/L3 三档，才能当场看出"同一条案件不同人看到不一样"
-- `is_admin` 只给总经理一个人（权限草案 §3：独立于角色的最后开关，仅 1–2 人）。
-- 它**只**绕过数据范围，不给任何特权；写 seed 而不是留人手工 UPDATE，是为了让
-- "重放一次 seed 就有可用逃生口"成立——真出事时手上要有能跑的东西。
INSERT INTO "mn_app_user" ("id", "username", "display_name", "is_enabled", "is_admin", "activation_status")
VALUES
  (101, 'wangkf', '王凯锋', true, true, 'active'),
  (102, 'lichen', '李晨', true, false, 'active'),
  (103, 'zhaolj', '赵凌', true, false, 'active'),
  (104, 'suny', '孙奕', true, false, 'active'),
  (105, 'hezp', '何哲培', true, false, 'active'),
  (106, 'qiangl', '强玲', true, false, 'pending')
-- ⚠ **`password_hash` 刻意不在 DO UPDATE 的赋值列表里**（审计 F2，2026-10-12）。
--
-- 原来是 `DO UPDATE SET "password_hash" = excluded."password_hash", ...`，后果是：
-- **谁在生产重放一次 seed，所有改过的口令全部打回「用户名=用户名」**，
-- 而 `wangkf` 是 `is_admin=true`，直接短路范围谓词。一次 `pnpm db:seed` 就全线失守。
--
-- 口令是**不属于 seed 的东西**：seed 负责演示配置，不负责身份凭据。
-- 生产改过口令之后再重放 seed，库里现值必须原样保留。
ON CONFLICT ("username") DO UPDATE SET "is_admin" = excluded."is_admin", "display_name" = excluded."display_name";
-- 上面这行是 DO UPDATE 而不是 DO NOTHING：口令摘要与显示名都属于"可重放的演示配置"，
-- 首轮 seed 我算错过一次摘要（把用户名拼成 `用户名@MatterNest-demo` 去哈希，
-- 而校验函数哈希的是口令本身），DO NOTHING 会让错值永远留在库里、登录恒定 401。
-- 演示账号的口令 = 用户名，仅 dev 可用。

-- 角色映射。103 兼两个角色，用来验证 §2 的"并集"：他既是全局经办又能撤销归档
--
-- 104 孙奕（专员）**必须**是纯 L2：全套账号里若没有一个 `participating`，
-- `visibility()` 的 `EXISTS (… *_staff)` 那一条在真实登录链路上永远走不到。
-- 这不是假想：本轮冒烟就是给不出 L2 账号，才让那句 SQL 少一层括号（drizzle
-- `exists()` 只对 QueryBuilder 自动加括号，传 `sql` 模板要自己写）而没人发现。
-- 改 seed 里的角色时请保留"至少一个纯 L1 / 一个纯 L2 / 一个纯 L3"这个分布。
INSERT INTO "mn_app_user_role" ("id", "user_id", "role_id")
VALUES
  (201, 101, 11),
  (202, 102, 12),
  (203, 103, 13),
  (204, 103, 11),
  (205, 104, 13),
  (206, 105, 10),
  (207, 106, 14)
ON CONFLICT ("id") DO UPDATE SET user_id = excluded.user_id, role_id = excluded.role_id;
-- 冲突键用 `id` 而不是 `("user_id","role_id")`：改一个账号的角色时（本轮把专员从 L3 改成 L2），
-- 复合键会指到**另一行**上去，于是这条 INSERT 撞的是主键 205 而不是复合键 ——
-- 用复合键做目标等于"重放一次 seed 就崩"。行 id 才是这条映射的稳定身份。
-- 同样用 DO UPDATE：角色映射是演示配置，首轮配错过（比如把专员写成 L3）就该在重放时被纠正过来，
-- 否则"L2 分支没人踩过"这种盲区会一直留着。

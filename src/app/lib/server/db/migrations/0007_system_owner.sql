-- 0007：系统所有者标记 + 全局唯一（2026-10-12，MATT-53 / 凭据生命线落地）
--
-- ① 为什么是**新列**而不是复用 `is_admin`
--
--    `is_admin` 是权限草案 §3 的**逃生口**：语义只有"绕过数据范围"，且刻意不给任何特权。
--    它是谓词的一个输入（`visibility()` 见 isAdmin 就 return undefined）。
--    系统所有者是**凭据生命线的持有者**：语义是"谁能启动恢复"。它是身份本身。
--
--    绑成一列的后果：改"谁有逃生口"就得同步改"谁能恢复系统"，而两件事的变更频率与
--    审批级别都不同。更实际的问题——`is_admin` 正被 `selectable-users`
--    （提交 07d8c4d）当范围短路用，动它的语义会连带改那套谓词。
--
--    实测旁证：`is_admin` 当前恰好只有 1 人为 true，但它是**布尔列，没有唯一约束**，
--    同时标两个人不会报错。所以"admin 是那个人"目前只是口头共识，没有任何东西在守。
--
-- ② 全局唯一怎么落
--
--    用 **partial unique index**，不是表级 CHECK：
--      `create unique index uk_mn_app_user_owner on mn_app_user (is_system_owner)
--         where is_system_owner;`
--    为什么不是 CHECK：CHECK 只能断言"这一行合法"，表达不了"全表只有一行合法"。
--    partial unique 才能把"全局至多一个"变成一条会当场报错的不变式。
--    用 `is_system_owner` 作索引列而不是常量占位，是为了让第二个 true 直接撞
--    `duplicate key value violates unique constraint`——错误信息里就写着索引名，
--    调用方与运维都能一眼看出撞的是哪条不变式。
--
-- ③ 交接是唯一出路
--
--    移交时必须**先清旧持有者再授新持有者**，否则撞上面那条唯一索引。
--    这不是缺陷而是设计：把"先撤再授"变成显式的一步，比允许"同时存在两个所有者"
--    再靠应用层去猜谁算数要安全得多。界面必须让这一步做得出来，
--    不能把人逼到直接改库（同票据此判定）。
--
-- ④ 物理删除**不实现、也不设守卫**（一期）
--
--    规格里没有"删除用户"这条路：F6-1 是「用户列表与启停」，F6-10 离职回收走
--    `is_enabled=false`。所以本迁移不加任何删除守卫——给一条不存在的路径写守卫
--    等于写死代码。停用守卫落在 F6-1 的入口上，见票据 53 的扩写判据。
--> statement-breakpoint
ALTER TABLE "mn_app_user" ADD COLUMN "is_system_owner" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- 存量账号一律先置 false，然后只把当前唯一的管理员提为所有者。
-- 用 CASE 而不是直接 UPDATE 单人：这样"恰好有多个 true"的老库也能被收敛成
-- 至多一个（取 id 最小的那个），不会在迁移中途撞上刚建的唯一索引。
UPDATE "mn_app_user"
   SET "is_system_owner" = (id = (SELECT min(id) FROM "mn_app_user" WHERE "is_admin"))
  WHERE "is_admin";
--> statement-breakpoint
-- 收回多余标记：万一同一个库里原本已经有两个 is_admin，上面那步只会提拔一个，
-- 这一行兜底把其余显式清回 false（本应已被 CASE 覆盖，双保险）。
UPDATE "mn_app_user" SET "is_system_owner" = false
 WHERE "is_system_owner"
   AND id <> (SELECT min(id) FROM "mn_app_user" WHERE "is_system_owner");
--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_app_user_owner"
  ON "mn_app_user" ("is_system_owner")
  WHERE "is_system_owner";
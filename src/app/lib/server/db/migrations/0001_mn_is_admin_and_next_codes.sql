-- 0001：is_admin 逃生口 + next_status_codes 改型（2026-10-03，一期改进批次）
--
-- ① `mn_app_user.is_admin` —— drizzle 生成。权限草案 §3 要求的最后开关，
--    0000 基线漏建了列，于是"误删角色导致无人可管"这条逃生口一直只存在于纸面。
--> statement-breakpoint
ALTER TABLE "mn_app_user" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- ② `mn_status_config.next_status_codes` —— **手写补丁**（① 之外唯一一条人写的）。
--    0000 基线把它建成了 `text`，而 schema 与两侧快照都是 `text[]`（`text(...).array()`），
--    所以下一次 `db:generate` 也不会再给出任何 diff —— 这个偏差只能在这里显式改型。
--    实测形态不是"读出来是字符串"这种隐性问题，而是 seed 一写就红：
--    `42804: 类型 text[] 的表达式不能赋给类型 text 的列`。
--    老库里的历史值是 `'{}'` 这种数组字面量文本，走 text→text[] 的 I/O 转换正好；
--    NULL 兑成空数组 = 不限制（修订稿 §3.1 的语义）。DEFAULT 也要跟着改型，
--    否则新行仍按 `'{}'::text` 写，改型等于白做。
ALTER TABLE "mn_status_config" ALTER COLUMN "next_status_codes" TYPE text[]
  USING COALESCE("next_status_codes"::text[], '{}'::text[]);
--> statement-breakpoint
ALTER TABLE "mn_status_config" ALTER COLUMN "next_status_codes" SET DEFAULT '{}'::text[];

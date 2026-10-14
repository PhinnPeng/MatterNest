-- 定时器心跳的**初始行**（MATT-83；结构见迁移 0015）
--
-- ## 为什么初始行必须在 seed 里
--
-- 新库 `pnpm db:migrate` 之后 `pnpm db:check` 立刻要跑（CI 就是这么跑的），
-- 那时定时器还没跑过。如果表里**没有行**，探针能拿到的只有一个"空"——
-- 而"空"既可能是"定时器还没跑"，也可能是"迁移或 seed 没跑"，两者处置方向不同。
-- 探针于是只能报一句谁都看得见、指向不了任何地方的「心跳缺失」。
--
-- 有这一行之后，`db:check` 的 C18 能报**具体**的一件事：
-- 「行在、`created_at IS NULL` ⇒ 定时器从未运行 ⇒ 看 `src/instrumentation.ts`」。
-- ⚠ 所以这行**不是**为了让新库变绿（新库上「从未跑过」本来就是红，那是正确信号），
-- 而是为了让那句红**说得准**。
--
-- ## 为什么是 `ON CONFLICT ("id") DO NOTHING` 而不是 DO UPDATE
--
-- `mn_timer_heartbeat` 只有一行（`CHECK (id = 1)` + 主键），seed 每次全量重放。
-- 用 DO UPDATE 的话，**每一次 `pnpm db:seed` 都会把活的 `created_at` 抹回 NULL**：
-- 部署期重放一次 seed，监控上就凭空出现一次「定时器从未运行」，运维会去查一个
-- 根本不存在的故障。DO NOTHING 才是对的语义：这行只落一次，之后归泵所有。
--
-- ## 列口径
--
-- `created_at` 空 = 从未跑过（迁移 0015 的文件头写了三种状态）；
-- `pump_count` 0 = 还没有一次成功的 pump。两者都由泵在同一句 UPDATE 里前进。
INSERT INTO "mn_timer_heartbeat" ("id", "created_at", "pump_count")
VALUES (1, NULL, 0)
ON CONFLICT ("id") DO NOTHING;

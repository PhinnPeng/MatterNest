-- 0009：对手方档案的身份列——密文列 + 查重盲索引 + 合并列（MATT-40，2026-10-14）
--
-- 背景：`mn_party` 此前只有 13 列，证件号是**明文 varchar(64)**、没有任何"合并"的痕迹。
-- M3 把当事人重定义为**对手方档案**（IQ-7 / Q24=B：只有对方与第三人，我方=本企业永不入表），
-- 于是三件事同时要落库：
--
--   ① 证件号/手机号**加密存储**（B7 三重防线的存储层那一层）⇒ 列改成存密文信封，类型放宽到 text；
--   ② **查重仍要精确**（F3-3：名称模糊 + 证件号精确）⇒ 明文唯一索引必须换成盲索引列上的唯一索引；
--   ③ **合并**（F3-9 新增）⇒ 被并方要能指出主记录是谁、什么时候并的。
--
-- 为什么唯一索引必须换列而不是"加密了继续索引明文"：AES-256-GCM 带随机 IV，
-- 同一个证件号每次写入的密文都不同，`uk (type, id_number)` 从此既不唯一也不可查
-- —— 表面上看约束还在，实际它一条都不拦（这种"约束还在但不生效"最难发现）。
-- 所以唯一性改挂 `id_number_hash`（带密钥的 HMAC-SHA256 hex），**查重口径逐字不变**：
-- 仍然是 `(type, 完整证件号)` 精确相等、仍然放过 NULL（未填证件号的两家小公司可以并存）。
--
-- ⚠ **存量行不回填**（本迁移做不到，也不该在这里做）：把明文加密成密文需要应用侧的
--    `MN_AES_KEY`，而密钥**不许进迁移文件**（技术选型 §6：密钥不入库、不进镜像）。
--   迁移后库里的状态是：老行的 `id_number` 仍是明文、`id_number_hash` 为 NULL。
--   读路径对"没有信封的值"原样返回（`field-crypto.ts` 的过渡读法），所以界面照常；
--   查重路径额外兼容"hash 为空但明文相等"的老行，所以也不会因此多建一份档案。
--   **回填是一次性运维动作**（`node … ` 读行 → encryptField/blindIndex → update），
--   回填完那段过渡读法就该删。谁来做回填见交付报告第 4 节。
--
-- 索引变更（修订稿 §8.2 的 party 行：`(name)` + `(id_number_hash)`）：
--   · `uk_mn_party_identity` 从 `(type, id_number)` 改挂 `(type, id_number_hash)`；
--   · 新增 `ix_mn_party_merged_into`（partial，只索引被并方那几行）。
--
-- DOWN（前滚优先，但人要看得懂丢了什么）：
--   DROP CONSTRAINT "ck_mn_party_merged_shape"; DROP CONSTRAINT "mn_party_merged_into_id_mn_party_id_fk";
--   DROP INDEX "ix_mn_party_merged_into"; DROP INDEX "uk_mn_party_identity";
--   ALTER TABLE "mn_party" ALTER COLUMN "id_number" TYPE varchar(64);  -- ⚠ 会截断密文，等于丢掉证件号
--   ALTER TABLE "mn_party" ALTER COLUMN "contact" TYPE varchar(100);
--   DROP COLUMN "id_number_hash", "merged_into_id", "merged_at";
--   CREATE UNIQUE INDEX "uk_mn_party_identity" ON "mn_party" ("type","id_number");
--   ⇒ **不可逆**：回退会丢掉全部已加密的证件号与手机号（密文截断后连解密都做不到）。
--> statement-breakpoint

-- ① 盲索引列。先加列再建索引：新列全 NULL，PG 对 NULL 互不相等的处理与旧口径一致，
--    所以这条在存量数据上不会因为"两行都没证件号"而失败。
ALTER TABLE "mn_party" ADD COLUMN "id_number_hash" varchar(64);
--> statement-breakpoint

-- ② 两个敏感列改存密文信封。text 而不是更长的 varchar：信封长度随明文线性增长，
--    给一个"看起来够用"的上限，等于给未来的证件号格式埋一次截断事故。
ALTER TABLE "mn_party" ALTER COLUMN "id_number" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "mn_party" ALTER COLUMN "contact" SET DATA TYPE text;
--> statement-breakpoint

-- ③ 合并列：被并方指向主记录 + 合并时刻。主记录这两列恒为 NULL。
ALTER TABLE "mn_party" ADD COLUMN "merged_into_id" bigint;
--> statement-breakpoint
ALTER TABLE "mn_party" ADD COLUMN "merged_at" timestamp with time zone;
--> statement-breakpoint

-- ④ 唯一性换列（DROP 在 CREATE 之前，保证重放不因索引缺失而失败）。
DROP INDEX IF EXISTS "uk_mn_party_identity";
--> statement-breakpoint
CREATE UNIQUE INDEX "uk_mn_party_identity" ON "mn_party" USING btree ("type","id_number_hash");
--> statement-breakpoint

-- ⑤ 详情页反查"哪些档案并进了我"；partial 因为绝大多数行这一列是 NULL。
CREATE INDEX "ix_mn_party_merged_into" ON "mn_party" USING btree ("merged_into_id") WHERE merged_into_id IS NOT NULL;
--> statement-breakpoint

-- ⑥ 自引用外键：主记录被并进别处时不许被删（RESTRICT，与 §12.4"业务表一律 RESTRICT"一致）。
ALTER TABLE "mn_party" ADD CONSTRAINT "mn_party_merged_into_id_mn_party_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."mn_party"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- ⑦ 合并的形状约束（见 schema 侧同名 check 的注释：三条各挡一种真错）。
--    非枚举 CHECK，所以不在 `enum-check` 的登记表里 —— 那个解析器只认 `col IN (...)` 形态。
ALTER TABLE "mn_party" ADD CONSTRAINT "ck_mn_party_merged_shape" CHECK (merged_into_id IS NULL OR (merged_into_id <> id AND is_deleted));

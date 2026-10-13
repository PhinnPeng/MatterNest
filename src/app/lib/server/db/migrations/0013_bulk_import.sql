-- 0013：批量导入的两张表（F7-4 / M7 US-M7-1 / MATT-44，2026-10-13）
--
-- 权威出处：master F7-4 与 P14 行、`docs/PRD-phase1-alignment-m7-m8.md` US-M7-1（Q42=A）、
-- 枚举表 §3.5（`BULK_IMPORT` 载荷 `{host_type, total_rows, imported_rows, error_rows, report_ref}`）。
--
-- ## 为什么导入要落库（而不是"跑完把结果返回浏览器"）
--
-- 三条都是票面 AC 直接要求的，各自指向一个**必须事后还能读到**的事实：
--   ① 汇总日志的 `payload.report_ref` 要指向一份**还能下载的**错误报告；
--   ② 「同文件重导不产生重复行」要求知道"哪些内容已经导过"——那是跨请求的事实；
--   ③ 「逐行跳过」要求"哪一行为什么没进"能逐行回查，而不是一句"导入了 812 行"。
--
-- ## ① `mn_import_batch` —— 一次导入一条
--
-- 计数与状态在这里，`BULK_IMPORT` 的载荷与它同源（同一事务里写，不会出现
-- "日志说导了 812 行、批次记录说 810"）。
--
-- ⚠ **`host_type` 这个列名是继承来的**：§3.5 给 `BULK_IMPORT` 定的载荷键就叫 `host_type`，
--   而那是事后审计的查询契约，不该为了措辞改键名。代价是值域比 `HOST_TYPES`（E08/E10）
--   多一个 `party` —— 当事人档案**没有宿主**（`mn_party` 是跨宿主共享实体，F3-1）。
--   值域登记在 `src/shared/enums/import.ts` 的 `IMPORT_KINDS`，`STRUCT_CHECKS` 认领本文件的
--   两条 CHECK（`enum-check` 的反向检查要求"迁移里出现的 IN 型 CHECK 必须被注册表认领"）。
--
-- `status` 的 `running` 是**崩溃留下的痕迹**，不是正常中间态：正常一轮在收尾事务里
--   把计数与状态一起写。留着它是因为"上次这个文件没跑完"必须能从库里读出来 ——
--   那种批次**没有** `BULK_IMPORT` 汇总（汇总在收尾事务里写），只有这条记录能解释
--   为什么库里有半批数据、以及为什么重导会跳过其中一部分。
--
-- `created_by` **不建外键**：与 `mn_activity_log.operator_id` 同口径（审计物不指人）。
--   两张表都用"只有 `created_at`"的那组列（`createdOnlyColumns`）：导入记录没有编辑语义，
--   软删只会让"这批到底导过没"变成一个带条件的查询。
--
-- ## ② `mn_import_row` —— 文件里每一行一条（含成功行）
--
-- 报告只读 `skipped` 那批，**成功行也必须留**：幂等键挂在它们身上（见下面那条 partial unique）。
--
-- `uk_mn_import_row_content` 是幂等重放的**硬保证**：同一 `host_type` 下内容相同的行
--   不可能被导入两次。为什么不靠"服务层先查后插"：查与插之间有窗口，并发（双击提交、
--   两个标签页）时两边都能查到"没有"然后各插一条。冲突那一条由服务层 catch 成
--   "已导入"进报告，不是 500。partial（只索引 `imported`）是因为**未导入的行不占键**——
--   否则"把错行改对再传一次"会撞上自己上一轮的错误记录。
--
-- `host_id` **故意不建外键**：它按 `host_type` 指向三张不同的表（案件/事项/当事人），
--   而这张表的价值是"这一行进了哪条记录"，不是引用完整性。
--
-- `issues` 里**只记字段名、原因码与中文原因，绝不记单元格原值**：当事人行里可能有
--   **证件号**，而 `mn_party.id_number` 是加密列（B7 存储层防线）——把原值抄进一张
--   不加密的 jsonb 等于给加密开后门（与 `createParty` 不把证件号写进审计载荷同一条禁令）。
--   用户靠行号回 Excel 找那一格，不靠报告复述它。
--
-- DOWN（前滚优先，但人要看得懂丢了什么）：
--   DROP TABLE "mn_import_row"; DROP TABLE "mn_import_batch";
--   ⇒ **导入痕迹全丢**：`BULK_IMPORT` 日志仍在（它记的是计数），但它 `payload.report_ref`
--      指向的批次与报告就查不到了；幂等键一并消失 ⇒ 回退后重导同一份文件会**产生重复行**。
--      真要回退，先把两张表 `COPY … TO` 出去。
--> statement-breakpoint

CREATE TABLE "mn_import_batch" (
	"id" bigint PRIMARY KEY NOT NULL,
	"host_type" varchar(16) NOT NULL,
	"file_name" varchar(200) NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"imported_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'running' NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mn_import_batch_host" CHECK (host_type IN ('risk_matter','matter','party')),
	CONSTRAINT "ck_mn_import_batch_status" CHECK (status IN ('running','completed'))
);
--> statement-breakpoint

CREATE TABLE "mn_import_row" (
	"id" bigint PRIMARY KEY NOT NULL,
	"batch_id" bigint NOT NULL,
	"host_type" varchar(16) NOT NULL,
	"row_no" integer NOT NULL,
	"row_hash" varchar(64),
	"status" varchar(16) NOT NULL,
	"host_id" bigint,
	"issues" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mn_import_row_status" CHECK (status IN ('imported','skipped'))
);
--> statement-breakpoint

CREATE INDEX "ix_mn_import_batch_recent" ON "mn_import_batch" USING btree ("created_at","id");
--> statement-breakpoint

CREATE INDEX "ix_mn_import_row_batch" ON "mn_import_row" USING btree ("batch_id","row_no");
--> statement-breakpoint

-- 幂等键。`WHERE status = 'imported'` 是 partial：未导入的行不占键（见文件头）。
CREATE UNIQUE INDEX "uk_mn_import_row_content" ON "mn_import_row" USING btree ("host_type","row_hash") WHERE status = 'imported';
--> statement-breakpoint

-- 行随批次硬删（从属明细随宿主 CASCADE，§12.4）：批次是"这一次导入"的宿主，
-- 删批次时留着它的行等于留一批指不到批次的行。
ALTER TABLE "mn_import_row" ADD CONSTRAINT "mn_import_row_batch_id_mn_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."mn_import_batch"("id") ON DELETE cascade ON UPDATE no action;

-- 0018：附件通道（修订稿 §7.1 / A7，2026-10-22）
--
-- MinIO 服务账号到位后按 §7.1 建表。**这是单表管线**，不按宿主拆表：
-- 原文「附件属横切基础设施…否则签名 URL 签发、病毒扫描、留存策略要各写一份」。
--
-- ## 列口径（逐条照 §7.1）
--
--   · `owner_type` / `owner_id` —— 宿主（案件 / 事项），多态、无 DB 外键（§7.1 明写
--     「应用层校验；宿主删除时由服务层清理」）。CHECK 只拦到「业务对象」这一层，
--     与 `mn_comment.target_type` 同一个子集（`app_user` 不进：账号没有附件）。
--   · `comment_id` —— **规格表之外的一列**。§1.7 要 Comment 带 `attachment_ids [derived]`，
--     而 E03 `target_type` 是闭集且没有 `comment`；只靠 owner 分不出"这条附件属于哪条评论"。
--     给 E03 加一档要同时改 activity_log 的 CHECK、`visibility()` 与标签表，代价远大于一列。
--     于是：owner 仍指宿主（可见性直接复用 `scopedWhere`），comment_id 才是评论那一条的归属。
--   · `storage_key` —— 对象键 `att/<uuid>`，**不含业务含义、不用原名**，`UNIQUE`（§7.1）。
--   · `mime_type` —— 服务端按扩展名白名单自己定（不信客户端声明，见 `services/attachments.ts`）。
--   · `size_bytes` —— 单文件 ≤50MB 由服务层判；DB 只挡非正数。
--   · `checksum_sha256` —— 浏览器算好的小写十六进制；服务端只存不算
--     （预签名直传，文件不经过服务端。§7.1 的"事后异步校验"属下一票，这里先把事实留下）。
--   · `category` —— E26 闭集、可空：评论附件不需要分类；归档就绪的「裁判文书」
--     将来按 `judgment` 统计（本期**不接**，见 `services/archive-readiness.ts` 的注）。
--   · `related_node_id` —— §7.1 有，但本期没有"节点材料"视图，**不建空列**（建了没人写＝假能力）。
--
-- ## 软删
--
-- §7.1 原文：「`is_deleted` 保留对象以便审计追溯，物理清理由 B 组定义」——
-- 所以删除只改行（`deleted_at` / `deleted_by`），不删对象存储里的字节。
--
-- ## DOWN（前滚优先，但人要看得懂丢了什么）
--
--   DROP TABLE "mn_attachment";
--   ⇒ **元数据全丢**（文件字节还在桶里，但没有行能定位它们：`storage_key` 只剩一堆孤儿对象）。
--      真要回退，先 `COPY mn_attachment TO` 出去，或按桶内对象的 `att/` 前缀批量清理。
--> statement-breakpoint

CREATE TABLE "mn_attachment" (
	"id" bigint PRIMARY KEY NOT NULL,
	"owner_type" varchar(24) NOT NULL,
	"owner_id" bigint NOT NULL,
	"comment_id" bigint,
	"file_name" varchar(255) NOT NULL,
	"storage_key" varchar(255) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"category" varchar(24),
	"uploaded_by" bigint NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" bigint,
	CONSTRAINT "uk_mn_attachment_storage_key" UNIQUE("storage_key"),
	CONSTRAINT "ck_mn_attachment_owner_type" CHECK (owner_type IN ('matter','risk_matter','matter_node','risk_matter_node','matter_progress','matter_expense')),
	CONSTRAINT "ck_mn_attachment_category" CHECK (category IS NULL OR category IN ('evidence','complaint','judgment','contract','internal_doc','other')),
	CONSTRAINT "ck_mn_attachment_size" CHECK (size_bytes > 0)
);
--> statement-breakpoint
ALTER TABLE "mn_attachment" ADD CONSTRAINT "mn_attachment_comment_id_mn_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."mn_comment"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mn_attachment" ADD CONSTRAINT "mn_attachment_uploaded_by_mn_app_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mn_attachment" ADD CONSTRAINT "mn_attachment_deleted_by_mn_app_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."mn_app_user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- 列表恒带 `NOT is_deleted`，两条索引都走 partial（与 `ix_mn_comment_target` 同口径）。
CREATE INDEX "ix_mn_attachment_owner" ON "mn_attachment" USING btree ("owner_type","owner_id") WHERE NOT "mn_attachment"."is_deleted";
--> statement-breakpoint
CREATE INDEX "ix_mn_attachment_comment" ON "mn_attachment" USING btree ("comment_id") WHERE NOT "mn_attachment"."is_deleted";

import { attachmentUploadQuerySchema } from "@/shared/schema/attachments";
import { fail, json, query, withActor } from "@/app/lib/server/http";
import {
  AttachmentRejected,
  attachmentStorageReady,
  receiveCommentUpload,
} from "@/app/lib/server/services/attachments";
import { StorageUnavailableError } from "@/app/lib/server/storage/s3";

/**
 * `POST /api/attachments/upload` —— 上传一个附件（§7.1）。
 *
 * 元数据在查询串（`host/hostId/fileName/sizeBytes/checksumSha256`），字节在请求体。
 * 服务端校验后**流式转发**给对象存储，边转发边核大小与 SHA-256，然后落一行草稿
 * （`comment_id` 为 NULL）。评论提交时只收这个附件 id。
 *
 * ## 为什么不是预签名直传
 *
 * 社区版 MinIO 不实现桶级 CORS（`PutBucketCors` 固定 501），浏览器从 :3777 直传
 * :30090 会被预检拦死。服务级开关 `MINIO_API_CORS_ALLOW_ORIGIN` 要重启共享实例，
 * 不是应用能决定的事。完整理由见 `services/attachments.ts#receiveCommentUpload`。
 *
 * 状态码：400 类型/大小/校验值不合格；404 宿主不可见；409 归档或配额满；
 * 413 超过 50MB；503 对象存储未开通。
 */
export async function POST(req: Request) {
  const parsed = await query(req, attachmentUploadQuerySchema);
  if (!parsed.ok) return parsed.res;
  if (!req.body) return fail(400, "empty_body", "请求体为空，没有收到文件");

  return withActor(async (actor) => {
    if (!attachmentStorageReady()) {
      return fail(
        503,
        "storage_unavailable",
        "附件功能尚未开通（对象存储凭据未配置），请联系管理员",
      );
    }
    try {
      const out = await receiveCommentUpload(actor, parsed.data, req.body!);
      return json(out, 201);
    } catch (e) {
      if (e instanceof AttachmentRejected) {
        return fail(e.status, "attachment_rejected", e.message);
      }
      if (e instanceof StorageUnavailableError) {
        return fail(503, "storage_unavailable", e.message);
      }
      throw e;
    }
  });
}

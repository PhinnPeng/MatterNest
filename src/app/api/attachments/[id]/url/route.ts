import { fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";
import {
  attachmentStorageReady,
  signAttachmentDownload,
} from "@/app/lib/server/services/attachments";
import { StorageUnavailableError } from "@/app/lib/server/storage/s3";

/**
 * `GET /api/attachments/{id}/url` —— 取**短期下载签名**（§7.1）。
 *
 * 为什么不直接给对象 URL：桶是私有的，任何可下载的永久 URL 都等于把文件权限
 * 从"宿主可见性"降级成"知道链接就能下"。签名时服务端着 `scopedWhere` 再判一次
 * 宿主可见性（不可见与不存在同样 404），有效期按 `MINIO_PRESIGN_GET_SECONDS`（默认 60s）。
 *
 * 归档宿主照样可下载：§7.1 的只读说的是**不能改/不能删**，不是不能查证。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    if (!attachmentStorageReady()) {
      return fail(503, "storage_unavailable", "附件功能尚未开通（对象存储凭据未配置）");
    }
    try {
      const url = await signAttachmentDownload(actor, id);
      if (!url) return notFound();
      return json({ url });
    } catch (e) {
      if (e instanceof StorageUnavailableError) {
        return fail(503, "storage_unavailable", e.message);
      }
      throw e;
    }
  });
}

import { fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";
import { deleteAttachment } from "@/app/lib/server/services/attachments";
import { StorageUnavailableError } from "@/app/lib/server/storage/s3";

/**
 * `DELETE /api/attachments/{id}` —— 删除附件。
 *
 * **只软删行**：§7.1 原文「`is_deleted` 保留对象以便审计追溯，物理清理由 B 组定义」。
 * 所以这里不会去碰对象存储里的字节（唯一会删对象的地方是"评论没发出去"的补偿）。
 *
 * 权限：上传者本人、评论作者、或 L1/admin。**归档宿主一律不可删**（只读，§7.1）。
 * 不可见给 404、可见但不能删给 403 —— 与 `attributionRequired` 同一套分工：
 * 前者是"别来找这条"，后者是"你看见了，但这件事轮不到你"。
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    try {
      const result = await deleteAttachment(actor, id);
      if (result === null) {
        return notFound();
      }
      if (result === "forbidden") {
        return fail(
          403,
          "forbidden",
          "已归档的记录不能删除附件；其它情况下只有上传者或评论作者能删",
        );
      }
      return json({ ok: true });
    } catch (e) {
      if (e instanceof StorageUnavailableError) {
        return fail(503, "storage_unavailable", e.message);
      }
      throw e;
    }
  });
}

import { attachmentListQuerySchema } from "@/shared/schema/attachments";
import { json, notFound, query, withActor } from "@/app/lib/server/http";
import { listHostAttachments } from "@/app/lib/server/services/attachments";

/**
 * `GET /api/attachments?host=&hostId=&state=` —— 宿主级材料列表（2026-10-23）。
 *
 * 只列 `scope='host'` 的材料；评论附件已经在评论里展示，不在这里重复。
 * `state`：`active`（默认）/ `deleted`（作废）/ `all`。
 *
 * 不可见与不存在同样对待（404）：不给"存在但你没权"。
 */
export async function GET(req: Request) {
  const parsed = await query(req, attachmentListQuerySchema);
  if (!parsed.ok) return parsed.res;

  return withActor(async (actor) => {
    const out = await listHostAttachments(
      actor,
      parsed.data.host,
      parsed.data.hostId,
      parsed.data.state,
    );
    if (!out) return notFound();
    return json(out);
  });
}

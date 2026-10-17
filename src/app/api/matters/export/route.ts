import { matterListExportQuerySchema } from "@/shared/schema/list-query";
import { exportMatters } from "@/app/lib/server/services/matters";
import { json, query, requirePrivilege, withActor } from "@/app/lib/server/http";

/**
 * 案件列表导出（MATT-64 / F2-23）：**导出当前筛选的那一批**，默认脱敏。
 *
 * 为什么是独立路径而不是 `/api/matters?export=1`（当事人那边是后者）：
 * 那一边的三种读法共用同一个"集合"资源，而本条的筛选面**没有分页**
 * （导的是整批，不是当前页），把它塞进列表那份 schema 会让"导出"这个语义
 * 混进分页 DTO 里 —— 而列表的每一页都要过 `listQuerySchema`。
 * 静态段 `export` 优先于 `[id]`，所以不会与 `/api/matters/{id}` 撞。
 *
 * 特权判定**只在 handler 这一层**（`requirePrivilege` → 403），与
 * `/api/parties?export=`、两条整卷导出逐字同形：服务层再判一次就是两套口径。
 * 前端那个禁用菜单项只是省一次必然 403 的往返 —— 界面判权永远不是防线。
 */
export async function GET(req: Request) {
  const q = await query(req, matterListExportQuerySchema);
  if (!q.ok) return q.res;
  return withActor(async (actor) => {
    if (q.data.plain) {
      const denied = requirePrivilege(actor, "canReadPlain", "明文导出");
      if (denied) return denied;
    }
    return json(await exportMatters(actor, q.data));
  });
}

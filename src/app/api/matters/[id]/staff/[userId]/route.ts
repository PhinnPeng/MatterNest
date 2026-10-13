import { removeMatterStaff } from "@/app/lib/server/services/matters";
import { fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 摘参与人（MATT-49）。`userId` 从**路径**读，不从查询串读。
 *
 * ⚠ 这一点在事项侧踩过：关注人删除端点原先从 `searchParams` 取 `userId`，
 * 而路由的路径参数才是契约——冒烟里四条断言当场 400。路径参数是"这个资源"的标识，
 * 查询串是筛选条件，两者混用会让"删错人"变成可能。
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; userId: string }> },
) {
  const { id, userId } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const uid = pathId(userId);
  if (!uid.ok) return uid.res;

  return withActor(async (actor) => {
    const r = await removeMatterStaff(actor, id, userId);
    if (r.ok) return json({ removed: r.removed });
    if (r.why === "not_found") return notFound();
    if (r.why === "archived") {
      return fail(403, "archived", "这条案件已归档。归档是只读终态，名单不能再改。");
    }
    if (r.why === "forbidden") {
      return fail(403, "forbidden", "只有经办人、创建人或全局管理能改参与人名单。");
    }
    return fail(
      403,
      "owner_protected",
      "摘不掉当前负责人：那会让案件落到「有人办但名单上没有他」。换负责人请改「负责人」字段。",
    );
  });
}

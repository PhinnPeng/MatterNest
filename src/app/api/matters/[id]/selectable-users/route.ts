import { listSelectableUsers } from "@/app/lib/server/services/selectable-users";
import { json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * `GET /api/matters/{id}/selectable-users` —— 这一条案件上**可以**被指定为参与人的人。
 *
 * 与事项侧那条同源（`listSelectableUsers` 的宿主参数），所以收窄规则是同一套：
 * `is_enabled` 且 `activation_status='active'` 且落在操作者的可见用户集内，软删另排除。
 *
 * 为什么路径里必须带案件 id（权限草案 §4.1）：收窄之后出现了人员枚举探测面，
 * 能列全部在册同事就等于拿到花名册；能选谁取决于你本来能看见谁的案卷。
 * 跨宿主翻页一律拒绝——那是绕过可见性去翻别的宿主的人。
 *
 * 这一条是案件详情页「加协办 / 加关注」弹窗的**唯一**数据源。
 * 案件侧此前一直没有这个数据源，所以那个入口干脆没做（详情页只显示名单、不能加人）。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const rows = await listSelectableUsers(actor, "matter", id);
    // 看不见这条案件 = 404，不给"存在但你无权选人"这种可区分的信号（元规则 3）
    if (rows === null) return notFound();
    return json({ users: rows });
  });
}

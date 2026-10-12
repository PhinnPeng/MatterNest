import { listSelectableUsers } from "@/app/lib/server/services/selectable-users";
import { json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * `GET /api/risk-matters/{id}/selectable-users` —— 这一条事项上**可以**被指定为处理人的人。
 *
 * 为什么路径里必须带事项 id（权限草案 §4.1）：
 * 收窄之后新出现了人员枚举探测面，能列全部在册同事就等于拿到花名册。
 * 所以第一期**不提供**裸 `/users` 列表；能选谁，取决于你本来能看见谁的案卷。
 * 跨宿主翻页一律拒绝——那是绕过可见性去翻别的宿主的人。
 *
 * 这条接口是事项详情页「变更处理人」弹窗的唯一数据源。
 * 此前那个弹窗去问 `/api/meta?host=matter` 要 `users`，而那个接口的返回键只有
 * `actor / statuses / levels / tags / enums`，没有 `users` ⇒ 下拉恒空 ⇒ 界面上换不了处理人。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const rows = await listSelectableUsers(actor, "risk_matter", id);
    // 看不见这条事项 = 404，不给"存在但你无权选人"这种可区分的信号（元规则 3）
    if (rows === null) return notFound();
    return json({ users: rows });
  });
}

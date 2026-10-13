import { expenseUpdateSchema } from "@/shared/schema/expenses";
import { deleteExpense, getExpense, updateExpense } from "@/app/lib/server/services/expenses";
import { expenseWriteFailure } from "@/app/lib/server/http-expenses";
import { body, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 单条案件费用：读 / 改 / 删（US-41 的 CRUD 另一半）。
 *
 * `GET` 是「费用详情页可按宿主查阅」那条验收的落点：`/api/matters/{id}/expenses/{expenseId}`
 * 与事项侧同构，两个 id **必须同时对上** —— 父资源 id 只是装饰的写法会让
 * `/api/matters/999/expenses/<别的案子的费用 id>` 也读得到（与节点状态端点同一条理由）。
 *
 * `DELETE` 是**软删**：费用是可被引用的事实（导出、活动日志、撤销前置判定都看它），
 * 硬删会让"这条案子当时花了多少"永久不可考。
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; expenseId: string }> },
) {
  const { id, expenseId } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const eid = pathId(expenseId);
  if (!eid.ok) return eid.res;
  return withActor(async (actor) => {
    const row = await getExpense(actor, "matter", id, expenseId);
    if (!row) return notFound();
    return json(row);
  });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; expenseId: string }> },
) {
  const parsed = await body(req, expenseUpdateSchema);
  if (!parsed.ok) return parsed.res;
  const { id, expenseId } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const eid = pathId(expenseId);
  if (!eid.ok) return eid.res;
  return withActor(async (actor) => {
    const r = await updateExpense(actor, "matter", id, expenseId, parsed.data);
    if (r.ok) return json({ id: r.id });
    return expenseWriteFailure(r);
  });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; expenseId: string }> },
) {
  const { id, expenseId } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const eid = pathId(expenseId);
  if (!eid.ok) return eid.res;
  return withActor(async (actor) => {
    const r = await deleteExpense(actor, "matter", id, expenseId);
    if (r.ok) return json({ id: r.id });
    return expenseWriteFailure(r);
  });
}

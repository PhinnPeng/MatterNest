import { expenseUpdateSchema } from "@/shared/schema/expenses";
import { deleteExpense, getExpense, updateExpense } from "@/app/lib/server/services/expenses";
import { expenseWriteFailure } from "@/app/lib/server/http-expenses";
import { body, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 单条事项费用：读 / 改 / 删（与案件侧同构，理由见那一侧的头注）。
 *
 * 两个 id 必须同时对上：`/api/risk-matters/{id}/expenses/{expenseId}` 里前一个 id
 * 不是装饰 —— 它同时承担可见性判定（`scopedWhere` 走事项侧谓词）。
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
    const row = await getExpense(actor, "risk_matter", id, expenseId);
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
    const r = await updateExpense(actor, "risk_matter", id, expenseId, parsed.data);
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
    const r = await deleteExpense(actor, "risk_matter", id, expenseId);
    if (r.ok) return json({ id: r.id });
    return expenseWriteFailure(r);
  });
}

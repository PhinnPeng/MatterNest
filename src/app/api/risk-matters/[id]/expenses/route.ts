import { listQuerySchema } from "@/shared/schema/list-query";
import { expenseCreateSchema } from "@/shared/schema/expenses";
import { createExpense, listExpenses } from "@/app/lib/server/services/expenses";
import { expenseWriteFailure } from "@/app/lib/server/http-expenses";
import { body, json, notFound, pathId, query, withActor } from "@/app/lib/server/http";

/**
 * 事项费用（与案件侧同构：US-41 的"案件侧与事项侧同构"那条验收）。
 *
 * 两边的差别只有 `scopedWhere` 的宿主参数与表本身 —— 服务层是同一份实现
 * （`services/expenses.ts` 用宿主分派），所以"事项侧少一个校验"这类漂移写不出来。
 *
 * 语义上仍是**只记支出**：事项是台账，登记的是"为处理这件事花掉的钱"
 * （鉴定费、公证费、差旅之类），同样没有"当事人付我方费用"这一侧。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const q = await query(req, listQuerySchema.pick({ page: true, pageSize: true }));
  if (!q.ok) return q.res;
  return withActor(async (actor) => {
    const r = await listExpenses(actor, "risk_matter", id, q.data);
    if (!r) return notFound();
    return json(r);
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, expenseCreateSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await createExpense(actor, "risk_matter", id, parsed.data);
    if (r.ok) return json({ id: r.id }, 201);
    return expenseWriteFailure(r);
  });
}

import { listQuerySchema } from "@/shared/schema/list-query";
import { expenseCreateSchema } from "@/shared/schema/expenses";
import { createExpense, listExpenses } from "@/app/lib/server/services/expenses";
import { expenseWriteFailure } from "@/app/lib/server/http-expenses";
import { body, json, notFound, pathId, query, withActor } from "@/app/lib/server/http";

/**
 * 案件费用（US-41 / 基线 4.6「仅支出」）。
 *
 * 一条路径两种用法，与当事人集合端点同一个形状：
 *   · `GET`  —— 列表 + **合计**（`SUM(amount)`，服务端算）+ **按项目分组**（F2-13）；
 *   · `POST` —— 登记一笔支出。
 *
 * 判定顺序：**路径 id → 可见性 → 归档态 → 数据**。可见性在服务层经 `scopedWhere`
 * 一处完成（宿主看不见 → 404，与"不存在"同一个响应）；归档是只读终态，写回 403。
 *
 * 费用项目**不是自由文本**：`itemId` 必须指向 `mn_expense_item_config` 里一行启用的配置
 * （真外键 + 服务层再验一次）。配置页（P16）归 M5，本票只读它。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  const q = await query(req, listQuerySchema.pick({ page: true, pageSize: true }));
  if (!q.ok) return q.res;
  return withActor(async (actor) => {
    const r = await listExpenses(actor, "matter", id, q.data);
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
    const r = await createExpense(actor, "matter", id, parsed.data);
    if (r.ok) return json({ id: r.id }, 201);
    return expenseWriteFailure(r);
  });
}

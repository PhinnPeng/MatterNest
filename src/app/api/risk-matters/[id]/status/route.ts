import { eq } from "drizzle-orm";
import { statusChangeSchema } from "@/shared/schema/hosts";
import { changeRiskStatus } from "@/app/lib/server/services/risks";
import { getDb } from "@/app/lib/server/db/client";
import { riskMatter } from "@/app/lib/server/db/schema";
import { scopedWhere } from "@/app/lib/server/scope/visibility";
import {
  attributionRequired,
  body,
  fail,
  json,
  notFound,
  pathId,
  reasonRequired,
  withActor,
} from "@/app/lib/server/http";

/**
 * 事项状态流转（T1）。判定顺序与案件侧同构，理由也一样：
 *
 *   **先判可见 → 再判特权 → 再判归属 → 最后才动数据。**
 *
 * 先按 id 裸读 `is_archived` 再判特权，会让一条我根本看不见的归档事项回 403
 * 「需要撤销归档权限」—— 等于替对方确认"这个 id 存在且已归档"，
 * 正是元规则 3（不可见一律 404）要防的探测。所以读取走 `scopedWhere`。
 *
 * 归档的两个条件不合并：`can_unarchive` 是特权（"影响别人或不可逆"），
 * 归属判定在服务层。合起来会让"经办人归档自己的事项"变复杂。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, statusChangeSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const db = await getDb();
    const [cur] = await db
      .select({ isArchived: riskMatter.isArchived })
      .from(riskMatter)
      .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, pid.id)))
      .limit(1);
    if (!cur) return notFound();
    // 撤销归档要特权；归档本身不要（它是正常流程的终点）
    if (cur.isArchived && !actor.privileges.canUnarchive)
      return fail(403, "privilege_required", "撤销归档需要「撤销归档」权限，当前角色未持有");

    const r = await changeRiskStatus(actor, id, parsed.data.to, parsed.data.reason ?? null);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "reason_required") return reasonRequired();
    // 可见但不是经办人：403 是诚实的答复（这条你看得见，只是轮不到你推状态）
    if (r.why === "forbidden") return attributionRequired();
    return fail(422, "unchanged", "目标状态与当前状态相同");
  });
}

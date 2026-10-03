import { eq } from "drizzle-orm";
import { statusChangeSchema } from "@/shared/schema/hosts";
import { changeStatus } from "@/app/lib/server/services/matters";
import { getDb } from "@/app/lib/server/db/client";
import { matter } from "@/app/lib/server/db/schema";
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
 * 状态变更。判定顺序是这条路由存在的全部理由：
 *
 *   **先判可见 → 再判特权 → 再判归属 → 最后才动数据。**
 *
 * 之前是"先按 id 裸读 `is_archived`、再判特权"，于是一条我根本看不见的归档案件会回
 * 403「需要撤销归档权限」—— 等于替对方确认了"这个 id 存在且已归档"，正是元规则 3
 * （不可见一律 404）要防的案号枚举探测。这次读取改走 `scopedWhere`，
 * 而 `scopedWhere` 里的 `NOT is_deleted` 顺带把"已删除的案件能不能被改状态"也堵上了。
 *
 * 归档的两个条件不合并成一次判定：`can_unarchive` 是特权（§2.1，"影响别人或不可逆"），
 * 承办人本人没有；护栏 1 的归属判定在服务层里做。合起来会让"owner 归档自己的案子"变复杂。
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
      .select({ isArchived: matter.isArchived })
      .from(matter)
      .where(scopedWhere("matter", actor, eq(matter.id, pid.id)))
      .limit(1);
    // 不可见 / 已软删 → 与"不存在"同一个 404，措辞也不区分
    if (!cur) return notFound();
    if (cur.isArchived && !actor.privileges.canUnarchive)
      return fail(403, "privilege_required", "撤销归档需要「撤销归档」权限，当前角色未持有");

    const r = await changeStatus(actor, id, parsed.data.to, parsed.data.reason ?? null);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "reason_required") return reasonRequired();
    // 可见但不是承办人：403 是诚实的答复（这条你看得见，只是轮不到你推状态）
    if (r.why === "forbidden") return attributionRequired();
    return fail(422, "unchanged", "目标状态与当前状态相同");
  });
}

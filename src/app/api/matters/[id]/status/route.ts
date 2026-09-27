import { eq } from "drizzle-orm";
import { statusChangeSchema } from "@/shared/schema/hosts";
import { changeStatus } from "@/app/lib/server/services/matters";
import { getDb } from "@/app/lib/server/db/client";
import { matter } from "@/app/lib/server/db/schema";
import {
  body,
  fail,
  json,
  notFound,
  pathId,
  reasonRequired,
  withActor,
} from "@/app/lib/server/http";

/**
 * 状态变更。"从归档态往外走"需要 `can_unarchive`（权限草案 §2.1：不可逆动作的唯一出口）。
 * 判的是"离开归档"而不是"目标态"，因为进入归档由 semantics 触发、走的是同一条链路。
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
      .where(eq(matter.id, BigInt(id)))
      .limit(1);
    if (cur?.isArchived && !actor.privileges.canUnarchive)
      return fail(403, "privilege_required", "撤销归档需要「撤销归档」权限，当前角色未持有");

    const r = await changeStatus(actor, id, parsed.data.to, parsed.data.reason ?? null);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "reason_required") return reasonRequired();
    return fail(422, "unchanged", "目标状态与当前状态相同");
  });
}

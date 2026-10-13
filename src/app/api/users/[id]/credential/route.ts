import { userCredentialSchema } from "@/shared/schema/users";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";
import { setUserCredential } from "@/app/lib/server/services/users";

/**
 * 本地凭据设置 / 重置（F6-9）。
 *
 * **不挂 `requirePrivilege`**：判定是 `actor.isSystemOwner`，与角色特权是两件事
 * （见 `auth.ts` 里 Actor 的注释）。走特权开关就等于"给某个角色配一次就能开凭据"，
 * 而裁定要的是"只有那个人"。
 *
 * 口令**只进不出**：请求体里有它，响应里没有，审计里也没有（只记 mode/self）。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, userCredentialSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    const r = await setUserCredential(actor, id, parsed.data.password);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "not_system_owner") {
      return fail(
        403,
        "system_owner_required",
        "设置本地凭据只对系统所有者开放：凭据生命线由他持有，不另设兜底账号。",
      );
    }
    if (r.why === "too_short") {
      return fail(400, "password_too_short", "口令至少 8 位。");
    }
    return fail(403, "forbidden", "这个动作不被允许。");
  });
}

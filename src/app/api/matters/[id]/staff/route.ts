import { staffAddSchema } from "@/shared/schema/users";
import { addMatterStaff, listMatterStaff } from "@/app/lib/server/services/matters";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 案件参与人名单（MATT-49）。
 *
 * `GET` 读名单：**看得见案件就能读**（只读不等于看不见谁在办）。
 * `POST` 加人：四道门见服务层注释；这里只把服务层的判定翻译成状态码与文案。
 *
 * 为什么 `staffRole` 只收协办/关注：换负责人是字段编辑（走 `OWNER_CHANGED`），
 * 从这里再开一条就会出现两条到同一状态的路、其中一条不写审计。schema 层已钉死值域。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const rows = await listMatterStaff(actor, id);
    if (rows === null) return notFound();
    return json({ staff: rows });
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, staffAddSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    const r = await addMatterStaff(actor, id, parsed.data.userIds, parsed.data.staffRole);
    if (r.ok) return json({ added: r.added, skipped: r.skipped }, 200);
    if (r.why === "not_found") return notFound();
    if (r.why === "archived") {
      return fail(403, "archived", "这条案件已归档。归档是只读终态，名单不能再改。");
    }
    if (r.why === "forbidden") {
      return fail(
        403,
        "forbidden",
        "只有经办人、创建人或全局管理能改参与人名单——协办与关注看得见名单，但改不了。",
      );
    }
    if (r.why === "role_not_allowed") {
      return fail(400, "role_not_allowed", "只能加协办或关注人；换负责人请改「负责人」字段。");
    }
    // not_selectable：**不回显是谁不合格**（回显等于把这个端点变成花名册探测面）
    return fail(
      422,
      "not_selectable",
      "名单里有不能被指定的人：可能不在你的可选范围内，或已停用 / 待开通 / 已删除。",
    );
  });
}

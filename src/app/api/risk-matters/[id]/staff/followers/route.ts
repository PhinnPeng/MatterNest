import { z } from "zod";
import { addRiskFollowers, listRiskFollowers } from "@/app/lib/server/services/risks";
import { body, fail, json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 关注人名单（MATT-56 / ADR-0003）：读 + 加。
 *
 * 路径形状与 parties 区同构（GET 全量 + POST 增量追加）：整体替换要求前端
 * 先拉全量再提交全量，两人同时改会静默丢对方的改动。
 *
 * 自我关注（眼睛）与他人加人（菜单）走同一个 POST：`userIds=[自己]` 只受可见性门，
 * 含他人时服务层再判名单管理权与 §4.1 可见用户集——**判定全在服务层**，
 * 界面上藏不藏入口不是安全边界（禁令⑤：handler 内鉴权）。
 */
const addSchema = z
  .object({
    userIds: z
      .array(z.string().regex(/^\d{1,19}$/))
      .min(1)
      .max(50),
  })
  .strict();

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const rows = await listRiskFollowers(actor, id);
    if (rows === null) return notFound();
    return json(rows);
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, addSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;

  return withActor(async (actor) => {
    const r = await addRiskFollowers(actor, id, parsed.data.userIds);
    if (!r.ok) {
      // 不可见 → 404（元规则 3）；归档只读与无管理权给可区分的 403——两者都不是访问探测，
      // 请求者本来就看得见这条记录才可能走到这两个分支
      if (r.why === "not_found") return notFound();
      if (r.why === "archived") return fail(403, "archived", "归档是终态，关注名单不再变更。");
      return fail(403, "forbidden", "只有经办人、创建人或全局范围的角色能添加其他关注人。");
    }
    return json({ added: r.added, skipped: r.skipped });
  });
}

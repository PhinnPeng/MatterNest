import { matterPatchSchema } from "@/shared/schema/hosts";
import { deleteMatter, getMatter, updateMatter } from "@/app/lib/server/services/matters";
import {
  attributionRequired,
  body,
  fail,
  json,
  notFound,
  pathId,
  withActor,
} from "@/app/lib/server/http";

/**
 * 详情。**不可见与不存在都走 404**（权限草案 §1 元规则 3）：
 * 403 等于向探测者确认"这条案卷存在"，而案号是可枚举的。
 *
 * id 先过 `pathId`：`BigInt("abc")` 抛 SyntaxError 会变成 500，
 * 那是"URL 写错了"，不是服务端坏了 —— 也不给 404，免得把前端路由 bug 伪装成权限收窄。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const row = await getMatter(actor, id);
    return row ? json(row) : notFound();
  });
}

/**
 * 改案件主表字段：行内「变更处理人」与「程序/审级」（2026-10-22）。
 *
 * 与事项侧 `PATCH /api/risk-matters/{id}` 逐条同构（那边写得更细，理由看过了这边就不再抄一遍）：
 * 字段定义在 `shared/schema/hosts.ts` 的 `matterPatchSchema`，权限与冻结判定在服务层。
 *
 * `422 empty` 是**正常结局之一**：行内下拉选了当前值（前端已拦，但接口不能靠前端）。
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, matterPatchSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await updateMatter(actor, id, parsed.data);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    // 可见但不是经办人（或没有 L1 范围）、或已归档只读：403 是诚实的答复
    if (r.why === "forbidden")
      return fail(403, "readonly", "这条案卷是只读的（已归档，或你不是它的负责人）");
    if (r.why === "owner_not_selectable")
      return fail(422, "owner_not_selectable", "该用户不在你可见的经办人范围内");
    return fail(422, "empty", "没有字段发生变化");
  });
}

/**
 * 软删案件（MATT-62 / F2-5，修订稿 §12.4）。**没有回收站界面** ——
 * 库内可恢复、普通用户不可见已删行，恢复留给有特权的人（与事项侧逐字同形）。
 *
 * 两个 4xx 的分工（与 `status` 路由同一套口径）：
 *   · 不可见 / 不存在 ⇒ **404**（元规则 3，不给探测者确认信号）；
 *   · 看得见但不是经办人（或没有全局范围）⇒ **403 `attribution_required`**。
 *
 * ⚠ **删完必须 404 而不是 403/200 空响应**：前端据此把这一行从列表里摘掉，
 *   而"库里那行还在"这件事由冒烟直查库钉住（两条同时断，见 `smoke-delete.mjs`）——
 *   只断接口 404 的话，硬删也能过。
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await deleteMatter(actor, id);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    return attributionRequired();
  });
}

import { z } from "zod";
import { pruneEmpty } from "@/shared/schema/hosts";
import {
  deleteRiskMatter,
  getRiskMatter,
  RISK_FROZEN_MESSAGE,
  updateRiskMatter,
} from "@/app/lib/server/services/risks";
import {
  attributionRequired,
  body,
  fail,
  json,
  notFound,
  pathId,
  withActor,
} from "@/app/lib/server/http";

/** 事项详情（T1）。不可见一律 404 —— 与案件侧同一条元规则 3。 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await getRiskMatter(actor, id);
    if (r === null) return notFound();
    return json(r);
  });
}

/**
 * 改事项主表字段，含**变更处理人**（T1）。
 *
 * 「变更处理人」是一次**普通字段编辑**（GLOSSARY 明写）：不新增状态、不新造审计动作，
 * 沿用 `OWNER_CHANGED`。所以它走这条通用编辑路由，**没有专属端点**——
 * 给它开一个 `/claim` 之类的入口就等于把"认领"这个被否决的流程概念又请回来。
 *
 * `ownerId: null` 是**合法值**：事项的经办人可空（IQ-5），
 * 它表示把事项退回未指派，让持 L1 的人去变更处理人。所以这里用 `nullable` 而不是 `.optional()`。
 *
 * **冻结**（2026-10-14 裁定）：事项转过案件之后字段不可再改，**含变更处理人**。
 * 回 422 而不是复用下面的 403 `readonly` —— 那句提示是写给"归档 / 你不是经办人"的，
 * 让它顺带解释冻结，用户会去找经办人代劳，而代劳之后拿到的是同一句话。
 */
const patchSchema = z
  .object({
    name: z.string().trim().min(2, "请输入事项名称").max(200).optional(),
    level: z.string().trim().min(1).max(32).optional(),
    description: z.string().trim().min(2, "请填写描述").max(5000).optional(),
    measure: z.string().trim().max(5000).nullable().optional(),
    amount: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,2})?$/, "金额最多两位小数")
      .optional(),
    ownerId: z.string().regex(/^\d+$/, "经办人必须是数字字符串").nullable().optional(),
  })
  .strict();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = await body(req, patchSchema);
  if (!parsed.ok) return parsed.res;
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await updateRiskMatter(
      actor,
      id,
      pruneEmpty(parsed.data) as Parameters<typeof updateRiskMatter>[2],
    );
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    if (r.why === "frozen") return fail(422, "frozen", RISK_FROZEN_MESSAGE);
    // 可见但不是经办人：403 是诚实的答复。归档态也走这里——它是只读终态
    if (r.why === "forbidden")
      return fail(403, "readonly", "这条事项是只读的（已归档，或你不是它的经办人）");
    return fail(422, "empty", "没有字段发生变化");
  });
}

/** 软删事项（F2-5）。**没有回收站界面**：库内可恢复、普通用户不可见已删行。 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = pathId(id);
  if (!pid.ok) return pid.res;
  return withActor(async (actor) => {
    const r = await deleteRiskMatter(actor, id);
    if (r.ok) return json({ ok: true });
    if (r.why === "not_found") return notFound();
    return attributionRequired();
  });
}

import { isFavorited, setFavorite } from "@/app/lib/server/services/watch";
import { json, notFound, pathId, withActor } from "@/app/lib/server/http";

/**
 * 收藏 ⭐ 的单条开关（MATT-63 / F1-13）。
 *
 * ## 为什么 `targetType`/`targetId` 在**路径**上
 *
 * 与关注人删除端点同一条纪律（`matters/[id]/staff/[userId]/route.ts` 的注释写过）：
 * 路径参数是"这个资源"的标识，查询串是筛选条件。收藏的"是哪一条"是资源标识的一部分，
 * 放查询串会让"收藏错对象"变成可能（前端拼错参数名时静默收藏了另一条）。
 *
 * ## 为什么读面也是 `PUT`/`DELETE` 而没有 `GET`
 *
 * `GET /api/watch/{type}/{id}` 会带出一个可枚举的存在性探针：换个 id 就能问
 * "这条存在吗"（404 与 403 的差别即答案）。本仓的既有姿态是**状态随详情带出**：
 * 详情页在 DTO 里拿到 `favorited`，单独问"我收藏了吗"只发生在切换之后。
 * 所以这里只有写面。
 *
 * ## `PUT` 而不是 `POST`
 *
 * 幂等（连点两下 = 一次）——`PUT` 的语义正是不管调几次都是同一态。
 * `POST` 在这个语义下会让人以为每次点都产生一条记录。
 */

type Ctx = { params: Promise<{ targetType: string; targetId: string }> };

async function readTarget(ctx: Ctx) {
  const { targetType, targetId } = await ctx.params;
  const tid = pathId(targetId);
  if (!tid.ok) return { ok: false as const, res: tid.res };
  return { ok: true as const, targetType, targetId };
}

export async function PUT(_req: Request, ctx: Ctx) {
  const t = await readTarget(ctx);
  if (!t.ok) return t.res;
  return withActor(async (actor) => {
    const r = await setFavorite(actor, t.targetType, t.targetId, true);
    // 不可见与"不是收藏支持的宿主类型"**同形 404**：不回显是哪一种，
    // 否则这个端点就成了"这个 id 存在吗"的探测器（元规则 3）。
    if (!r.ok) return notFound();
    return json({ watching: r.watching });
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const t = await readTarget(ctx);
  if (!t.ok) return t.res;
  return withActor(async (actor) => {
    const r = await setFavorite(actor, t.targetType, t.targetId, false);
    if (!r.ok) return notFound();
    return json({ watching: r.watching });
  });
}

/** 详情页用的当前态（内部函数，不经 HTTP —— `isFavorited` 由详情服务层调用）。 */
export { isFavorited };

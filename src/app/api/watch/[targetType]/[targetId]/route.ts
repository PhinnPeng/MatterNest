import { favoriteSchema, watchTargetSchema } from "@/shared/schema/watch";
import { setFavorite } from "@/app/lib/server/services/watch";
import { body, fail, json, withActor } from "@/app/lib/server/http";

/**
 * 收藏 ⭐ 的单条开关（MATT-63 / F1-13）。
 *
 * ## 为什么 `targetType`/`targetId` 在**路径**上
 *
 * 与关注人删除端点同一条纪律（`matters/[id]/staff/[userId]/route.ts` 的注释写过）：
 * 路径参数是"这个资源"的标识，查询串是筛选条件。收藏的"是哪一条"是资源标识的一部分，
 * 放查询串会让"收藏错对象"变成可能（前端拼错参数名时静默收藏了另一条）。
 *
 * ## 为什么读面是 `PUT`/`DELETE` 而没有 `GET`
 *
 * `GET /api/watch/{type}/{id}` 会带出一个可枚举的存在性探针：换个 id 就能问
 * "这条存在吗"（404 与 403 的差别即答案）。本仓的既有姿态是**状态随详情带出**：
 * 详情页在 DTO 里拿到 `favorited`，单独问"我收藏了吗"只发生在切换之后。
 * 所以这里只有写面；集合面是 `GET /api/watch`。
 *
 * ## `PUT` 而不是 `POST`
 *
 * 幂等（连点两下 = 一次）——`PUT` 的语义正是不管调几次都是同一态。
 * `POST` 在语义下会让人以为每次点都产生一条记录。
 *
 * ## 校验（`watchTargetSchema` + `favoriteSchema`，都 `.strict()`）
 *
 * 宿主类型是**闭合枚举**（`matter | risk_matter`），所以非法值给 400 而不是 404 ——
 * 枚举本身是公开知识（界面上就这两个入口），装成"找不到"反而把"参数写错了"
 * 报成"东西不在了"，让人去查数据而不是查请求。
 * 而**看不见的记录**仍是 404，且与"不存在"同形（元规则 3）——那条判定在服务层。
 *
 * `favoriteSchema` 的 `.strict()` 堵的是**自造 `follow`**：`watchType` 若能过，
 * 用户就能写出一条 `follow` 行，于是「我关注」与「关注人名单」成了两份真相，
 * 而两边都 200、都不报错。
 */

type Ctx = { params: Promise<{ targetType: string; targetId: string }> };

async function readTarget(ctx: Ctx) {
  const { targetType, targetId } = await ctx.params;
  const parsed = watchTargetSchema.safeParse({ targetType, targetId });
  if (!parsed.success) {
    return {
      ok: false as const,
      res: fail(400, "bad_target", "收藏只支持案件与事项，id 必须是数字。"),
    };
  }
  return { ok: true as const, targetType: parsed.data.targetType, targetId: parsed.data.targetId };
}

export async function PUT(req: Request, ctx: Ctx) {
  const t = await readTarget(ctx);
  if (!t.ok) return t.res;
  // body 收 `{watching}` 而不是忽略它：忽略会让「传了 watchType 也 200」变成
  // "看起来成功了、其实按 favorite 处理"——静默偏离请求意图。
  const parsed = await body(req, favoriteSchema);
  if (!parsed.ok) return parsed.res;

  return withActor(async (actor) => {
    const r = await setFavorite(actor, t.targetType, t.targetId, parsed.data.watching);
    // 不可见与"不存在"**同形 404**（元规则 3）：不区分，否则这个端点就是探测器。
    if (!r.ok) return fail(404, "not_found", "找不到这条记录。");
    return json({ watching: r.watching });
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const t = await readTarget(ctx);
  if (!t.ok) return t.res;
  return withActor(async (actor) => {
    const r = await setFavorite(actor, t.targetType, t.targetId, false);
    if (!r.ok) return fail(404, "not_found", "找不到这条记录。");
    return json({ watching: r.watching });
  });
}

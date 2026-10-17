import { listMyFavorites } from "@/app/lib/server/services/watch";
import { json, withActor } from "@/app/lib/server/http";

/**
 * 我收藏的（F1-13 的查询面）。
 *
 * **权限问题，不是过滤问题**（票面原话）：不可见的记录**不出现**在结果里。
 * 判定在服务层逐宿主过 `scopedWhere`（可见性唯一出口），这里只把结果发出去。
 *
 * 不分页：收藏是**用户主动建立**的集合，规模由用户自己的行为决定（与通知中心那种
 * "系统产生、会长到几万条"的集合不同）。一期实测量级是个位数到几十条。
 * 若哪天有人收藏上千条，再按 `notification` 的形状加游标——**先不做**，
 * 因为分页会把"我收藏的"从"一屏看全"变成"要翻页"，而那正好背离收藏的用途。
 */
export async function GET() {
  return withActor(async (actor) => json({ favorites: await listMyFavorites(actor) }));
}

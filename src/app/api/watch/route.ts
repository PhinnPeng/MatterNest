import { listMyWatches } from "@/app/lib/server/services/watch";
import { json, withActor } from "@/app/lib/server/http";

/**
 * 我关注的（F1-13 的查询面）。
 *
 * **2026-10-22 起读的是公开关注名单**（`*_staff.staff_role='follower'`），
 * 与详情页「n 人关注」同一个源——详见 `listMyWatches` 的注释。
 *
 * **权限问题，不是过滤问题**（票面原话）：不可见的记录**不出现**在结果里。
 * 判定在服务层逐宿主过 `scopedWhere`（可见性唯一出口），这里只把结果发出去。
 *
 * 不分页：关注是**用户主动建立**的集合，规模由用户自己的行为决定（与通知中心那种
 * "系统产生、会长到几万条"的集合不同）。一期实测量级是个位数到几十条。
 * 若哪天有人关注上千条，再按 `notification` 的形状加游标——**先不做**，
 * 因为分页会把"我关注的"从"一屏看全"变成"要翻页"，而那正好背离关注的用途。
 */
export async function GET() {
  return withActor(async (actor) => json({ favorites: await listMyWatches(actor) }));
}

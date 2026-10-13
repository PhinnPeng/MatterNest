import { z } from "zod";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "@/shared/schema/list-query";
import { json, query, withActor } from "@/app/lib/server/http";
import {
  listNotifications,
  pumpNotifications,
  countUnread,
} from "@/app/lib/server/services/notifications";

/**
 * 通知中心（F4-1 / F4-3 / F4-7）。
 *
 * ## 为什么 GET 里会写库
 *
 * 一期没有调度器（单副本、不引 Redis），消费靠"表 + 轮询"——
 * 而"轮询"这件事必须由某个真实发生的请求推动。这里就是那个推动点：
 * 每次读通知中心先 `pumpNotifications()`（抽干 outbox + 跑一遍节点到期扫描），再返回列表。
 *
 * 它**不会产生重复通知**：outbox 的重复消费被 `dedupe_key` 唯一键吸收，
 * 节点扫描被"同目标同业务日"的 scheduled key 吸收。代价只是多跑两次索引扫描。
 * 把轮询放在一个独立的 cron 端点上会更"干净"，但一期没有 cron——
 * 一个没人调用的端点等于没有消费者，而通知中心是**唯一**会因此变空的地方。
 *
 * `unreadOnly` 走同一个 schema：列表与徽标必须是同一个可见性口径（§7.1），
 * 两套参数迟早会漂移。
 */
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  unreadOnly: z
    .enum(["1", "true", "0", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export async function GET(req: Request) {
  const parsed = await query(req, listSchema);
  if (!parsed.ok) return parsed.res;
  return withActor(async (actor) => {
    await pumpNotifications();
    const page = await listNotifications(actor, {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      unreadOnly: parsed.data.unreadOnly,
    });
    // 徽标与列表同一次请求一起给：分两次拿会出现"列表里 3 条未读、徽标写 5"
    // ——而这两个数来自不同的可见性判定时，那种不一致根本查不出来
    return json({ ...page, unread: await countUnread(actor) });
  });
}

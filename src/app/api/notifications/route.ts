import { z } from "zod";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "@/shared/schema/list-query";
import { json, query, withActor } from "@/app/lib/server/http";
import { pumpAll } from "@/app/lib/server/services/pump-gate";
import { listNotifications, countUnread } from "@/app/lib/server/services/notifications";

/**
 * 通知中心（F4-1 / F4-3 / F4-7）。
 *
 * ## 为什么 GET 里会写库
 *
 * 一期不收敛读驱动（单副本、不引 Redis），消费靠"表 + 轮询"——
 * 而"轮询"必须由某个真实发生的动作推动。推动路径有两条，**两条都要在**：
 *   · 这条（读驱动）：每次读通知中心先跑一次完整 pump，再返回列表；
 *   · `src/instrumentation.ts` 的应用内定时器（每 5 分钟，MATT-74）：它撑的是
 *     「没人打开这一页时提醒照样发」——一个要人主动去找才收到的提醒，不是提醒。
 *
 * 它**不会产生重复通知**：outbox 的重复消费被 `dedupe_key` 唯一键吸收，
 * 节点扫描被"同目标同业务日"的 scheduled key 吸收。代价只是多跑几次索引扫描，
 * 而两条路径的重叠由 `services/pump-gate.ts` 的进程内单飞收在一处（串行，不是跳过）。
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
    /**
     * **轮询点在这里，不在服务层。** 一期不收敛读驱动（单副本、不引 Redis），
     * 所以每个"定时/规则类"的扫描都由「这个读请求」与「`src/instrumentation.ts` 的
     * 应用内定时器（每 5 分钟）」两条路径共同推动——**本行就是读驱动那一半**。
     *
     * ⚠ **新增一个扫描器时，必须加进 `services/pump-gate.ts` 的 `pumpOnce()` 里**，
     * 否则它会变成"写好了但没人调用"，而那种形态与"没人该收"在库里长得一模一样（零事件）。
     * 当前有三个：
     *   · `pumpNotifications()` —— 抽干 outbox + 节点到期扫描（T4）
     *   · `scanArchiveIncomplete()` —— 规则 9：结案材料不全（MATT-43 / T5b）
     *
     * 为什么走 `pumpAll()` 而不是直接调那两个函数：它是**进程内单飞**（MATT-74 前置件 4），
     * 让「定时器 × 读驱动」同时触发时串行而不是并行——两边同时跑同一批扫描不会产生
     * 重复通知（`dedupe_key` 吸收），但会互相等在行锁上、各占一条池连接（`PG_POOL_MAX=10`）。
     * 语义逐字不变：**返回列表之前一定跑过一次属于本次请求的完整 pump**（见该文件头）。
     *
     * 为什么规则 9 不并进 `pumpNotifications()`：那会形成
     * `services/notifications.ts ↔ services/archive-reminder.ts` 的循环 import
     * ——两者只能在第三个模块 `services/pump-gate.ts` 里合流。
     */
    await pumpAll("read");
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

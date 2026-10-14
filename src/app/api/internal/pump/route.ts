import { timingSafeEqual } from "node:crypto";
import { json, notFound } from "@/app/lib/server/http";
import { scanArchiveIncomplete } from "@/app/lib/server/services/archive-reminder";
import { pumpNotifications } from "@/app/lib/server/services/notifications";

/**
 * 通知泵的内部触发端点（MATT-73 / T4d）。
 *
 * ## 为什么存在
 *
 * 提醒过去只由「人打开通知中心」触发（`GET /api/notifications` 里的两行 pump），
 * 而通知中心无轮询、无徽标 ⇒ 没人打开就没人发提醒。MATT-35 的原话：
 * 「一个要人主动去找才收到的提醒，不是提醒」。本端点是那个触发的**应用侧**：
 * 操作系统触发器（systemd timer / croner 脚本，每 5 分钟，另一张票）打这里。
 *
 * ## 为什么不用 `withActor`
 *
 * `pumpNotifications` 不需要 actor：系统动作以 `operator = SYSTEM` 执行
 * （`notifications.ts:1040-1041`），本端点不写审计、不读用户范围。
 * 这是全仓第一个**没有会话**的 `/api/**` 路由——会话模型对它既不必要
 * （拿不到 actor 不影响正确性），也不该有（触发器没有「人」）。
 *
 * ## 鉴权：bearer token，缺值/错值一律 404
 *
 * 给 404 不是 401：401 等于告诉对方「这端点存在」（与元规则 3 同源：
 * 不可见与不存在不区分）。只绑回环也不够——那防的是外网，防不了同机其他进程；
 * token 是第二道。比较走 `timingSafeEqual`（与口令校验同一姿态，`auth.ts:45`），
 * 不用 `===`（短路比较会把 token 校验变成计时探针）。
 *
 * 缺 `MN_INTERNAL_TOKEN` 配置时**一律 404**（fail closed）：没有默认值可走，
 * 而「没配 key 就放行」会让忘配的生产环境变成一个无鉴权的写入口。
 *
 * ## 一期不加锁
 *
 * 单触发器不会与自己重叠；手工补跑撞上时靠 `dedupe_key` 唯一键吸收
 * （`notifications.ts:333`）。多副本时再补 advisory lock（二期逃生口）。
 *
 * ## 返回体
 *
 * `{ outbox, scan }` 两个计数直接来自 `pumpNotifications` 的返回类型
 * （`notifications.ts:774-780` / `:894-898`），供触发器落心跳（MATT-83）。
 */
export async function POST(req: Request) {
  const expected = process.env.MN_INTERNAL_TOKEN;
  const header = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim() ?? "";
  // 长度不等时 timingSafeEqual 会抛，先比长度再比内容（auth.ts:45 同一写法）
  const sent = Buffer.from(token);
  const want = Buffer.from(expected ?? "");
  const same =
    expected !== undefined &&
    expected !== "" &&
    sent.length === want.length &&
    timingSafeEqual(sent, want);
  if (!same) return notFound();

  const { outbox, scan } = await pumpNotifications();
  await scanArchiveIncomplete();
  return json({ outbox, scan });
}

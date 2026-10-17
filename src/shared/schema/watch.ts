import { z } from "zod";

/**
 * 收藏 ⭐ / 关注 的请求形状（MATT-63 / F1-13）。
 *
 * 放 `src/shared/schema/` 而不是写在各路由里：前后端共用同一道门（禁令⑧「校验规则单源」）。
 *
 * `.strict()` 的理由与 `users.ts` 顶部那段相同：zod 默认**静默剥离**未声明字段，
 * 而这里有一个真实的越权面 —— `watchType` 若不显式拒，客户端传 `follow` 就可能
 * 被写进 `mn_user_watch`，于是「我关注」与「关注人名单」成了两份真相。
 * 所以收藏端点**不吃 `watchType`**（服务层固定写 `favorite`），并在 schema 层拒掉它。
 */

/** 收藏挂的宿主类型：只两个（见 `services/watch.ts` 文件头「为什么只对两个宿主」） */
export const WATCH_TARGET_TYPES = ["matter", "risk_matter"] as const;

/** 路径参数里的宿主类型（`/api/watch/[targetType]/[targetId]`） */
export const watchTargetSchema = z.object({
  targetType: z.enum(WATCH_TARGET_TYPES, { message: "收藏只支持案件与事项" }),
  targetId: z.string().regex(/^\d{1,19}$/, "id 必须是数字字符串"),
});

/** 收藏开关的 body：`watching=true` 加 ⭐、`false` 取消。 */
export const favoriteSchema = z
  .object({
    watching: z.boolean({ message: "watching 必须是布尔值" }),
  })
  .strict();

export type FavoriteInput = z.input<typeof favoriteSchema>;

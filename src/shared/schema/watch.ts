import { z } from "zod";

import { HOST_TYPES } from "@/shared/enums/targets";

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

/**
 * 收藏挂的宿主类型：**就是 `HOST_TYPES`**（E08 ∩ E10 的共用值域，`shared/enums/targets.ts`）。
 *
 * 这里**不另写一份字面量**：`matter | risk_matter` 这份值域在仓里已有多处引用，
 * 再抄一份就是第二份真相——某天新增宿主时改一处漏一处，而两边都编译得过。
 * 「为什么只对两个宿主」的产品理由见 `services/watch.ts` 文件头（那是约束，
 * 不是值域的定义处）。
 */
export const WATCH_TARGET_TYPES = HOST_TYPES;

/**
 * 路径参数里的宿主类型（`/api/watch/[targetType]/…`）。
 *
 * ⚠ **只管 `targetType`，不管 id**。id 的形态规则（纯数字、不超 `bigint`）
 * 在 `http.ts:pathId()` 一处，由它负责转 `bigint`；在这里再写一个正则
 * 就是第二份 id-shape 规则（本文件曾有一个 `/^\d{1,19}$/`，2026-10-17 摘掉）。
 */
export const watchTargetSchema = z.object({
  targetType: z.enum(WATCH_TARGET_TYPES, { message: "收藏只支持案件与事项" }),
});

/** 收藏开关的 body：`watching=true` 加 ⭐、`false` 取消。 */
export const favoriteSchema = z
  .object({
    watching: z.boolean({ message: "watching 必须是布尔值" }),
  })
  .strict();

export type FavoriteInput = z.input<typeof favoriteSchema>;

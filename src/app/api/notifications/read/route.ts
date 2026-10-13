import { z } from "zod";
import { body, json, withActor } from "@/app/lib/server/http";
import { markNotificationsRead } from "@/app/lib/server/services/notifications";

/**
 * 标记已读（F4-4 / `last_read_at` 那一档）。
 *
 * 两种形态放在**同一个端点**上，因为它们改的是同一件事（我的未读集合），
 * 分成两个端点会让"全部已读"与"逐条已读"各写一遍 `user_id` 条件——
 * 而那个条件正是"不许清别人的未读"的唯一防线。
 *
 * `ids` 与 `all` 互斥：同时给会被 schema 拒（`strict()` + `refine`），
 * 而不是让服务层挑一个——"两个都给时按哪个走"是没有正确答案的问题。
 */
const readSchema = z
  .object({
    ids: z
      .array(z.string().regex(/^\d{1,19}$/))
      .max(200)
      .optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine((v) => (v.all === true) !== (v.ids !== undefined), {
    message: "ids 与 all 必须且只能给一个",
  });

export async function POST(req: Request) {
  const parsed = await body(req, readSchema);
  if (!parsed.ok) return parsed.res;
  return withActor(async (actor) => {
    const r = await markNotificationsRead(actor, {
      all: parsed.data.all,
      ids: parsed.data.ids,
    });
    return json({ ok: true, updated: r.updated });
  });
}

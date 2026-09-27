import { readActor } from "@/app/lib/server/auth/auth";
import { overview } from "@/app/lib/server/services/overview";
import { json, unauthorized } from "@/app/lib/server/http";

/**
 * 工作台读数。鉴权写在 handler 里而不是 middleware（禁令⑤）。
 * 这里未登录给 401 而不是 404 是刻意的：它不探测任何资源是否存在，
 * 与 `/api/session` 同一类（"问的是我是谁 / 我名下有什么"）。
 */
export async function GET() {
  const actor = await readActor();
  if (!actor) return unauthorized();
  return json(await overview(actor));
}

import { readActor } from "@/app/lib/server/auth/auth";
import { json, unauthorized } from "@/app/lib/server/http";

/**
 * 当前会话。左侧主菜单的角色/范围标签与按钮可见性都读它。
 * 这是唯一允许"未登录给 401 而不是 404"的读端点：它问的是"我是谁"，不涉及任何资源是否存在。
 */
export async function GET() {
  const actor = await readActor();
  if (!actor) return unauthorized();
  return json(actor);
}

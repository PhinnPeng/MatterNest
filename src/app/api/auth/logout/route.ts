import { destroySession } from "@/app/lib/server/auth/auth";
import { json } from "@/app/lib/server/http";

/** 退出即**删行**而不是置 revoked：会话表里不留可用凭据，离职回收（§5）复用同一条路径 */
export async function POST() {
  await destroySession();
  return json({ ok: true });
}

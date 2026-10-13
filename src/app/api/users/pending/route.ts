import { json, requirePrivilege, withActor } from "@/app/lib/server/http";
import { listPendingUsers } from "@/app/lib/server/services/users";

/**
 * 待开通队列（F6-11）：`activation_status='pending'` 的账号。
 *
 * 单列一个端点而不是让前端从列表里筛：队列是"要我做决定"的工作面，
 * 而列表是"看全貌"。两者将来会分页口径不同（队列不该分页，它应该清空）。
 */
export async function GET() {
  return withActor(async (actor) => {
    const denied = requirePrivilege(actor, "canManageUser", "管理账号");
    if (denied) return denied;
    return json({ users: await listPendingUsers() });
  });
}

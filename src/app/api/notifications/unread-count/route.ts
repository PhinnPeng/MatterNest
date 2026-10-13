import { json, withActor } from "@/app/lib/server/http";
import { countUnread, pumpNotifications } from "@/app/lib/server/services/notifications";

/**
 * 未读计数徽标（F4-2）。
 *
 * **按可见行计，不按总数**（权限草案 §7.1 原话）——判定在 `countUnread` 里，
 * 这里只是它的一个薄出口。与列表接口分开是给外壳用的：
 * 侧栏徽标不该为了拿一个数字去拉一页通知。
 *
 * 同样先 `pumpNotifications()`：否则"刚发的一条评论"要等用户点开通知中心才计数，
 * 而徽标存在的全部意义就是**在他点开之前**告诉他。
 */
export async function GET() {
  return withActor(async (actor) => {
    await pumpNotifications();
    return json({ unread: await countUnread(actor) });
  });
}

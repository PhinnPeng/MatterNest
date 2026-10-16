/**
 * 评论的 @提及**读取侧**（MATT-68 / T4b2）。
 *
 * 写入侧是 MATT-58：`mn_comment.mention_ids` 在评论落库的同一刻由
 * `notifications.ts#resolveMentionIds` 解析出来（候选=全体在职账号）。本模块做另一半：
 * 把那一列解成"此刻的名册状态"，再交给纯函数 `buildCommentParts` 切成可渲染分段。
 *
 * ## 为什么这里只有一个查询
 *
 * 一条详情页要渲染的评论 ≤ 几十条，被点名的人通常一两个。所以先**合并去重**再查一次
 * `mn_app_user`（`where id in (...)`），而不是逐条评论查一次 —— 后者是 N+1，而这里的 N
 * 是"评论条数"，随案件寿命线性增长。
 *
 * ## 为什么"在职"的判定口径与写入口径**刻意不同**
 *
 * 写入口径（`resolveMentionIds`）**只认在职账号**：把人解析成收件人，而离职/未开通的账号
 * 登不进来，给他们落投递行只会留下一堆永远不读的通知。
 *
 * 读取侧不能照抄这一条：它问的是"**这条评论上的历史事实**此刻该怎么画"。
 * 若也把非在职的人滤掉，一条当时的 @ 会在同事离职那天**静默消失**（正文里那串
 * `@张三` 由高亮变成普通文字），而通知当年确实发出去过 —— 这正是本票要挡的那类静默。
 * 所以这里**照查不误**，只把状态带出去让界面降级渲染。口径差异写在两处，不是漏改。
 */

import { inArray } from "drizzle-orm";
import {
  buildCommentParts,
  type CommentPart,
  type MentionUser,
} from "@/shared/notification/comment-body";
import { appUser } from "../db/schema";
import { getDb } from "../db/client";

type Db = Awaited<ReturnType<typeof getDb>>;
/** 只读句柄：详情读取只在事务外跑，这里不需要 `Tx` 那一份 */
type Reader = Db;

/**
 * 按 id 取被点名的人此刻的名册状态。
 *
 * `active` 的三条与写入口径同源（`is_enabled` / `activation_status` / 软删），
 * 但**不拿它当过滤条件**（见文件头最后一段）：非在职的人照样返回，只是 `active=false`。
 */
export async function loadMentionRoster(r: Reader, ids: readonly string[]): Promise<MentionUser[]> {
  const unique = [...new Set(ids)];
  // `inArray` 空数组在 drizzle 里会退化成恒假并打一行警告 —— 没有提及时不查库
  if (unique.length === 0) return [];
  const rows = await r
    .select({
      id: appUser.id,
      displayName: appUser.displayName,
      isEnabled: appUser.isEnabled,
      activationStatus: appUser.activationStatus,
      isDeleted: appUser.isDeleted,
    })
    .from(appUser)
    .where(inArray(appUser.id, unique.map(BigInt)));
  return rows.map((row) => ({
    id: String(row.id),
    displayName: row.displayName,
    active: row.isEnabled && row.activationStatus === "active" && !row.isDeleted,
  }));
}

/**
 * 一组评论的 @提及分段，**按评论 id 索引**。
 *
 * 为什么返回 Map 而不是与入参等长的数组：调用方要在中间做排序/过滤是迟早的事，
 * 位置对齐的数组会在那天静默错位（前端的评论列表本来就可增可删）。
 */
export async function mentionPartsOf(
  r: Reader,
  comments: readonly { id: bigint; body: string; mentionIds: readonly bigint[] }[],
): Promise<Map<string, CommentPart[]>> {
  const roster = await loadMentionRoster(
    r,
    comments.flatMap((c) => c.mentionIds.map(String)),
  );
  const byId = new Map(roster.map((u) => [u.id, u] as const));
  const out = new Map<string, CommentPart[]>();
  for (const c of comments) {
    // `mention_ids` 里有、名册里查不到的人（一期用户只软删，理论到不了）：没有名字可定位 ⇒ 不产生提及段
    const mentioned = c.mentionIds.map(String).flatMap((id) => {
      const u = byId.get(id);
      return u ? [u] : [];
    });
    out.set(String(c.id), buildCommentParts(c.body, mentioned));
  }
  return out;
}

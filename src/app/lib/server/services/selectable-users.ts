import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import type { Actor } from "@/app/lib/server/auth/auth";
import { getDb } from "@/app/lib/server/db/client";
import { appUser } from "@/app/lib/server/db/schema";
import { HOSTS, visibility, type HostKind } from "@/app/lib/server/scope/visibility";

/**
 * 可选用户查询（权限草案 §4.1 / §6 被加者条件，PRD F6-7）。
 *
 * ## 为什么是独立端点，而不是在 `/api/meta` 上加个 `users` 字段
 *
 * §4.1 明写：**裸 `/users` 列表接口第一期不提供**（`can_manage_user` 除外）。
 * 原因是收窄之后新出现了一个人员枚举探测面——能列出全部在册同事就等于拿到一份花名册。
 * 所以这条接口**必须带宿主上下文**（`/risk-matters/{id}/selectable-users`）：
 * 知道事项 id 是前提，跨宿主翻页一律拒绝。
 *
 * 这也正是事项详情页「变更处理人」弹窗一直空着的原因：它去问 `/api/meta?host=matter`
 * 要 `users`，而那个接口的返回键只有 `actor / statuses / levels / tags / enums`——
 * 没有 `users`，而且按规格也不该有。
 *
 * ## 三个条件缺一不可（§6 原文）
 *
 * `is_enabled = true` **且** `activation_status = 'active'` **且** 落在操作者的可见用户集内。
 *
 * 第二个条件是**防旁路**：云之家首登自动建号但管理员未批准的 `pending` 账号若能被加进案卷，
 * 等于绕过批准直接取得读写。§4.1 伪码里的 `(u.is_enabled)` 是简写，§6 才是完整条件。
 *
 * 第三个条件是防"把自己没见过的案卷开放给全公司同事"：L1 等价于"全公司任何人皆可加"，
 * 其余只能加与自己**共现于同一宿主**的人。
 *
 * ## 规格没写、但这里必须加的一条
 *
 * §4.1 成文于软删出现之前，所以没有 `is_deleted`。**这条必须带上**：把已软删（离职）的
 * 同事列为可选处理人，等于让人把活派给一个已经不在的人。F5 刚把登录这条路堵上，
 * 这条是同一件事的另一面——**登录挡住不等于派活也挡住**。
 *
 * ## 创建期例外不在这里
 *
 * IQ-14：登记表单上的处理人/关注人选择面放开为全体 `is_enabled` 且 `active` 用户，
 * 不受共现集限制。那是**创建表单**的规则，由新建对话框自己处理，不并进本函数——
 * 两条口径混在一个函数里，调用方就分不清该走哪条。
 */

/** §4.1：「分页上限 50，不接受跨宿主批量列举」 */
const PAGE_LIMIT = 50;

export type SelectableUser = { id: string; displayName: string; username: string };

/**
 * 列出**可以**被加进这个宿主的人。
 *
 * 返回 `null` = 宿主本身你看不见或不存在 → 调用方给 404，与元规则 3 一致
 * （不给"存在但你无权选人"这种可区分的信号）。
 */
export async function listSelectableUsers(
  actor: Actor,
  host: HostKind,
  hostId: string,
): Promise<SelectableUser[] | null> {
  const db = await getDb();
  const h = HOSTS[host];
  const uid = BigInt(actor.userId);

  // ① 宿主可见性先行：看不见这个宿主，就没有"在这里选人"这件事
  const hostVisible = visibility(host, actor.dataScope, actor.userId, actor.isAdmin ?? false);
  const hostRow = await db
    .select({ id: h.hostId })
    .from(h.table)
    .where(and(sql`NOT ${h.table.isDeleted}`, hostVisible, eq(h.hostId, BigInt(hostId))) as SQL)
    .limit(1);
  if (!hostRow[0]) return null;

  // ② 共现谓词（§4.1 伪码那两条 EXISTS）：
  //    候选人是否出现在"我**看得见**的某个宿主"里。两个宿主各查一次。
  //
  // ⚠ 这些分支必须用 drizzle 的 `or()` 组合，**不能** `parts.join(" and ")`——
  //   那是把 SQL 片段对象按字符串拼，绑定参数会整个丢掉，谓词静默失真。
  //   实测症状：L2 的可选集返回 0 人，连"我自己"都选不到。
  const parts: SQL[] = [sql`${appUser.id} = ${uid}`];
  for (const other of ["matter", "risk_matter"] as const) {
    const oh = HOSTS[other];
    const innerVisible = visibility(other, actor.dataScope, actor.userId, actor.isAdmin ?? false);
    // 范围谓词引用的都是绝对列名（ownerId/creatorId），放进子查询可直接用；
    // L1 时 `innerVisible` 为 undefined → 谓词省掉，即"看得见全部"。
    const scopeCond = innerVisible ?? sql`true`;
    parts.push(sql`(exists (
      select 1 from ${oh.staff}
      where ${oh.staff.userId} = ${appUser.id}
        and exists (
          select 1 from ${oh.table}
          where ${oh.hostId} = ${oh.staff.hostId}
            and not ${oh.table.isDeleted}
            and ${scopeCond}
        )
    ))`);
  }

  // ③ L1 不加共现限制（§4.1 语义行：L1 等价于"全公司任何人皆可加"）
  const isL1 = (actor.isAdmin ?? false) || actor.dataScope === "all";
  // `parts` 恒非空，所以 `or()` 不会返回 undefined；TS 不知道这一点，显式兜一句。
  const withinVisibleUserSet: SQL = isL1 ? sql`true` : (or(...parts) as SQL);

  const rows = await db
    .select({
      id: appUser.id,
      displayName: appUser.displayName,
      username: appUser.username,
    })
    .from(appUser)
    .where(
      and(
        eq(appUser.isEnabled, true),
        eq(appUser.activationStatus, "active"),
        eq(appUser.isDeleted, false),
        withinVisibleUserSet,
      ) as SQL,
    )
    // 自己排最后：下拉里最不需要的一项就是"我自己"
    .orderBy(sql`case when ${appUser.id} = ${uid} then 1 else 0 end`, asc(appUser.displayName))
    .limit(PAGE_LIMIT);

  return rows.map((r) => ({
    id: String(r.id),
    displayName: r.displayName,
    username: r.username,
  }));
}

/**
 * 把"当前处理人"并进列表。
 *
 * 场景：现任处理人若不在可选集内（比如他是 L2/L3 视角之外的同事），
 * 换人下拉里若只有别人，界面上就会**看不出现在是谁在办**。所以先把他补回去。
 */
export function mergeCurrent(
  list: SelectableUser[],
  current: { id: string; displayName: string } | null | undefined,
): SelectableUser[] {
  if (!current) return list;
  if (list.some((u) => u.id === current.id)) return list;
  return [{ id: current.id, displayName: current.displayName, username: "" }, ...list];
}

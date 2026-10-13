import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
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

/** 不能被指派的原因。分开列出来是为了让拒绝文案说清"他怎么了"，而不是一句"不合法" */
export type UnassignableReason = "disabled" | "not_activated" | "deleted" | "unknown";

export type UnassignableUser = { id: string; username: string | null; reason: UnassignableReason };

/**
 * 这批人**能不能被指派**（承办 / 协办 / 关注）。
 *
 * 返回不能被指派的人；**空数组 = 全部可指派**。调用方负责决定"部分不行"是整请求拒还是跳过。
 *
 * ## 为什么这是一个独立函数，而不是"写路径自己查一下"
 *
 * 它有三条使用路径，而三条的**来源不同**：
 *   · 创建表单的处理人/关注人 —— 走 IQ-14 的**创建期例外**（全体在册可用用户，不受共现集限制）；
 *   · 给已有宿主加参与人 —— 先过 §4.1 的可见用户集（`listSelectableUsers`），再过这里；
 *   · **改归属**（`ownerId` 字段编辑）—— 没有任何下拉能约束它，只有这里。
 *
 * 三条路各写一遍"他是不是在册可用"，就会出现"创建时挡住了、改归属时没挡"这种半拉子状态，
 * 而那个洞不会报错：只是某个已离职的人又能被派活。
 *
 * ## 三条判据与 §4.1/§6 同源
 *
 * `is_enabled`（停用/离职）· `activation_status='active'`（防旁路：未批准的 `pending` 账号
 * 若能进案卷就等于绕过批准）· `is_deleted`（§4.1 成文于软删之前，这条是补的）。
 */
export async function findUnassignable(userIds: readonly string[]): Promise<UnassignableUser[]> {
  const ids = [...new Set(userIds)].map((u) => BigInt(u));
  if (ids.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .select({
      id: appUser.id,
      username: appUser.username,
      isEnabled: appUser.isEnabled,
      activationStatus: appUser.activationStatus,
      isDeleted: appUser.isDeleted,
    })
    .from(appUser)
    .where(inArray(appUser.id, ids));

  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const bad: UnassignableUser[] = [];
  for (const id of ids) {
    const r = byId.get(String(id));
    if (!r) {
      bad.push({ id: String(id), username: null, reason: "unknown" });
      continue;
    }
    const reason: UnassignableReason | null = r.isDeleted
      ? "deleted"
      : !r.isEnabled
        ? "disabled"
        : r.activationStatus !== "active"
          ? "not_activated"
          : null;
    if (reason) bad.push({ id: String(id), username: r.username, reason });
  }
  return bad;
}

/** 中文原因：拒绝文案要说清"他怎么了"，不能只给一个 code（前端也不该再抄一份翻译） */
export const UNASSIGNABLE_LABELS: Record<UnassignableReason, string> = {
  disabled: "已停用",
  not_activated: "未开通（待批准）",
  deleted: "已删除",
  unknown: "不存在",
};

/**
 * 被指派者不合格时抛这个。**照 `UnknownPartyError` 的既有形状**（路由层 catch 后翻成 4xx），
 * 而不是让每个调用方各自检查返回值——创建路径的返回值是普通对象（不是结果联合），
 * 改成联合会让三个路由跟着改签名，而这条校验本身只有一句话。
 */
export class UnassignableAssigneeError extends Error {
  readonly bad: UnassignableUser[];
  constructor(bad: UnassignableUser[]) {
    super(
      `这些人不能被指派：${bad
        .map((b) => `${b.username ?? b.id}（${UNASSIGNABLE_LABELS[b.reason]}）`)
        .join("、")}`,
    );
    this.name = "UnassignableAssigneeError";
    this.bad = bad;
  }
}

/**
 * 断言这批人都能被指派，不合格就抛 `UnassignableAssigneeError`。
 *
 * 用于**没有下拉能约束**的那些入口：创建时的处理人、改归属的 `ownerId`。
 * 下拉能挡住手滑，挡不住构造好的请求——所以判定必须在写路径上真的跑一遍。
 */
export async function assertAssignable(userIds: readonly (string | null | undefined)[]) {
  const ids = userIds.filter((u): u is string => typeof u === "string" && u.length > 0);
  if (ids.length === 0) return;
  const bad = await findUnassignable(ids);
  if (bad.length) throw new UnassignableAssigneeError(bad);
}

/**
 * 创建期例外（IQ-14）：**全体在册且已开通**的用户，不受共现集限制。
 *
 * 裁定原文：登记表单上的处理人与关注人选择面，放开为全体「在册且已开通」的用户；
 * 理由是**首次上报的业务同事共现集为空**——不放开的话，「处理人可选填」对新上报人
 * 根本不可用（他一个同事都选不到）。
 *
 * §4.1 挡的是"往**已有案卷**里加人"这个动作（那是权限外溢），不是"新建时填一个处理人"。
 * 裁定也把这层顾虑说清了：十人组织，花名册无保密价值，防枚举在这里是空转。
 *
 * ## 边界（写进代码，因为它是唯一容易越界的地方）
 *
 * · **只给创建表单用**。给已有宿主加人一律走 `listSelectableUsers`（带宿主上下文、有共现收窄）。
 * · `pending` 账号仍然排除——那是"绕批防线"，裁定明文保留。
 * · 软删与停用排除（与 `findUnassignable` 同源判据，只是这里不过共现集）。
 */
export async function listUsersForCreate(): Promise<SelectableUser[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: appUser.id, displayName: appUser.displayName, username: appUser.username })
    .from(appUser)
    .where(
      and(
        eq(appUser.isEnabled, true),
        eq(appUser.activationStatus, "active"),
        eq(appUser.isDeleted, false),
      ),
    )
    .orderBy(asc(appUser.displayName))
    .limit(PAGE_LIMIT);
  return rows.map((r) => ({
    id: String(r.id),
    displayName: r.displayName,
    username: r.username,
  }));
}

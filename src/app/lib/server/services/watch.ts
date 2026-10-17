import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nextId } from "@/shared/ids/snowflake";
import { WATCH_TARGET_TYPES } from "@/shared/schema/watch";
import { getDb } from "../db/client";
import { matter, riskMatter, userWatch } from "../db/schema";
import { HOSTS, scopedWhere, type HostKind } from "../scope/visibility";
import type { Actor } from "../auth/auth";

type Db = Awaited<ReturnType<typeof getDb>>;
/** 事务句柄：从 `transaction` 的回调参数上取，比自己拼 PgTransaction 泛型稳（drizzle 小版本改过形状） */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 收藏 ⭐（F1-13）与关注同步（ADR-0003 的落实）—— `mn_user_watch` 的**唯一写入方**。
 *
 * ## 这张表此前零写入方
 *
 * 表建了（迁移 0010）、值域定了（E05：`follow` | `favorite`）、ADR-0003 引用了它，
 * 但 `grep mn_user_watch` 只有 schema 定义与注释——**没有任何一处写它**。
 * 于是「收藏 ⭐」这条 PRD 已结案的功能行（F1-13）从未实现。
 *
 * ## 两个角色，方向相反，别搞反
 *
 * · `favorite` —— **本人主动**行为：我点了 ⭐。只受可见性门，不受名单管理权约束。
 * · `follow`   —— **由 `*_staff` 同步生成**：别人把我加进关注人名单，或我自己点眼睛。
 *   它**不接受用户直接写入**（`USER_OWNABLE_WATCH_TYPES` 只有 `favorite`）——
 *   否则「我关注」与「关注人名单」就成了两份真相，而两份真相迟早对不上。
 *
 * ## IQ-13 的边界（别搞反）
 *
 * IQ-13-V5 说「创建者的回音经通知中心送达；**不写 `user_watch`、不入关注列表**」——
 * 那说的是「**不把 creator 当作 follower 写进去**」，**不是**「不实现收藏」。
 * ⭐ 是本人主动行为，与「被动入列」正好相反。T4 交付的两条「不写 user_watch」断言
 * 钉的是 creator 不被写成 follower，本模块不破它。
 *
 * ## 为什么 `follow` 只对 `matter`/`risk_matter` 两个宿主
 *
 * 眼睛与 ⭐ 都挂在**宿主**上（详情页的控件），ADR-0003 说的也是「关注该事项的最新动态」。
 * 节点/进展/费用这些从属对象的关注没有产品依据，不做（schema 的 TARGET_TYPES 更宽，
 * 那是给审计与通知用的，不是给本模块用的）。
 */

/** ⭐ 只挂宿主：见文件头「为什么只对两个宿主」。
 *
 * **值域不在这里定义**——直接引 `WATCH_TARGET_TYPES`（=`HOST_TYPES`，`shared/enums/targets.ts`）。
 * 这行曾经自己写一遍 `["matter", "risk_matter"]`，与 schema 那份各占一处；
 * `type-safety.md` 明写「**禁止**在 `src/app/**` 里再声明一份业务枚举」。
 */
export const WATCH_HOST_KINDS = WATCH_TARGET_TYPES satisfies readonly HostKind[];

export type WatchHostKind = (typeof WATCH_HOST_KINDS)[number];

export function isWatchHostKind(v: string): v is WatchHostKind {
  return (WATCH_HOST_KINDS as readonly string[]).includes(v);
}

/**
 * 这条宿主对**我**是否可见（默认拒绝）。
 *
 * 复用 `scopedWhere`（可见性唯一出口）——**不自己拼范围条件**。
 * 看不见 ⇒ 不能收藏、不能关注，也不出现在「我收藏的」里。
 */
async function hostVisible(actor: Actor, host: WatchHostKind, hostId: string): Promise<boolean> {
  const db = await getDb();
  const t = HOSTS[host].table;
  const [row] = await db
    .select({ id: t.id })
    .from(t)
    .where(scopedWhere(host, actor, eq(t.id, BigInt(hostId))))
    .limit(1);
  return Boolean(row);
}

export type WatchToggleResult =
  { ok: true; watching: boolean } | { ok: false; why: "not_found" | "bad_target" };

/**
 * 加 ⭐ / 取消 ⭐（F1-13）。**幂等**：重复点不报 500。
 *
 * 幂等的做法是 `onConflictDoNothing` + 唯一键 `uk_mn_user_watch_triple`
 * （§8.1 的 `(user_id, target_type, target_id)`）——不是先 SELECT 再 INSERT：
 * 后者在两个请求并发时仍会撞唯一键，而那一刻正好是最该安静的时候（用户连点两下）。
 *
 * 取消是**硬删**（表刻意不带 `is_deleted`，`schema/notifications.ts:172` 写明理由：
 * 软删 + 三列唯一键会撞死结——取消后重新点 ⭐ 会违反唯一键，报错还长得像「系统坏了」）。
 */
export async function setFavorite(
  actor: Actor,
  host: string,
  hostId: string,
  watching: boolean,
): Promise<WatchToggleResult> {
  if (!isWatchHostKind(host)) return { ok: false, why: "bad_target" };
  if (!(await hostVisible(actor, host, hostId))) return { ok: false, why: "not_found" };

  const db = await getDb();
  const me = BigInt(actor.userId);
  const target = BigInt(hostId);

  if (watching) {
    await db
      .insert(userWatch)
      .values({
        id: BigInt(nextId()),
        userId: me,
        targetType: host,
        targetId: target,
        watchType: "favorite",
        createdBy: me,
      })
      .onConflictDoNothing();
  } else {
    await db
      .delete(userWatch)
      .where(
        and(
          eq(userWatch.userId, me),
          eq(userWatch.targetType, host),
          eq(userWatch.targetId, target),
          eq(userWatch.watchType, "favorite"),
        ),
      );
  }
  return { ok: true, watching };
}

export type FavoriteRow = {
  targetType: WatchHostKind;
  targetId: string;
  /** 宿主显示名（案件名 / 事项名）；宿主已删或不可见时不会出现在结果里 */
  title: string;
  /** 宿主编号（案件内部编号 / 事项编号），列表第二行 */
  subtitle: string;
  isArchived: boolean;
  createdAt: string;
};

/**
 * 我收藏的（F1-13 的查询面）。
 *
 * **权限问题，不是过滤问题**（票面原话）：不可见的记录**不出现**在结果里，
 * 而不是"出现了再标灰"。做法是逐宿主过 `scopedWhere`——两个宿主各一次查询再合并，
 * 而不是把 `mn_user_watch` 全捞回来再过滤：那样"我收藏的"会随我的范围收缩而
 * 越捞越多无用的行，且把可见性判定散到了两处。
 *
 * 已归档的**保留**（`isArchived` 如实带出）：收藏是"我还想看这条"，
 * 归档恰恰是"它结束了、我可能还要回看"——不在这里替用户做减法。
 */
export async function listMyFavorites(actor: Actor): Promise<FavoriteRow[]> {
  const db = await getDb();
  const me = BigInt(actor.userId);

  const mine = await db
    .select({
      targetType: userWatch.targetType,
      targetId: userWatch.targetId,
      createdAt: userWatch.createdAt,
    })
    .from(userWatch)
    .where(and(eq(userWatch.userId, me), eq(userWatch.watchType, "favorite")))
    .orderBy(desc(userWatch.createdAt));
  if (mine.length === 0) return [];

  const out: FavoriteRow[] = [];

  for (const host of WATCH_HOST_KINDS) {
    const ids = mine.filter((m) => m.targetType === host).map((m) => m.targetId);
    if (ids.length === 0) continue;

    const t = HOSTS[host].table;
    // 两个宿主的编号列不同名（`internal_code` / `code`），所以这里分支取——
    // 与 `keywordFilter` 同一种做法（它也为两宿主各写一份条件）。
    const rows = await db
      .select({
        id: t.id,
        name: t.name,
        isArchived: t.isArchived,
        subtitle:
          host === "matter"
            ? sql<string>`${(t as typeof matter).internalCode}`
            : sql<string>`${(t as typeof riskMatter).code}`,
      })
      .from(t)
      .where(scopedWhere(host, actor, inArray(t.id, ids)));

    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const m of mine) {
      if (m.targetType !== host) continue;
      const r = byId.get(String(m.targetId));
      // 不可见 / 已硬删 ⇒ 不出现（权限问题，不是过滤问题）
      if (!r) continue;
      out.push({
        targetType: host,
        targetId: String(m.targetId),
        title: r.name,
        subtitle: r.subtitle ?? "",
        isArchived: r.isArchived,
        createdAt: m.createdAt,
      });
    }
  }

  // 合并后按收藏时间倒序（两个宿主各自有序，合起来要重排一次）
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}

/** 我是否收藏了这条（详情页控件初值）。不可见一律 `false`（不泄露存在性）。 */
export async function isFavorited(actor: Actor, host: string, hostId: string): Promise<boolean> {
  if (!isWatchHostKind(host)) return false;
  const db = await getDb();
  const [row] = await db
    .select({ userId: userWatch.userId })
    .from(userWatch)
    .where(
      and(
        eq(userWatch.userId, BigInt(actor.userId)),
        eq(userWatch.targetType, host),
        eq(userWatch.targetId, BigInt(hostId)),
        eq(userWatch.watchType, "favorite"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * 关注同步（ADR-0003 的落实）：`follower` 行增删时，连带写/删 `user_watch(follow)`。
 *
 * ## 为什么是同步写而不是读时推导
 *
 * `user_watch(follow)` 有自己的列（`last_read_at`）与读侧口径，它不是 `*_staff` 的视图——
 * ADR-0003 明写「我点一下，我就出现在名单里、计数 +1」，即**两个面同一次动作**。
 * 读时推导会让「我关注」的置位时刻漂移，而"什么时候开始关注的"正是它要记的东西。
 *
 * ## 为什么要传 `tx`
 *
 * 同步必须是**同一个事务**：名单加了、watch 没加（或反过来）会留下两份互相打架的真相，
 * 而两边各自都"成功"了 —— 这正是本仓最怕的静默失败形态。
 *
 * ## 幂等与反向
 *
 * 加：`onConflictDoNothing` —— 同一个人可能既在名单里又是创建人，重复写要安静。
 * 删：`delete ... where` —— 不存在即无事发生（取消关注 = 删自己那一行，ADR-0003）。
 * **没有"直接写 follow"的对外入口**：`USER_OWNABLE_WATCH_TYPES` 不含 `follow` 正是为此，
 * 于是"不加关注人就不得有 follow 行"由结构保证，不靠纪律。
 */
export async function syncFollowWatch(
  tx: Tx,
  args: {
    host: WatchHostKind;
    hostId: bigint;
    userIds: readonly bigint[];
    action: "add" | "remove";
  },
): Promise<void> {
  const ids = [...new Set(args.userIds)];
  if (ids.length === 0) return;

  if (args.action === "add") {
    await tx
      .insert(userWatch)
      .values(
        ids.map((userId) => ({
          id: BigInt(nextId()),
          userId,
          targetType: args.host,
          targetId: args.hostId,
          watchType: "follow" as const,
          // `follow` 由他人指派生成，`created_by` 记的是**指派者**（谁给加的这条关注）。
          // 自我关注时指派者就是自己，两者重合，不需要分支。
          createdBy: userId,
        })),
      )
      .onConflictDoNothing();
    return;
  }

  await tx
    .delete(userWatch)
    .where(
      and(
        eq(userWatch.targetType, args.host),
        eq(userWatch.targetId, args.hostId),
        eq(userWatch.watchType, "follow"),
        inArray(userWatch.userId, ids),
      ),
    );
}

import { and, eq, inArray } from "drizzle-orm";

import type { Actor } from "../auth/auth";
import type { getDb } from "../db/client";
import { matterStaff, riskMatterStaff } from "../db/schema";
import type { HostKind } from "../scope/visibility";

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

/**
 * 谁能动一条节点的**归属类**操作（编辑 / 取消 / 删除）。
 *
 * 2026-10-23 的裁定（grill 轮 Q2，用户选「其他推荐」）：
 *   · **开始 / 完成**是进度事实 —— 能看见这条宿主的人都能标，协办与关注同样要能推进；
 *   · **编辑 / 取消 / 删除**会改写期限或抹掉一条期限 —— 限有归属的人：
 *     节点负责人、宿主负责人、创建人、协办，或 L1 / `is_admin`。
 *
 * ## 为什么不是 `ownsAttribution` 一把梭
 *
 * 那条护栏管的是**宿主**的归属与状态（§2.2），节点是明细；用宿主级的判定去管节点，
 * 会让"我只是帮这条案子记个完成"也被挡在门外 —— 而 Q2 的裁定恰恰要把这两类分开。
 */
export async function canManageNode(
  db: Conn,
  actor: Actor,
  host: HostKind,
  hostId: bigint,
  facts: {
    nodeOwnerId: bigint | null;
    hostOwnerId: bigint | null;
    hostCreatorId: bigint | null;
  },
): Promise<boolean> {
  if (actor.isAdmin || actor.dataScope === "all") return true;
  const uid = String(actor.userId);
  const same = (v: bigint | null) => v !== null && String(v) === uid;
  if (same(facts.nodeOwnerId) || same(facts.hostOwnerId) || same(facts.hostCreatorId)) {
    return true;
  }

  // 两套同构 staff 表分开写：用 `HOSTS[host]` 联合类型会把 drizzle 的列引用收成 never
  const rows =
    host === "matter"
      ? await db
          .select({ id: matterStaff.id })
          .from(matterStaff)
          .where(
            and(
              eq(matterStaff.hostId, hostId),
              eq(matterStaff.userId, BigInt(actor.userId)),
              inArray(matterStaff.staffRole, ["owner", "co_owner"]),
            ),
          )
          .limit(1)
      : await db
          .select({ id: riskMatterStaff.id })
          .from(riskMatterStaff)
          .where(
            and(
              eq(riskMatterStaff.hostId, hostId),
              eq(riskMatterStaff.userId, BigInt(actor.userId)),
              inArray(riskMatterStaff.staffRole, ["owner", "co_owner"]),
            ),
          )
          .limit(1);
  return rows.length > 0;
}

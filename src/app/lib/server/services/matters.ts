import { and, asc, count as dcount, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { nextId } from "@/shared/ids/snowflake";
import { listQuerySchema, SORTABLE_COLUMNS } from "@/shared/schema/list-query";
import { needsChangeReason } from "@/shared/schema/status-transition";
import { getDb } from "../db/client";
import {
  activityLog,
  comment,
  matter,
  matterNode,
  matterStaff,
  matterParty,
  matterProgress,
  party,
  statusConfig,
} from "../db/schema";
import { archivedFilter, keywordFilter, scopedWhere } from "../scope/visibility";
import { ownsAttribution } from "../scope/guards";
import { insertPlannedNodes, planPresetNodesFor } from "./nodes";
import { insertNewParties, planPartyLinks } from "./parties";
import type { PartyLinkInput } from "./parties";
import type { Actor } from "../auth/auth";
import { nextCode } from "./numbering";
import { initialStatusCode, hostStatusRows } from "./statuses";
import { logActivity } from "./activity";
import { NODE_STATUS_LABELS } from "@/shared/enums/business";

/**
 * 宿主读写（案件的列表 / 详情 / 建案 / 状态变更 / 节点 / 评论）。
 *
 * 这一层的存在理由是禁令⑤ 与 §4「禁止裸表访问」：**每个函数第一个参数都是 actor**，
 * 少传就编译不过。这样"忘了套范围"是类型错误而不是 review 才抓得到的漏洞
 * （Nest 时代靠 Guard 链结构性保证，换 Next 后由这个签名形状承担）。
 *
 * 编号、活动日志、状态变更三处都写库同事务：`activity_log` 与业务写不同事务
 * 会出现"改了没记"或"记了没改"（权限草案 §7.3）。
 */

/**
 * 入参类型直接取 shared DTO 的**输出**类型，不再手抄一遍。
 * 抄一份的代价已经出现过一次：本地写 `sortBy?: string`，于是 `SORTABLE[...]` 收任何字符串都编译得过，
 * 白名单形同虚设。现在 sortBy 是那 8 个字面量的联合，越界在编译期就红。
 */
export type ListQuery = z.infer<typeof listQuerySchema>;

/**
 * 排序键**必须是 `list-query` 的 `SORTABLE_COLUMNS`**，这里只做"键 → 列"的映射。
 * 用 snake_case 与 N7 spike 保持一致：查询串、DTO、列名三方同一个写法，
 * 少一层驼峰转换就少一处"前端传 sortBy=updated_at、服务端读 updatedAt 拿到 undefined"的坑。
 *
 * 类型写成 `Record<SORTABLE_COLUMNS, SQL>` 而不是 `Record<string, SQL>`：
 * 后者少一个键不会报错，只会让那个排序静默退回 `updated_at`（用户点了表头、数据没动）。
 * 现在少键报"缺属性"、多键报"多余属性"，两边都在编译期红掉。
 */
const SORTABLE: Record<(typeof SORTABLE_COLUMNS)[number], SQL> = {
  code: sql`${matter.internalCode}`,
  name: sql`${matter.name}`,
  status: sql`${matter.status}`,
  risk_level: sql`${matter.level}`,
  // 承办人姓名不在案件表上（列表靠相关子查询带出），排序沿用同一个子查询，
  // 否则"看到的承办人"与"排出来的承办人"可能不是同一个表达式。
  owner_name: sql`(select u.display_name from mn_app_user u where u.id = ${matter.ownerId})`,
  amount: sql`${matter.amount}`,
  created_at: sql`${matter.createdAt}`,
  updated_at: sql`${matter.updatedAt}`,
};

export async function listMatters(actor: Actor, q: ListQuery) {
  const db = await getDb();
  const where = and(
    scopedWhere("matter", actor),
    archivedFilter("matter", Boolean(q.includeArchived)),
    q.status ? eq(matter.status, q.status) : undefined,
    keywordFilter("matter", q.keyword),
  );
  // 这里不再有 `?? matter.updatedAt` 兜底：SORTABLE 的键集合由类型保证与白名单相等，
  // 兜底反而会掩盖"新加了一列却忘了配映射"。
  const col = SORTABLE[q.sortBy ?? "updated_at"];
  const order = q.sortDir === "asc" ? asc(col) : desc(col);

  const [totalRow] = await db.select({ n: dcount() }).from(matter).where(where);
  const rows = await db
    .select({
      id: matter.id,
      internalCode: matter.internalCode,
      caseNo: matter.caseNo,
      name: matter.name,
      cause: matter.cause,
      caseType: matter.caseType,
      procedure: matter.procedure,
      litigationRole: matter.litigationRole,
      court: matter.court,
      amount: matter.amount,
      level: matter.level,
      status: matter.status,
      isArchived: matter.isArchived,
      ownerName: appUserName(),
      updatedAt: matter.updatedAt,
      nextDeadline: sql<string | null>`(select min(n.deadline_time) from mn_matter_node n
        where n.matter_id = ${matter.id} and not n.is_deleted
          and n.status in ('not_started','in_progress'))`,
    })
    .from(matter)
    .where(where)
    .orderBy(order, desc(matter.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  return {
    items: rows.map((r) => ({
      ...r,
      id: String(r.id),
      amount: r.amount,
      nextDeadline: r.nextDeadline ?? null,
    })),
    page: q.page,
    pageSize: q.pageSize,
    total: Number(totalRow?.n ?? 0),
  };
}

/** 承办人姓名：同一次查询里带出来，避免列表页 N+1 */
function appUserName() {
  return sql<string>`(select u.display_name from mn_app_user u where u.id = ${matter.ownerId})`;
}

export async function getMatter(actor: Actor, id: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(matter)
    .where(scopedWhere("matter", actor, eq(matter.id, BigInt(id))))
    .limit(1);
  if (!row) return null; // → 404，不给 403（元规则 3）

  const [nodes, staff, parties, comments, activity, statuses, progress] = await Promise.all([
    db
      .select({
        id: matterNode.id,
        hostId: matterNode.hostId,
        nodeTypeId: matterNode.nodeTypeId,
        /** 节点类型名跟着带出来：不 join 就得让前端再发一次字典请求，而字典里根本没有类型这一栏 */
        nodeType: sql<string>`(select c.name from mn_node_type_config c where c.id = ${matterNode.nodeTypeId})`,
        name: matterNode.name,
        timeType: matterNode.timeType,
        startTime: matterNode.startTime,
        endTime: matterNode.endTime,
        isTimeConfirmed: matterNode.isTimeConfirmed,
        deadlineTime: matterNode.deadlineTime,
        status: matterNode.status,
        sourceKind: matterNode.sourceKind,
        ownerId: matterNode.ownerId,
        ownerName: sql<
          string | null
        >`(select u.display_name from mn_app_user u where u.id = ${matterNode.ownerId})`,
        sortOrder: matterNode.sortOrder,
        remark: matterNode.remark,
        completedAt: matterNode.completedAt,
        cancelReason: matterNode.cancelReason,
      })
      .from(matterNode)
      .where(and(eq(matterNode.hostId, BigInt(id)), sql`NOT ${matterNode.isDeleted}`))
      .orderBy(asc(matterNode.deadlineTime)),
    db
      .select({
        id: matterStaff.id,
        staffRole: matterStaff.staffRole,
        userId: matterStaff.userId,
        displayName: sql<string>`(select u.display_name from mn_app_user u where u.id = ${matterStaff.userId})`,
      })
      .from(matterStaff)
      .where(eq(matterStaff.hostId, BigInt(id))),
    db
      .select({
        id: matterParty.id,
        /**
         * 当事人**本体**的 id。这里只给关联行 id 是不够的：转案件与快速新增的差别就是
         * "这一行是不是共享实体"（§7.2），前端要跳当事人详情、要提示"改名称会同步到 N 个案件"
         * （映射 §2.6）都得用它。
         */
        partyId: matterParty.partyId,
        partyRole: matterParty.partyRole,
        represented: matterParty.represented,
        name: party.name,
        type: party.type,
        idNumber: party.idNumber,
      })
      .from(matterParty)
      .innerJoin(party, eq(party.id, matterParty.partyId))
      .where(eq(matterParty.hostId, BigInt(id))),
    db
      .select({
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        parentId: comment.parentId,
        author: sql<string>`(select u.display_name from mn_app_user u where u.id = ${comment.authorId})`,
      })
      .from(comment)
      .where(
        and(
          eq(comment.targetType, "matter"),
          eq(comment.targetId, BigInt(id)),
          sql`NOT ${comment.isDeleted}`,
        ),
      )
      .orderBy(desc(comment.createdAt)),
    db
      .select({
        id: activityLog.id,
        action: activityLog.action,
        reason: activityLog.reason,
        createdAt: activityLog.createdAt,
        operator: sql<string>`(select u.display_name from mn_app_user u where u.id = ${activityLog.operatorId})`,
      })
      .from(activityLog)
      .where(eq(activityLog.matterId, BigInt(id)))
      .orderBy(desc(activityLog.createdAt))
      .limit(30),
    hostStatusRows("matter"),
    db
      .select({
        id: matterProgress.id,
        progressType: matterProgress.progressType,
        content: matterProgress.content,
        nextPlan: matterProgress.nextPlan,
        progressDate: matterProgress.progressDate,
        createdAt: matterProgress.createdAt,
        author: sql<string>`(select u.display_name from mn_app_user u where u.id = ${matterProgress.authorId})`,
      })
      .from(matterProgress)
      .where(and(eq(matterProgress.matterId, BigInt(id)), sql`NOT ${matterProgress.isDeleted}`))
      .orderBy(desc(matterProgress.progressDate)),
  ]);

  return {
    ...row,
    id: String(row.id),
    ownerId: String(row.ownerId),
    nodes: nodes.map((n) => ({ ...n, id: String(n.id), hostId: String(n.hostId) })),
    staff: staff.map((s) => ({ ...s, id: String(s.id), userId: String(s.userId) })),
    parties: parties.map((p) => ({ ...p, id: String(p.id) })),
    comments: comments.map((c) => ({ ...c, id: String(c.id) })),
    activity: activity.map((a) => ({ ...a, id: String(a.id) })),
    progress: progress.map((p) => ({ ...p, id: String(p.id) })),
    statuses,
  };
}

/** 建案：编号在这里生成，与业务写、活动日志同事务（§12.3 + §7.3） */
export async function createMatter(
  actor: Actor,
  input: {
    name: string;
    cause: string;
    caseType: string;
    procedure: string;
    litigationRole: string;
    court?: string | null;
    amount?: string;
    level: string;
    caseNo?: string | null;
    filingDate?: string | null;
    ownerId?: string;
    description?: string | null;
    /** 引用既有（`partyId`）或快速新增（名称+类型），见 `services/parties.ts` */
    parties?: PartyLinkInput[];
  },
) {
  const db = await getDb();
  const { code } = await nextCode("matter");
  const id = BigInt(nextId());
  const owner = BigInt(input.ownerId ?? actor.userId);

  /** 初始态从配置表取，不写字面量 —— 理由见 `services/statuses.ts` */
  const initial = await initialStatusCode("matter");
  /** P1 预设节点同理由：取配置必须在进事务之前，事务内再向池子要一条连接会互等成死锁 */
  const presetNodes = await planPresetNodesFor("matter");
  /** 当事人「引用既有」优先于「再建一份」，读取同样全部在事务外（见 `services/parties.ts`） */
  const partyPlan = await planPartyLinks(input.parties ?? []);

  await db.transaction(async (tx) => {
    await tx.insert(matter).values({
      id,
      internalCode: code,
      caseNo: input.caseNo?.trim() || code,
      name: input.name,
      cause: input.cause,
      caseType: input.caseType,
      procedure: input.procedure,
      litigationRole: input.litigationRole,
      court: input.court ?? null,
      amount: input.amount ?? "0",
      level: input.level,
      status: initial,
      filingDate: input.filingDate ?? null,
      description: input.description ?? null,
      ownerId: owner,
      createdBy: BigInt(actor.userId),
      updatedBy: BigInt(actor.userId),
      lastProgressAt: new Date().toISOString(),
    });
    await tx.insert(matterStaff).values([
      { id: BigInt(nextId()), hostId: id, userId: owner, staffRole: "owner" },
      ...(owner === BigInt(actor.userId)
        ? []
        : [
            {
              id: BigInt(nextId()),
              hostId: id,
              userId: BigInt(actor.userId),
              staffRole: "co_owner" as const,
            },
          ]),
    ]);
    await insertNewParties(tx, partyPlan.rows, BigInt(actor.userId));
    for (const r of partyPlan.rows) {
      await tx.insert(matterParty).values({
        id: BigInt(nextId()),
        hostId: id,
        partyId: r.partyId,
        partyRole: r.partyRole,
        represented: r.represented,
        sortOrder: r.sortOrder,
      });
    }
    await insertPlannedNodes(tx, "matter", id, presetNodes, BigInt(actor.userId));
    await logActivity(tx, actor, {
      matterId: id,
      action: "MATTER_CREATED",
      targetType: "matter",
      targetId: id,
    });
  });

  // `name_conflicts` 是**提示**不是错误：数据已经按"新建一行"落库了，
  // 前端据此在当事人区挂一句"库里已有同名当事人，确认不是同一家？"（F3-3）
  return { id: String(id), internalCode: code, nameConflicts: partyPlan.nameConflicts };
}

/**
 * 状态变更。
 *
 * 三道判定按"先贵后贱"排：可见性 → 归属 → 原因。
 *   · 可见性由 `scopedWhere` 单点保证，不可见与不存在一律 `not_found`（→ 404，元规则 3）；
 *   · 归属是护栏 1（权限草案 §2.2）：改状态要承办人本人、L1 或 `is_admin`，
 *     否则"可见即可操作"会退化成"同所任何人都能推走别人的案子"；
 *   · 原因是偏离判定（修订稿 §3.3 第 3 条）：走推荐路径不要原因，跳进归档恒要。
 *
 * 置为归档语义的状态要同时翻 `is_archived`，否则列表的 partial index 与"终态不可逆"
 * 判定都会指错地方。撤销归档另需 `can_unarchive`（路由层判，那里才拿得到特权）。
 */
export async function changeStatus(
  actor: Actor,
  id: string,
  to: string,
  reason?: string | null,
): Promise<
  { ok: true } | { ok: false; why: "not_found" | "reason_required" | "unchanged" | "forbidden" }
> {
  const db = await getDb();
  const [cur] = await db
    .select({
      status: matter.status,
      isArchived: matter.isArchived,
      ownerId: matter.ownerId,
    })
    .from(matter)
    .where(scopedWhere("matter", actor, eq(matter.id, BigInt(id))))
    .limit(1);
  if (!cur) return { ok: false, why: "not_found" };
  if (!ownsAttribution(actor, cur.ownerId)) return { ok: false, why: "forbidden" };
  if (cur.status === to) return { ok: false, why: "unchanged" };

  // 当前态与目标态一起取：偏离判定要两边的 code 与语义（§3.3 第 3 条）
  const rows = await db
    .select({
      code: statusConfig.code,
      semantics: statusConfig.semantics,
      nextStatusCodes: statusConfig.nextStatusCodes,
    })
    .from(statusConfig)
    .where(and(eq(statusConfig.hostType, "matter"), inArray(statusConfig.code, [cur.status, to])));
  const curRow = rows.find((r) => r.code === cur.status);
  const target = rows.find((r) => r.code === to);
  if (!target) return { ok: false, why: "not_found" };

  if (
    needsChangeReason({
      from: cur.status,
      fromNextCodes: curRow?.nextStatusCodes ?? [],
      to,
      toSemantics: target.semantics,
    }) &&
    !reason?.trim()
  )
    return { ok: false, why: "reason_required" };

  await db.transaction(async (tx) => {
    const now = new Date().toISOString();
    await tx
      .update(matter)
      .set({
        status: to,
        isArchived: target.semantics === "archived",
        archivedAt: target.semantics === "archived" ? now : null,
        updatedBy: BigInt(actor.userId),
        updatedAt: now,
      })
      .where(eq(matter.id, BigInt(id)));
    await logActivity(tx, actor, {
      matterId: BigInt(id),
      action: target.semantics === "archived" ? "ARCHIVED" : "STATUS_CHANGED",
      targetType: "matter",
      targetId: BigInt(id),
      reason: reason ?? null,
      diffs: { status: { from: cur.status, to } },
    });
  });
  return { ok: true };
}

export async function addComment(
  actor: Actor,
  matterId: string,
  body: string,
  parentId?: string | null,
) {
  const db = await getDb();
  const [visible] = await db
    .select({ id: matter.id })
    .from(matter)
    .where(scopedWhere("matter", actor, eq(matter.id, BigInt(matterId))))
    .limit(1);
  if (!visible) return null;
  const id = BigInt(nextId());
  await db.transaction(async (tx) => {
    await tx.insert(comment).values({
      id,
      targetType: "matter",
      targetId: BigInt(matterId),
      body,
      parentId: parentId ? BigInt(parentId) : null,
      authorId: BigInt(actor.userId),
      createdBy: BigInt(actor.userId),
      updatedBy: BigInt(actor.userId),
    });
    await logActivity(tx, actor, {
      matterId: BigInt(matterId),
      action: "COMMENT_CREATED",
      targetType: "matter",
      targetId: BigInt(matterId),
    });
  });
  return { id: String(id) };
}

/** 完成/取消节点：取消必须带原因（E21 的 CHECK 与 §6.1 同源） */
export async function setNodeStatus(
  actor: Actor,
  /**
   * URL 里那一段 `/api/matters/{matterId}/nodes/{nodeId}` 以前**完全没被用上**：
   * 只按 nodeId 判范围，于是 `/api/matters/999/nodes/<真节点的id>` 也会成功。
   * 权限没漏（join 了 matter 走 scopedWhere），但"父资源 id 只是装饰"是错的语义 ——
   * 现在两个 id 必须对得上，对不上按不可见处理（404）。
   */
  matterId: string,
  nodeId: string,
  status: string,
  cancelReason?: string | null,
) {
  const db = await getDb();
  const [node] = await db
    .select({
      id: matterNode.id,
      name: matterNode.name,
      matterId: matterNode.hostId,
      status: matterNode.status,
      startTime: matterNode.startTime,
      isTimeConfirmed: matterNode.isTimeConfirmed,
    })
    .from(matterNode)
    .innerJoin(matter, eq(matter.id, matterNode.hostId))
    .where(
      scopedWhere(
        "matter",
        actor,
        eq(matterNode.id, BigInt(nodeId)),
        eq(matterNode.hostId, BigInt(matterId)),
      ),
    )
    .limit(1);
  if (!node) return null;
  if (status === "cancelled" && !cancelReason?.trim())
    return { ok: false as const, why: "reason_required" as const };
  if (status === "confirm_time" && !node.startTime)
    return { ok: false as const, why: "time_missing" as const };

  /**
   * `pending`（时间待定）与 `confirm_time`（标已确认）是**命令**，不是第五、第六个状态：
   * 它们只翻 `is_time_confirmed`，`status` 一列保持原值。
   *
   * 三条理由：
   *   · E21 只有四值，库里塞进 `pending` 会撞 `ck_mn_matter_node_status`（表现是一条 500）；
   *   · 之前把这一步写成"待定 ⇒ status=not_started"，于是给一个**进行中**的举证节点改待定
   *     会把它拉回未开始 —— 时间没定 ≠ 活儿没在干；
   *   · `confirm_time` 要求 `start_time` 已填：确认一个空时间会让节点带 `deadline_time=null`
   *     进提醒扫描的 partial index，扫到了也算不出"还剩几天"。
   */
  const isTimeCommand = status === "pending" || status === "confirm_time";
  const toStatus = isTimeCommand ? node.status : status;

  await db.transaction(async (tx) => {
    await tx
      .update(matterNode)
      .set({
        status: toStatus,
        ...(isTimeCommand ? { isTimeConfirmed: status === "confirm_time" } : {}),
        cancelReason: status === "cancelled" ? cancelReason : null,
        completedAt: status === "completed" ? new Date().toISOString() : null,
        completedBy: status === "completed" ? BigInt(actor.userId) : null,
        updatedBy: BigInt(actor.userId),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(matterNode.id, BigInt(nodeId)));
    await logActivity(tx, actor, {
      matterId: node.matterId,
      action:
        status === "completed"
          ? "NODE_COMPLETED"
          : status === "cancelled"
            ? "NODE_CANCELLED"
            : "NODE_UPDATED",
      targetType: "matter_node",
      targetId: node.id,
      reason: status === "cancelled" ? cancelReason : null,
      // 时间命令记的是那一对布尔，不是一条"状态从 X 到 X"的空 diff —— 活动日志要能看出
      // "谁把它标成待定的"，而 `status` 那列当时根本没动
      diffs: isTimeCommand
        ? {
            is_time_confirmed: {
              from: node.isTimeConfirmed,
              to: status === "confirm_time",
            },
          }
        : { status: { from: node.status, to: toStatus, label: NODE_STATUS_LABELS } },
    });
  });
  return { ok: true as const };
}

import { and, asc, desc, eq, exists, inArray, or, sql, count } from "drizzle-orm";
import { getDb } from "../db/client";
import { activityLog, matter, matterNode, riskMatter } from "../db/schema";
import { AUDIT_ACTION_LABELS, type AuditAction } from "@/shared/enums/audit";
import { NODE_OPEN_STATUSES } from "@/shared/enums/business";
import { scopedWhere } from "../scope/visibility";
import type { Actor } from "../auth/auth";

/**
 * 工作台读数（PRD 2.1「打开第一眼要回答的四个问题」）。
 *
 * 这张表上的每一个数都**必须**走同一套范围谓词：工作台是全库视角，
 * 是"最容易漏套范围"的那类查询，所以这里把 `scopedWhere` 的结果取出来复用，
 * 而不是逐个 count 时各写各的 where。
 *
 * 与列表页的口径差别只有一处：**归档行不计入**。归档是终态且列表默认隐藏（§3.3），
 * 一个"在办案件 12"的卡片把归档算进来就是骗人。
 */
export async function overview(actor: Actor) {
  const db = await getDb();
  const mScope = scopedWhere("matter", actor);
  const rScope = scopedWhere("risk_matter", actor);
  const live = sql`NOT ${matter.isArchived}`;
  const liveRisk = sql`NOT ${riskMatter.isArchived}`;

  /**
   * 节点到期分桶。三个条件缺一不可，都是规格里写死的：
   *   · `is_time_confirmed` —— 未确认时间不参与提醒（修订稿 A8：提醒只认这个开关）；
   *   · `status in (not_started, in_progress)` —— 已完成/已取消不再算临期；
   *   · `deadline_time` 是生成列 `COALESCE(end_time, start_time)`，
   *     所以时间点与时间段在这里被统一成一个可比较的时刻，不需要分支。
   * `filter (where …)` 而不是三次 count：一次扫描出三个数，也保证三者不会因并发而互相错开。
   */
  const nodeScan = and(
    sql`NOT ${matterNode.isDeleted}`,
    matterNode.isTimeConfirmed,
    inArray(matterNode.status, NODE_OPEN_STATUSES),
  );

  /**
   * 今天该动手的东西：最近到期的 10 个节点（含已逾期的）。
   * 工作台若只给三个数字，用户还是得回列表挨个翻 —— 那这张页就没起作用。
   * 排序按 `deadline_time` 升序，逾期的自然排在最前（负数时间在前）。
   */
  const [upcomingNodes, byStatus, nodes, risks, recent] = await Promise.all([
    db
      .select({
        id: matterNode.id,
        name: matterNode.name,
        status: matterNode.status,
        deadlineTime: matterNode.deadlineTime,
        hostId: matter.id,
        hostCode: matter.internalCode,
        hostName: matter.name,
        owner: sql<
          string | null
        >`(select u.display_name from mn_app_user u where u.id = ${matterNode.ownerId})`,
      })
      .from(matterNode)
      .innerJoin(matter, eq(matterNode.hostId, matter.id))
      .where(and(mScope, live, nodeScan))
      .orderBy(asc(matterNode.deadlineTime))
      .limit(10),
    db
      .select({ status: matter.status, n: count() })
      .from(matter)
      .where(and(mScope, live))
      .groupBy(matter.status),
    db
      .select({
        overdue: sql<number>`count(*) filter (where ${matterNode.deadlineTime} < now())::int`,
        week: sql<number>`count(*) filter (where ${matterNode.deadlineTime} >= now()
                                        and ${matterNode.deadlineTime} < now() + interval '7 days')::int`,
        later: sql<number>`count(*) filter (where ${matterNode.deadlineTime} >= now() + interval '7 days')::int`,
      })
      .from(matterNode)
      .innerJoin(matter, eq(matterNode.hostId, matter.id))
      .where(and(mScope, live, nodeScan)),
    db
      .select({
        total: sql<number>`count(*) filter (where ${liveRisk})::int`,
        converted: sql<number>`count(*) filter (where ${liveRisk} and ${riskMatter.conversionStatus} = 1)::int`,
      })
      .from(riskMatter)
      .where(rScope),
    db
      .select({
        id: activityLog.id,
        action: activityLog.action,
        reason: activityLog.reason,
        createdAt: activityLog.createdAt,
        hostCode: sql<
          string | null
        >`(select m.internal_code from mn_matter m where m.id = ${activityLog.matterId})`,
        riskCode: sql<
          string | null
        >`(select r.code from mn_risk_matter r where r.id = ${activityLog.riskMatterId})`,
        hostId: sql<
          string | null
        >`(select m.id from mn_matter m where m.id = ${activityLog.matterId})`,
        riskId: sql<
          string | null
        >`(select r.id from mn_risk_matter r where r.id = ${activityLog.riskMatterId})`,
        operator: sql<string>`(select u.display_name from mn_app_user u where u.id = ${activityLog.operatorId})`,
      })
      .from(activityLog)
      // 活动日志自己没有范围列，可见性**跟着宿主走**：
      // 能看见这条案卷才看得见它的动作，否则审计流会变成侧信道（从"谁改过什么"反推案卷存在）。
      .where(
        or(
          and(sql`${activityLog.matterId} IS NOT NULL`, matterVisible(actor)),
          and(sql`${activityLog.riskMatterId} IS NOT NULL`, riskVisible(actor)),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(10),
  ]);

  const first = byStatus.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = Number(r.n);
    return acc;
  }, {});
  const nodeRow = nodes[0];
  const riskRow = risks[0];

  return {
    matters: {
      total: Object.values(first).reduce((a, b) => a + b, 0),
      byStatus: first,
    },
    nodes: {
      overdue: Number(nodeRow?.overdue ?? 0),
      within7: Number(nodeRow?.week ?? 0),
      later: Number(nodeRow?.later ?? 0),
    },
    risks: {
      total: Number(riskRow?.total ?? 0),
      converted: Number(riskRow?.converted ?? 0),
    },
    upcoming: upcomingNodes.map((n) => ({
      id: String(n.id),
      name: n.name,
      status: n.status,
      deadlineTime: n.deadlineTime,
      hostId: String(n.hostId),
      hostCode: n.hostCode,
      hostName: n.hostName,
      owner: n.owner,
    })),
    recent: recent.map((r) => ({
      id: String(r.id),
      action: r.action,
      actionLabel: AUDIT_ACTION_LABELS[r.action as AuditAction] ?? r.action,
      reason: r.reason,
      createdAt: r.createdAt,
      operator: r.operator,
      hostCode: r.hostCode ?? r.riskCode,
      hostId: r.hostId ?? r.riskId,
      kind: r.hostId ? ("matter" as const) : ("risk_matter" as const),
    })),
  };
}

/*
 * 相关子查询版可见性：`scopedWhere` 渲染出的片段是**带表名限定**的
 * （`"mn_matter"."is_deleted"`），所以塞进 `exists (select 1 from mn_matter where …)` 正好解析得到。
 * 这一点不写下来，下一个读代码的人会以为这里漏了别名。
 *
 * 括号一律自己写：drizzle 的 `exists()` 只对 QueryBuilder 自动加括号，
 * 给 `sql` 模板时它会渲染成 `exists select 1 …` —— PG 42601。
 */
function matterVisible(actor: Actor) {
  return exists(
    sql`(select 1 from mn_matter where mn_matter.id = ${activityLog.matterId} and ${scopedWhere("matter", actor)})`,
  );
}

function riskVisible(actor: Actor) {
  return exists(
    sql`(select 1 from mn_risk_matter where mn_risk_matter.id = ${activityLog.riskMatterId} and ${scopedWhere("risk_matter", actor)})`,
  );
}

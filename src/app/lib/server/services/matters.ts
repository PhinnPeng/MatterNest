import { and, asc, count as dcount, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { nextId } from "@/shared/ids/snowflake";
import { listQuerySchema, SORTABLE_COLUMNS } from "@/shared/schema/list-query";
import type { BatchSkipReason, BatchSummary } from "@/shared/schema/batch";
import { needsChangeReason } from "@/shared/schema/status-transition";
import { getDb } from "../db/client";
import {
  activityLog,
  appUser,
  comment,
  matter,
  matterNode,
  matterStaff,
  matterParty,
  matterProgress,
  party,
  statusConfig,
  tag,
} from "../db/schema";
import { archivedFilter, keywordFilter, scopedWhere } from "../scope/visibility";
import { canManageStaffList, ownsAttribution } from "../scope/guards";
import { assertAssignable, listSelectableUsers, type UnassignableUser } from "./selectable-users";
import { decryptField } from "../crypto/field-crypto";
import { insertPlannedNodes, planPresetNodesFor } from "./nodes";
import { insertNewParties, planPartyLinks } from "./parties";
import type { PartyLinkInput } from "./parties";
import type { Actor } from "../auth/auth";
import { nextCode } from "./numbering";
import { initialStatusCode, hostStatusRows } from "./statuses";
import { archiveMissingSql, judgeArchiveReadiness } from "./archive-readiness";
import { logActivity } from "./activity";
import {
  enqueueCommentIntent,
  notifyStatusChanged,
  quoteOf,
  resolveMentionIds,
} from "./notifications";
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
  // 负责人姓名不在案件表上（列表靠相关子查询带出），排序沿用同一个子查询，
  // 否则"看到的负责人"与"排出来的负责人"可能不是同一个表达式。
  owner_name: sql`(select u.display_name from mn_app_user u where u.id = ${matter.ownerId})`,
  amount: sql`${matter.amount}`,
  created_at: sql`${matter.createdAt}`,
  updated_at: sql`${matter.updatedAt}`,
};

export async function listMatters(actor: Actor, q: ListQuery) {
  const db = await getDb();
  const where = and(
    scopedWhere("matter", actor),
    archivedFilter("matter", Boolean(q.archivedOnly)),
    q.status ? eq(matter.status, q.status) : undefined,
    keywordFilter("matter", q.keyword),
    // 「已结案缺材料」（F2-26）：谓词住在 archive-readiness.ts，与详情页那张卡同源。
    // 这里只传开关，不重算判定——两个出口各写一份的漂移不会报错，
    // 只会让"列表说有缺、详情页说齐备"同时成立。
    q.missingMaterials ? archiveMissingSql() : undefined,
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
      archivedAt: matter.archivedAt,
      ownerName: appUserName(),
      updatedAt: matter.updatedAt,
      /**
       * 最近一个未决节点的期限。
       *
       * ⚠ 关联键必须是**裸限定名** `mn_matter.id`，不能写 `${matter.id}`：
       * 在 **select 列表**上下文里 drizzle 把本表列渲染成**无限定**的 `"id"`，
       * 而子查询里那张表**自己就有 `id`** ⇒ `n.matter_id = "id"` 被解析成 `n.matter_id = n.id`，
       * **恒假**。这里比 `archive-readiness.ts` 那处更阴——子查询只有一张表，
       * PG **不会报歧义**，`min()` 静默恒 NULL：列表的「下一期限」一列永远是空的，
       * 而没有任何测试盯着它（检查子代理用真库实测：6 个案件里本该 4 个有期限，实际全空）。
       */
      nextDeadline: sql<string | null>`(select min(n.deadline_time) from mn_matter_node n
        where n.matter_id = mn_matter.id and not n.is_deleted
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

/** 负责人姓名：同一次查询里带出来，避免列表页 N+1 */
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
    // ⚠ 当事人证件号必须解密（MATT-40 之后库里存的是密文信封）——
    //   直接回原文会把 `v1:<base64url>` 画到案件详情的当事人块上。
    parties: parties.map((p) => ({ ...p, id: String(p.id), idNumber: decryptField(p.idNumber) })),
    comments: comments.map((c) => ({ ...c, id: String(c.id) })),
    activity: activity.map((a) => ({ ...a, id: String(a.id) })),
    progress: progress.map((p) => ({ ...p, id: String(p.id) })),
    statuses,
    /**
     * 「归档就绪」三项（F2-26）。**详情页那张卡只读这里**，不在前端重算——
     * 判定只实现一次（`services/archive-readiness.ts`），列表筛选是它的另一个出口。
     *
     * 未归档的案件也照样给：那张卡是"平时可见"的（实时红绿），
     * 不是只在归档那一刻才算。判不出来（案件刚被删）时给 null，前端整块不渲染。
     */
    archiveReadiness: await judgeArchiveReadiness(db, id),
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
    /** 创建时的关注人（IQ-5 + IQ-14 的创建期例外），见 `matterCreateSchema` 注释 */
    followerIds?: string[];
    description?: string | null;
    /** 引用既有（`partyId`）或快速新增（名称+类型），见 `services/parties.ts` */
    parties?: PartyLinkInput[];
  },
) {
  const db = await getDb();
  const { code } = await nextCode("matter");
  const id = BigInt(nextId());
  const owner = BigInt(input.ownerId ?? actor.userId);
  // 被指派者必须在册可用（MATT-49）：创建表单的处理人与关注人走 IQ-14 的创建期例外
  // （全体在册可用用户，不受共现集限制），但**"在册可用"这条不能免**——
  // 停用/待开通/软删的账号不能拿活。这是"软删不得被派活"在创建路径上的落点：
  // 没有下拉能约束一个直接构造的 POST，所以判定必须在服务层真的跑一遍。
  // 处理人与关注人**合成一次查询**：分成两次是同一个谓词跑两遍。
  await assertAssignable([String(owner), ...(input.followerIds ?? [])]);

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
      // 创建时的关注人（IQ-5「处理人与关注人在表单上可选填」+ IQ-14 的创建期例外）。
      // 与 owner 同事务：分开提交会留下"案件建好了但关注人没进去"的中间态，
      // 而用户看到的是"我填了关注人"——那种账对不上，也没有入口能补回来。
      // 去重：同一批里重复的 id 会撞 `uk_mn_matter_staff_triple`。
      ...[...new Set(input.followerIds ?? [])].map((uid, i) => ({
        id: BigInt(nextId()) + BigInt(i),
        hostId: id,
        userId: BigInt(uid),
        staffRole: "follower" as const,
      })),
    ]);
    await insertNewParties(tx, partyPlan.rows, BigInt(actor.userId));
    for (const r of partyPlan.rows) {
      await tx.insert(matterParty).values({
        id: BigInt(nextId()),
        hostId: id,
        partyId: r.partyId,
        partyRole: r.partyRole,
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
 *   · 归属是护栏 1（权限草案 §2.2）：改状态要负责人本人、L1 或 `is_admin`，
 *     否则"可见即可操作"会退化成"同公司任何人都能推走别人的案子"；
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
      // `closing_date` 与当前语义：前者是"进 closed 时要不要写、离开时要不要清"的依据，
      // 后者要从 statusConfig 查（下面 rows 里取），这里只先带上日期
      closingDate: matter.closingDate,
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
      // `name` 一起取：通知文案里的 `{from} → {to}` 要用**显示名**（已登记/进行中），
      // 不是 code。IQ-5/6 专门改过显示名，通知里退回 code 等于在用户可见处抹掉那次改名。
      name: statusConfig.name,
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
    const archiving = target.semantics === "archived";
    /**
     * `closing_date` 的自动写入（F2-26 第②项的前提，也是 `SEMANTICS_RULES.closed.effect`
     * 那句"视为结案，closing_date 自动写入"的落地）。
     *
     * ⚠ 此前**没有任何路径能写这一列**：建案 schema 里没有它、案件侧也没有字段编辑接口。
     * 结果是 `closing_date` 恒为 NULL ⇒ 详情页的「已结案」标记永不出现、
     * 归档完备性的第②项恒判"缺"。这一条属于"声明了效果但没实现"，
     * 不是"没人用所以先不做"——声明在 `shared/enums/status.ts` 里，是可读的承诺。
     *
     * 写入规则：进入 `closed` 语义时若为空则写今天；**离开 `closed` 时清空**
     * （不结案了，"结案日期"就不该留着——留着会让第②项在办案件上恒绿）。
     * 已有的日期不覆盖：重复进入 closed 不改第一次的结案日。
     */
    const closingDate =
      target.semantics === "closed"
        ? (cur.closingDate ?? now.slice(0, 10))
        : target.semantics === "archived"
          ? // ⚠ 归档**保留**结案日期。初版写成"离开 closed 就清空"，而 `closed → archived`
            //   恰好命中（seed 里 `closed` 的推荐后继就是 `archived`）⇒ 归档时把日期抹掉。
            //   后果不是一条断言红，而是三件事同时发生：①判定在 `tx.update` **之前**跑，
            //   读到旧值 ⇒ 审计记 `missing_at_archive: []`（齐备），而列表筛选读归档后的行
            //   （已被抹成 NULL）⇒ 判它"缺材料"——**两个出口互相打架**，正是本票 AC 第 1 条
            //   要防的；②G4 指标"归档材料完整率"的唯一数据源变成**假的空数组**；
            //   ③「已结案缺材料」筛选退化成"全部归档案件"（因为主路径每条都缺）。
            cur.closingDate
          : null;
    /**
     * 归档完备性（F2-26 / G4）：**判定在事务内跑**，与归档写、审计写同一事务——
     * 判定结果要随 `ARCHIVED` 落库，分开算会留下"审计里记的缺项与实际归档状态不一致"。
     *
     * **缺项不阻断**（IQ-16 明文）：缺材料照样能归档，只是要填 reason（上面已经拦过），
     * 并把缺项清单记进审计。G4 指标"归档材料完整率"以这份清单为唯一数据源。
     */
    const readiness = archiving ? await judgeArchiveReadiness(tx, id) : null;
    await tx
      .update(matter)
      .set({
        status: to,
        closingDate,
        isArchived: archiving,
        archivedAt: archiving ? now : null,
        updatedBy: BigInt(actor.userId),
        updatedAt: now,
      })
      .where(eq(matter.id, BigInt(id)));
    await logActivity(tx, actor, {
      matterId: BigInt(id),
      action: archiving ? "ARCHIVED" : "STATUS_CHANGED",
      targetType: "matter",
      targetId: BigInt(id),
      reason: reason ?? null,
      diffs: {
        status: { from: cur.status, to },
        // 只在**真的变了**才记：按"目标语义"分三档之后，`closed → archived` 不再改日期，
        // 记一条 `from: 2026-01-01, to: 2026-01-01` 是噪声（而它曾经记的是 `to: null`——
        // 那条审计正是"归档抹掉结案日期"的现场证据）。
        ...(closingDate !== cur.closingDate
          ? { closing_date: { from: cur.closingDate, to: closingDate } }
          : {}),
      },
      ...(readiness
        ? {
            payload: {
              missing_at_archive: readiness.missing,
              // ⚠ 单列一份：`missing_at_archive` 为空**不等于齐备**——附件那项没有数据源、
              //   这次没判。不把这件事写下来，"空数组 = 齐备"会被读成事实。
              unavailable_at_archive: readiness.unavailable,
            },
          }
        : {}),
    });
    /**
     * 通知意图（预置规则 2，收件人 `["follower","creator"]`）——**与状态写同一事务**。
     *
     * 放在事务里的理由与 `activity_log` 完全一样：分开提交会留下"状态改了但没人收到回音"
     * 或反过来的中间态，而这条链路服务的正是"报了没回音，下次就不报了"（G1 的根因）。
     *
     * `isArchivedAfter: archiving` 是**写入后**的归档态：M4「什么时候不用」裁了
     * 「归档记录不再产生新通知」，所以 `→ archived` 这一步静默。
     * 撤销归档（`archived → 别的`）不在这个分支里，照常发。
     */
    await notifyStatusChanged(actor, tx, {
      host: "matter",
      hostId: BigInt(id),
      from: cur.status,
      to,
      fromName: curRow?.name ?? cur.status,
      toName: target.name,
      isArchivedAfter: archiving,
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
  /**
   * @提及在**事务外**解析：候选人是全体在职账号，与这次评论的写入没有一致性要求
   * （一次全表读，十人组织里就是十行）。放进事务只会把这段读拉进写锁的持有期。
   */
  const mentionIds = await resolveMentionIds(db, body);
  await db.transaction(async (tx) => {
    await tx.insert(comment).values({
      id,
      targetType: "matter",
      targetId: BigInt(matterId),
      body,
      parentId: parentId ? BigInt(parentId) : null,
      // `mention_ids` 是基线 0000 就有的列，列注写着「通知链路将来靠它展开」——
      // 本票就是那个"将来"。落库让"谁被 @ 了"成为可查的事实，而不是只活在通知里。
      mentionIds: mentionIds.map(BigInt),
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
    /**
     * 新评论的通知意图 —— **只写 outbox，不在这里发**（预置规则 8 的触发是
     * `comment_added` 领域事件，属 E32/E33 的值域）。
     *
     * 事件名落 outbox、由消费者展开成通知，是"投递走 outbox 不直发"的兑现方式：
     * 业务事务只管把"发生了什么"记下来，真正生成通知的动作发生在消费侧，而那一侧可重入。
     * 归档宿主由 `enqueueCommentIntent` 直接返回 false（归档记录不再产生新通知），
     * 但**评论照写**——基线 1.7 明写"归档后仍可新增评论"，只是不发通知。
     */
    await enqueueCommentIntent(actor, tx, {
      host: "matter",
      hostId: BigInt(matterId),
      commentId: id,
      quoted: quoteOf(body),
      mentionIds,
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

/* ─────────────── 参与人名单（MATT-49：案件侧补上写路径） ─────────────── */

/**
 * 案件侧「承办与协办 / 关注」名单的读写。
 *
 * ## 为什么案件侧此前只有读
 *
 * 详情页一直只**显示** `m.staff`（承办与协办），没有任何入口能加人——而事项侧有。
 * 两件事叠在一起才看得出来：`/api/meta` 没有 `users` 键，而选择面那条带宿主上下文的接口
 * 也只建了事项侧。所以案件侧的"加人"从来没有可用的数据源，界面干脆没做。
 *
 * ## 四道门，缺一不可（与事项侧同源；这里没有"自我关注"那一半）
 *
 * 1. **宿主可见性**：`scopedWhere` 查不到行 → 404（元规则 3，不给可区分的信号）。
 * 2. **§6 名单管理权**：经办人 / L1（含 `is_admin`）/ 创建人。协办与关注看得见名单但改不了。
 * 3. **§4.1 可见用户集**：被加者要落在 `listSelectableUsers(actor, "matter", id)` 里
 *    （L1 等价全公司；其余只能加与自己共现于同一宿主的人）。
 * 4. **被指派者必须在册可用**：停用 / 待开通 / 软删一律拒（`findUnassignable`，唯一谓词）。
 *
 * ## 为什么**不**允许从这里设 `owner`
 *
 * 换负责人是一条**字段编辑**（`ownerId`，走 `OWNER_CHANGED` 审计），已经有自己的路。
 * 在这里再开一条"把某人加成 owner"的口子，就会出现两条到同一状态的路，
 * 而其中一条不写 `OWNER_CHANGED`——那种"两条路各记一半"的账最难对。
 * 所以本模块只收 `co_owner` / `follower`，收 `owner` 直接拒。
 *
 * ## 归档态
 *
 * 归档是只读终态（§5.2）：名单**仍可读**，写一律拒——与评论、节点、字段编辑同一口径。
 */

export type MatterStaffRole = "co_owner" | "follower";

/** 取案件 + 判可见性；null = 看不见或不存在（→ 404） */
async function loadMatterForStaff(db: Awaited<ReturnType<typeof getDb>>, actor: Actor, id: string) {
  const [row] = await db
    .select({
      id: matter.id,
      ownerId: matter.ownerId,
      creatorId: matter.createdBy,
      isArchived: matter.isArchived,
    })
    .from(matter)
    .where(scopedWhere("matter", actor, eq(matter.id, BigInt(id))))
    .limit(1);
  return row ?? null;
}

export type MatterStaffRow = {
  id: string;
  userId: string;
  displayName: string;
  staffRole: string;
};

/** 当前名单（按角色 + 姓名排序，界面直接渲染） */
export async function listMatterStaff(
  actor: Actor,
  matterId: string,
): Promise<MatterStaffRow[] | null> {
  const db = await getDb();
  const src = await loadMatterForStaff(db, actor, matterId);
  if (!src) return null;
  const rows = await db
    .select({
      id: matterStaff.id,
      userId: matterStaff.userId,
      staffRole: matterStaff.staffRole,
      displayName: appUser.displayName,
    })
    .from(matterStaff)
    .innerJoin(appUser, eq(appUser.id, matterStaff.userId))
    .where(eq(matterStaff.hostId, BigInt(matterId)))
    .orderBy(asc(matterStaff.staffRole), asc(appUser.displayName));
  return rows.map((r) => ({
    id: String(r.id),
    userId: String(r.userId),
    displayName: r.displayName,
    staffRole: r.staffRole,
  }));
}

export type MatterStaffWriteResult =
  | { ok: true; added: number; skipped: string[] }
  | { ok: false; why: "not_found" | "archived" | "forbidden" }
  | { ok: false; why: "not_selectable"; bad: UnassignableUser[] }
  | { ok: false; why: "role_not_allowed" };

/**
 * 加参与人。**整批原子**：一个不合法就整请求拒。
 *
 * 部分成功会让"我加了三个同事只有一个进去了"变成看不见的洞——而用户看到的是
 * "加过了"，于是再也不会去核对名单。这与 `addRiskFollowers` 的口径一致。
 */
export async function addMatterStaff(
  actor: Actor,
  matterId: string,
  userIds: readonly string[],
  staffRole: MatterStaffRole,
): Promise<MatterStaffWriteResult> {
  // 角色白名单：`owner` 有自己的路（见文件头注），不从这里开第二条
  if (staffRole !== "co_owner" && staffRole !== "follower") {
    return { ok: false, why: "role_not_allowed" };
  }
  const db = await getDb();
  const src = await loadMatterForStaff(db, actor, matterId);
  if (!src) return { ok: false, why: "not_found" };
  if (src.isArchived) return { ok: false, why: "archived" };
  if (!canManageStaffList(actor, src)) return { ok: false, why: "forbidden" };

  // 门 3：可见用户集（带宿主上下文）
  const selectable = await listSelectableUsers(actor, "matter", matterId);
  if (selectable === null) return { ok: false, why: "not_found" };
  const allowed = new Set(selectable.map((u) => u.id));
  const outside = userIds.filter((u) => !allowed.has(u));
  if (outside.length) {
    // 不在可见用户集里的人：**不告诉调用方他是谁**（否则这个端点就成了花名册探测面）
    return {
      ok: false,
      why: "not_selectable",
      bad: outside.map((id) => ({ id, username: null, reason: "unknown" as const })),
    };
  }

  // 门 4（在册可用：停用 / 待开通 / 软删）**不需要在这里再查一遍**：
  // `listSelectableUsers` 的 WHERE 里已经有那三个条件（见它的文件头注），所以能出现在
  // `selectable` 里的人在册状态必然合格，不在里面的人上面那道 `outside` 已经拦了。
  // 两处都写不会更安全，只会让"哪一处才是真的"变成要读两处代码才能回答的问题。
  //
  // 反向红验过这一点：把单独的 `findUnassignable` 调用摘掉，三条"不得被指派"断言**照样绿**
  // ——那说明它确实是冗余的，而不是我漏了。真正靠 `assertAssignable` 兜底的是**创建路径**
  // （那里没有选择面可依）。

  const ids = [...new Set(userIds)].map((u) => BigInt(u));
  const existing = await db
    .select({ userId: matterStaff.userId })
    .from(matterStaff)
    .where(and(eq(matterStaff.hostId, BigInt(matterId)), eq(matterStaff.staffRole, staffRole)));
  const have = new Set(existing.map((e) => String(e.userId)));
  const fresh = ids.filter((u) => !have.has(String(u)));
  const skipped = ids.filter((u) => have.has(String(u))).map(String);

  if (fresh.length) {
    await db.transaction(async (tx) => {
      await tx.insert(matterStaff).values(
        fresh.map((uid, i) => ({
          id: BigInt(nextId()) + BigInt(i),
          hostId: BigInt(matterId),
          userId: uid,
          staffRole,
        })),
      );
      await logActivity(tx, actor, {
        matterId: BigInt(matterId),
        targetType: "matter",
        targetId: BigInt(matterId),
        action: "STAFF_CHANGED",
        payload: { added: fresh.map(String), removed: [], role: staffRole },
      });
    });
  }
  return { ok: true, added: fresh.length, skipped };
}

/**
 * 摘参与人。**经办人本人摘不掉**：`owner` 那条行由"换负责人"负责，
 * 直接从名单里摘掉会让案件落到"有人办但名单上没有他"的状态。
 */
export async function removeMatterStaff(
  actor: Actor,
  matterId: string,
  userId: string,
): Promise<
  | { ok: true; removed: number }
  | { ok: false; why: "not_found" | "archived" | "forbidden" | "owner_protected" }
> {
  const db = await getDb();
  const src = await loadMatterForStaff(db, actor, matterId);
  if (!src) return { ok: false, why: "not_found" };
  if (src.isArchived) return { ok: false, why: "archived" };
  if (!canManageStaffList(actor, src)) return { ok: false, why: "forbidden" };
  if (src.ownerId !== null && String(src.ownerId) === String(userId)) {
    return { ok: false, why: "owner_protected" };
  }

  const removed = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(matterStaff)
      .where(and(eq(matterStaff.hostId, BigInt(matterId)), eq(matterStaff.userId, BigInt(userId))))
      .returning({ id: matterStaff.id });
    if (rows.length) {
      await logActivity(tx, actor, {
        matterId: BigInt(matterId),
        targetType: "matter",
        targetId: BigInt(matterId),
        action: "STAFF_CHANGED",
        payload: { added: [], removed: [userId], role: null },
      });
    }
    return rows.length;
  });
  return { ok: true, removed };
}

/* ─────────────── 批量低风险动作（MATT-45：改状态 / 归档 / 加标签） ─────────────── */

/**
 * 这一节只**追加**，不动上面任何既有函数——批量改状态逐条复用 `changeStatus`，
 * 而不是另写一条状态机：两条状态机必然漂，而漂了的形态是"单条改不动、批量改得动"，
 * 只有把两条路摆在一起对比才看得出来。
 *
 * 四条口径（与 `shared/schema/batch.ts` 的文件头是同一份，这里写服务层那一半）：
 *
 * 1. **不可见的行静默排除**：`loadBatchRows` 只带回 `scopedWhere` 放行的行，
 *    其余（不存在 / 已软删 / 超出数据范围）在下面的循环里 `continue` 掉，
 *    **既不进 `applied` 也不进 `skipped`**。把它们记进 `skipped` 就等于用
 *    `skipped.length` 回答了"你提交的 id 里有几个存在但你看不见"——那正是元规则 3
 *    （不可见一律 404，不给可区分信号）要防的案号枚举探测。所以 `BatchSummary`
 *    里没有"未处理条数"，`applied + skipped.length ≤ ids.length` 是**预期**。
 * 2. **跳过只算"看得见但没做成"**：护栏 1 拒绝 / 要原因 / 目标与现状相同 /
 *    撤销归档缺特权 / 归档终态不可写。每一条都能读出一句人话（`BATCH_SKIP_REASON_LABELS`）。
 * 3. **审计逐条写既有的动作值**（`STATUS_CHANGED` / `ARCHIVED` / `MATTER_UPDATED`），
 *    不新造批量动作值：新造一个值要文档 §3.3 + `shared/enums/audit.ts` + 迁移 CHECK
 *    三向同批，而本票零迁移。代价是审计里**分不出"逐条点"与"批量点"**——
 *    要能区分就得有批量动作值，那是另一张票（已写进交付报告的"未做"）。
 * 4. **批量上限 50 在 schema 层拦**（`MAX_BATCH_IDS`），这里不重复判——
 *    服务层再夹一次会让"绕过界面的 POST"变成静默截断，而不是 400。
 */

/** 批量预读要的那几列：可见性判定 + 逐行护栏要用到的现状 */
type BatchRow = {
  id: string;
  status: string;
  isArchived: boolean;
  tagIds: bigint[];
};

/**
 * 把请求里的 id 收敛成"看得见的那些行"。
 *
 * 一次 `inArray` 查完而不是逐行查：50 行逐行查就是 50 次往返，而这里要的只是
 * 可见性 + 现状——**写入仍然逐行走 `changeStatus`**（那才是状态机的唯一入口）。
 *
 * ⚠ 这张表**不是**安全边界：它是摘要与护栏的输入。真正的边界是
 * `changeStatus` 自己那次 `scopedWhere`（以及 `batchTagMatters` 里这次读，
 * 标签动作没有第二道）。所以"摘掉这里的 `scopedWhere`"对改状态/归档是红不出来的
 * ——见 `revred-batch.mjs` 的 `tag-scope` 模式（那条才是能红的）。
 */
async function loadBatchRows(
  db: Awaited<ReturnType<typeof getDb>>,
  actor: Actor,
  ids: readonly string[],
): Promise<Map<string, BatchRow>> {
  const uniq = [...new Set(ids)].map((i) => BigInt(i));
  const rows = await db
    .select({
      id: matter.id,
      status: matter.status,
      isArchived: matter.isArchived,
      tagIds: matter.tagIds,
    })
    .from(matter)
    .where(scopedWhere("matter", actor, inArray(matter.id, uniq)));
  return new Map(rows.map((r) => [String(r.id), { ...r, id: String(r.id) }]));
}

/** 跳过项的构造：一处拼，免得三个动作各写一遍 `{ id, reason }` 的字段名 */
function skipRow(id: string, reason: BatchSkipReason): BatchSummary["skipped"][number] {
  return { id, reason };
}

/**
 * 批量改状态。
 *
 * 目标状态**先按配置表验一次**：写错一个 code（或那个状态已被停用）不该退化成
 * "每一行都静默不动"——逐行 `changeStatus` 会回 `not_found`，而按第 1 条口径
 * `not_found` 是要被吞掉的，于是请求回 200 + `applied: 0`，用户看到的是"点了没反应"。
 * 参数错就该是 400/422，不是一份看起来成功的空摘要。
 */
export async function batchChangeMatterStatus(
  actor: Actor,
  ids: readonly string[],
  to: string,
  reason?: string | null,
): Promise<({ ok: true } & BatchSummary) | { ok: false; why: "bad_status" }> {
  const db = await getDb();
  const [target] = await db
    .select({ semantics: statusConfig.semantics })
    .from(statusConfig)
    .where(
      and(
        eq(statusConfig.hostType, "matter"),
        eq(statusConfig.code, to),
        eq(statusConfig.isEnabled, true),
      ),
    )
    .limit(1);
  if (!target) return { ok: false, why: "bad_status" };

  const byId = await loadBatchRows(db, actor, ids);
  const skipped: BatchSummary["skipped"] = [];
  let applied = 0;

  for (const id of [...new Set(ids)]) {
    const row = byId.get(id);
    // 不可见 / 已软删 / 不存在：**什么都不说**（三者并进同一条，正是元规则 3 的口径）
    if (!row) continue;

    /**
     * 撤销归档要 `can_unarchive`（权限草案 §2.1）——单条路由的同一道门，这里逐行判。
     *
     * 判据是"当前已归档 **且** 目标不是归档语义"：那才是"把它从归档里拉出来"。
     * 把一条已归档的行再改到归档语义的状态是空操作（`changeStatus` 会回 `unchanged`），
     * 为一次什么都没做的动作报"缺撤销归档权限"会把人引到错误的结论上。
     */
    if (row.isArchived && target.semantics !== "archived" && !actor.privileges.canUnarchive) {
      skipped.push(skipRow(id, "privilege_required"));
      continue;
    }

    const r = await changeStatus(actor, id, to, reason);
    if (r.ok) {
      applied++;
      continue;
    }
    // 竞态：预读时还看得见、此刻已经不可见或被软删。按第 1 条口径吞掉，
    // 而不是回一条 `not_found` ——那会让"这一行刚刚被删"与"你本来就不该看见它"在响应里长得一样。
    if (r.why === "not_found") continue;
    skipped.push(skipRow(id, r.why));
  }
  return { ok: true, applied, skipped };
}

/**
 * 批量归档。
 *
 * 目标状态**服务端自己查**（`semantics='archived'` 那一行，配置驱动），不收调用方给的 code：
 * 归档是"到终态"这一个动作，让前端再传一个状态码只是多一个能填错、又只能靠 422 发现的字段。
 *
 * 原因由 schema 强制（`batchArchiveSchema.reason` 的 `min(1)`），所以这里不必再判
 * ——枚举表 §3.2 把 `ARCHIVED` 列为原因必填，schema 是前后端共用的同一道门。
 */
export async function batchArchiveMatters(
  actor: Actor,
  ids: readonly string[],
  reason: string,
): Promise<{ ok: true } & BatchSummary> {
  const db = await getDb();
  const statuses = await hostStatusRows("matter");
  const archived = statuses.find((s) => s.semantics === "archived");
  /**
   * 查不到就抛，与 `initialStatusCode` 同一条口径：那是"seed 没跑 / 配置被删"的部署故障。
   * 兜底成某个字面量只会让一批记录落进一个库里并不认作归档的状态——
   * 界面上它们还在在办列表里，而 `is_archived` 已经翻了。
   */
  if (!archived) {
    throw new Error("mn_status_config 缺少 host_type=matter 且 semantics='archived' 的启用状态行");
  }

  const byId = await loadBatchRows(db, actor, ids);
  const skipped: BatchSummary["skipped"] = [];
  let applied = 0;

  for (const id of [...new Set(ids)]) {
    // 不可见：静默排除（`row` 只用来判"看不看得见"，归档不需要它的现状——
    // 已经归档的行会由 `changeStatus` 回 `unchanged`，那是它该说的话）
    const row = byId.get(id);
    if (!row) continue;

    const r = await changeStatus(actor, id, archived.code, reason);
    if (r.ok) {
      applied++;
      continue;
    }
    if (r.why === "not_found") continue;
    skipped.push(skipRow(id, r.why));
  }
  return { ok: true, applied, skipped };
}

/**
 * 批量加标签。**追加，不是替换**——"加标签"这三个字里没有"清掉原来那些"的意思，
 * 而一个会顺手覆盖的批量动作，用户在下一次打开详情页之前都不会发现。
 *
 * 两道门：标签必须存在且属于这一类记录（`mn_tag.host_type`）；归档行一律拒（§5.2 只读终态）。
 */
export async function batchTagMatters(
  actor: Actor,
  ids: readonly string[],
  tagIds: readonly string[],
): Promise<({ ok: true } & BatchSummary) | { ok: false; why: "bad_tag" }> {
  const db = await getDb();
  const wanted = [...new Set(tagIds)].map((t) => BigInt(t));
  /**
   * **不额外过滤 `is_enabled`**：`/api/meta` 的标签字典只按 `host_type` 过滤（见那个 handler），
   * 这里多一道会让下拉里明明能选的标签被 422 拒掉——"界面说行、服务端说不行"
   * 比两处都不行更难查（用户没有任何办法自己绕过它）。
   */
  const found = await db
    .select({ id: tag.id })
    .from(tag)
    .where(and(eq(tag.hostType, "matter"), inArray(tag.id, wanted)));
  if (found.length !== wanted.length) return { ok: false, why: "bad_tag" };

  const byId = await loadBatchRows(db, actor, ids);
  const skipped: BatchSummary["skipped"] = [];
  let applied = 0;

  for (const id of [...new Set(ids)]) {
    const row = byId.get(id);
    // 不可见：静默排除
    if (!row) continue;

    // §5.2：归档是只读终态，标签也是宿主的字段——与评论、节点、字段编辑同一口径
    if (row.isArchived) {
      skipped.push(skipRow(id, "archived"));
      continue;
    }

    const have = new Set(row.tagIds.map(String));
    const add = wanted.filter((t) => !have.has(String(t)));
    // 幂等：标签都已在身上就是"目标与现状相同"，不是失败。重跑一次批量不该报错。
    if (!add.length) {
      skipped.push(skipRow(id, "unchanged"));
      continue;
    }
    const next = [...row.tagIds, ...add];

    await db.transaction(async (tx) => {
      await tx
        .update(matter)
        .set({ tagIds: next, updatedBy: BigInt(actor.userId), updatedAt: new Date().toISOString() })
        .where(eq(matter.id, BigInt(id)));
      await logActivity(tx, actor, {
        matterId: BigInt(id),
        targetType: "matter",
        targetId: BigInt(id),
        action: "MATTER_UPDATED",
        /**
         * 用 `MATTER_UPDATED` 而不是新造一个 `TAG_CHANGED`：标签是宿主表上的业务字段
         * （`tag_ids`，GIN 索引），而枚举表 §3.2 的硬口径是"`*_UPDATED` 只在业务字段变化时写"
         * ——`NON_AUDIT_TRIGGERING_COLUMNS` 里也没有 `tag_ids`，所以这次改动**该**写它。
         * 新造动作值要文档 §3.3 + `audit.ts` + 迁移 CHECK 三向同批，本票零迁移。
         *
         * ⚠ `from` / `to` 必须 `.map(String)`：`field_diffs` 是 `jsonb`，而 `JSON.stringify`
         * 遇到 BigInt 会抛 `Do not know how to serialize a BigInt` —— 那样整批标签
         * 会在**写审计**这一步 500（业务写与审计同事务，所以业务也会一起回滚）。
         * `addMatterStaff` 的 `payload.added` 同样 `.map(String)`，是同一条约束的两个落点。
         */
        diffs: { tag_ids: { from: row.tagIds.map(String), to: next.map(String) } },
      });
    });
    applied++;
  }
  return { ok: true, applied, skipped };
}

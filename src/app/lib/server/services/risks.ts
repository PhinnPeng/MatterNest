import { and, asc, count as dcount, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { nextId } from "@/shared/ids/snowflake";
import type { RiskMatterListExportQuery, RiskSortableColumn } from "@/shared/schema/list-query";
import { assertAssignable, listSelectableUsers } from "./selectable-users";
import { decryptField } from "../crypto/field-crypto";
import { getDb } from "../db/client";
import {
  matter,
  matterStaff,
  matterParty,
  matterNode,
  matterProgress,
  riskMatter,
  riskMatterCase,
  riskMatterNode,
  riskMatterParty,
  riskMatterProgress,
  riskMatterStaff,
} from "../db/schema";
import {
  activityLog,
  appUser,
  comment,
  eventOutbox,
  nodeTypeConfig,
  statusConfig,
  tag,
} from "../db/schema";
import { party } from "../db/schema";
import {
  insertNewParties,
  planPartyLinks,
  type PartyLinkInput,
  type PartyLinkPlanRow,
} from "./parties";
import { archivedFilter, keywordFilter, scopedWhere } from "../scope/visibility";
import { canManageStaffList, ownsAttribution } from "../scope/guards";
import { RISK_MATTER_TYPE_LABELS } from "@/shared/enums/business";
import type { BatchSkipReason, BatchSummary } from "@/shared/schema/batch";
import { insertPlannedNodes, planPresetNodesFor } from "./nodes";
import { type ProgressInput } from "@/shared/schema/hosts";
import { canManageNode } from "./node-access";
import { initialRemindDays } from "@/shared/node-reminder";
// 撤销前置的"费用"那一条复用费用模块的谓词（MATT-47）：两处各写一遍 SQL，
// 失效时不会报错 —— 只会让费用录满的案件也能被撤。
import { hasMatterExpenses } from "./expenses";
import type { Actor } from "../auth/auth";
import { nextCode } from "./numbering";
import { businessDateKey } from "@/shared/time/zh-cn";
import { hostStatusRows, initialStatusCode } from "./statuses";
import { logActivity } from "./activity";
import { configNameDict, csvText, exportAuditPayload, listExportLanding } from "./exports";
import { isFavorited, syncFollowWatch } from "./watch";
import { mentionPartsOf } from "./comment-mentions";
import {
  attachToComment,
  attachmentsOfComments,
  discardDrafts,
  verifyDraftAttachments,
} from "./attachments";
// 通知意图的两个生产点（MATT-41 / T4）：状态变更**同事务**落事件，新评论**只落 outbox**。
// 两者都不在业务事务里做"投递"这个动作本身 —— 见 services/notifications.ts 文件头。
import { enqueueCommentIntent, quoteOf, resolveMentionIds } from "./notifications";
import { changeHostStatus } from "./status-change";
import { randomUUID } from "node:crypto";

/**
 * 风险事项读写 + **转案件**（W4 的旗舰动作，修订稿 §3.4 / 映射矩阵 §2）。
 *
 * 转案件这条链上三件事必须同事务，否则会出现"案件建好了但事项还显示未转"：
 *   1. 生成 `AJ-` 编号并建案件；
 *   2. 写 `mn_risk_matter_case` 关联（事项的"来源"靠它反查，宿主表上**不留** `source_risk_id`，§6.3）；
 *   3. 事项 `conversion_status=1` + 计数 +1，并落 `CONVERTED_TO_CASE` 审计。
 *
 * 字段继承按 master P0-1 的裁定：以映射矩阵为准 —— **描述不继承、金额留空逐案填、附件引用不复制**；
 * 基线 3.4 那句"带入描述与金额"已被 §P0-1 判为被覆盖。
 */

/**
 * 冻结判据与它的两句话搬去了 `./risk-freeze`：`status-change.ts` 要用它，而本文件要
 * import `status-change.ts`，留在原处就是环。这里 re-export，既有 import 路径不变
 * （五个路由 + `risks.spec.ts` 的 import 都不用改）。
 */
import { isRiskFrozen } from "./risk-freeze";
export { RISK_FROZEN_MESSAGE, RISK_UNCONVERT_FROZEN_MESSAGE, isRiskFrozen } from "./risk-freeze";

/**
 * 排序键 → 列，白名单是 `shared/schema/list-query` 的 `RISK_SORTABLE_COLUMNS`
 * （案件那份减去 `amount`：事项侧的「预估影响」随迁移 0017 撤下，没有列可排）。
 *
 * 写成 `Record<白名单, SQL>` 而不是 `Record<string, SQL>`：少一个键编译期就报缺属性，
 * 不会出现"表头点了、数据没动"（本表此前只收 `sortDir`、不收 `sortBy`，
 * 前端那一列排序箭头全是死控件——这个映射就是来补上的）。
 */
const SORTABLE: Record<RiskSortableColumn, SQL> = {
  code: sql`${riskMatter.code}`,
  name: sql`${riskMatter.name}`,
  status: sql`${riskMatter.status}`,
  risk_level: sql`${riskMatter.level}`,
  owner_name: sql`(select u.display_name from mn_app_user u where u.id = ${riskMatter.ownerId})`,
  created_at: sql`${riskMatter.createdAt}`,
  updated_at: sql`${riskMatter.updatedAt}`,
};

/**
 * 上报时间三档窗口的天数。与 `shared/schema/list-query.ts` 的 `reportBucket` 枚举一一对应。
 *
 * 写成 `Record<枚举, number>`：那边少一档或多一档，这里就取不到键 —— 编译期而不是运行时。
 */
const REPORT_WINDOW_DAYS: Record<"week" | "month" | "quarter", number> = {
  week: 7,
  month: 30,
  quarter: 90,
};

/**
 * 列表与它导出的**同一份**谓词（MATT-64）。
 *
 * 为什么必须是一个函数而不是两处各写一遍：导出集合要与列表可见集合**逐行一致**，
 * 而"少写一个筛选"不会报错 —— 用户看到的是"列表 21 行、导出 43 行"，或者更糟：
 * 导出比列表**多**（范围谓词漏一处）。两个方向都静默。
 * 真库断言见 `agent-work/smoke-list-export.mjs`。
 */
function riskMattersListWhere(
  actor: Actor,
  q: {
    status?: string;
    keyword?: string;
    archivedOnly?: boolean;
    ownerEmpty?: boolean;
    owner?: string;
    riskLevel?: string;
    reportBucket?: "week" | "month" | "quarter";
  },
): SQL | undefined {
  return and(
    scopedWhere("risk_matter", actor),
    archivedFilter("risk_matter", Boolean(q.archivedOnly)),
    q.status ? eq(riskMatter.status, q.status) : undefined,
    q.riskLevel ? eq(riskMatter.level, q.riskLevel) : undefined,
    // 经办人（canon 查询区那一格）：与 `ownerEmpty` 互斥，前端二选一。
    // `owner_id` 是 bigint 列，schema 只保证它是数字串，这里才把它变成 bigint。
    q.owner ? eq(riskMatter.ownerId, BigInt(q.owner)) : undefined,
    keywordFilter("risk_matter", q.keyword),
    // 未指派 = `owner_id IS NULL`。事项侧经办人可空（IQ-5），所以判空值；
    // `= ''` 与 `NOT EXISTS` 是另外两种"空"，别混。
    q.ownerEmpty ? isNull(riskMatter.ownerId) : undefined,
    /**
     * 上报时间滚动窗口（canon `risk-matters.html` 的「上报时间」那一格）。
     *
     * 筛 `created_at`（登记进系统的时刻），不筛 `discover_date`：
     * 后者是"风险什么时候被发现"，建号时可以填一个早得多的日期。
     *
     * 天数用 `sql.raw` 内联而不是参数：`$1 * interval '1 day'` 在 pg 侧会得到
     * "operator is not unique"（参数类型待定），而这里的天数来自**闭集枚举**，
     * 不是用户输入，内联没有注入面。窗口是闭区间，含今天。
     */
    q.reportBucket
      ? sql`${riskMatter.createdAt} >= current_date - interval '${sql.raw(
          String(REPORT_WINDOW_DAYS[q.reportBucket]),
        )} days'`
      : undefined,
  );
}

export async function listRiskMatters(
  actor: Actor,
  q: {
    page: number;
    pageSize: number;
    keyword?: string;
    status?: string;
    sortBy?: RiskSortableColumn;
    archivedOnly?: boolean;
    /** 只看未指派处理人的事项（T1）。`owner_id IS NULL`，不是 `= ''` */
    ownerEmpty?: boolean;
    /** 经办人（`owner_id`），与 `ownerEmpty` 互斥 */
    owner?: string;
    /** 风险等级（`mn_risk_level_config.code`） */
    riskLevel?: string;
    /** 上报时间滚动窗口（近 7 / 30 / 90 天） */
    reportBucket?: "week" | "month" | "quarter";
    sortDir?: "asc" | "desc";
  },
) {
  const db = await getDb();
  const where = riskMattersListWhere(actor, q);
  const sortCol = SORTABLE[q.sortBy ?? "updated_at"];
  const [total] = await db.select({ n: dcount() }).from(riskMatter).where(where);
  const rows = await db
    .select({
      id: riskMatter.id,
      code: riskMatter.code,
      name: riskMatter.name,
      type: riskMatter.type,
      level: riskMatter.level,
      source: riskMatter.source,
      status: riskMatter.status,
      conversionStatus: riskMatter.conversionStatus,
      convertedCaseCount: riskMatter.convertedCaseCount,
      /**
       * 已转案件时，`操作`列要跳去的那个案卷（canon `risk-matters.html`：已转的行
       * 写「查看案件」而不是「查看」）。
       *
       * 一个事项可以建多张卡（`mn_risk_matter_case` 是 N:N），这里取最早的一张 ——
       * `convertedCaseCount` 只是计数，点进去必须落到某一份具体案卷上。
       * `::text` 是为了避开 bigint 在 JSON 里丢精度（列表的 `id` 同一个处理）。
       * 关联键同样必须是裸限定名（理由见下面 `nextDeadline` 那条注）。
       */
      convertedMatterId: sql<
        string | null
      >`(select min(rmc.matter_id)::text from mn_risk_matter_case rmc
        where rmc.risk_matter_id = mn_risk_matter.id)`,
      isArchived: riskMatter.isArchived,
      archivedAt: riskMatter.archivedAt,
      discoverDate: riskMatter.discoverDate,
      /** 上报时间（canon `risk-matters.html` 那一列）：登记进系统的时刻 */
      createdAt: riskMatter.createdAt,
      updatedAt: riskMatter.updatedAt,
      /**
       * 最近一个未决节点的期限（canon `risk-matters.html` 的「期限」列）。
       *
       * ⚠ 关联键必须是**裸限定名** `mn_risk_matter.id`，不能写 `${riskMatter.id}` ——
       * 在 select 列表上下文里 drizzle 会把它渲染成无限定的 `"id"`，而子查询里的
       * `mn_risk_matter_node` 自己也有 `id` ⇒ 条件变成 `rn.risk_matter_id = rn.id`，
       * **恒假且不报错**，这一列就静默全空（案件侧 `matterListSelection` 踩过同一个坑）。
       *
       * 判据与案件侧逐字相同（未删除 + 未完成/进行中的节点，取最早期限），
       * 只是事项侧没有预设节点（IQ-5），所以大多数行会是「未定」。
       */
      nextDeadline: sql<string | null>`(select min(rn.deadline_time) from mn_risk_matter_node rn
        where rn.risk_matter_id = mn_risk_matter.id
          and not rn.is_deleted
          and rn.status = 'in_progress')`,
      // ownerId 与 ownerName **成对**返回：筛选用的是 owner_id，
      // 而行里只有 ownerName 的话，"被筛掉了哪些"就说不清了，前端也判不了未指派。
      ownerId: riskMatter.ownerId,
      ownerName: appUser.displayName,
      /**
       * 已挂当事人条数。列表页每行都拿它判「能不能转案件」：0 个当事人时
       * 转案件必被 422 `parties_required` 挡下 —— 与其让用户点一次吃一次闭门羹，
       * 不如在列表上就看出来。
       */
      partyCount: dcount(riskMatterParty.id),
    })
    .from(riskMatter)
    .leftJoin(appUser, eq(appUser.id, riskMatter.ownerId))
    /**
     * 当事人条数用 LEFT JOIN + 聚合，**不用相关子查询**。
     *
     * 踩过的坑：drizzle 的 `sql` 模板会把 `${riskMatter.id}` 渲染成**裸列名** `"id"`，
     * 子查询里的 `"id"` 于是解析到内层表 `mn_risk_matter_party.id`，
     * 条件变成 `rp.risk_matter_id = rp.id`，恒假 —— 结果恒为 0，且**不报错**。
     *
     * 同一个坑 `ownerName` 一直躲着没炸：它渲染成 `"owner_id"`，
     * 而内层表 `mn_app_user` 恰好没有同名列，PG 才向上解析到外层。
     * 那是**侥幸**不是正确 —— 日后谁给 `mn_app_user` 加一列 `owner_id`，
     * 负责人名就会静默变空。两个一起改成 join，一劳永逸。
     */
    .leftJoin(riskMatterParty, eq(riskMatterParty.hostId, riskMatter.id))
    .where(where)
    .groupBy(riskMatter.id, appUser.displayName)
    .orderBy(q.sortDir === "asc" ? asc(sortCol) : desc(sortCol), desc(riskMatter.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  return {
    items: rows.map((r) => ({ ...r, id: String(r.id), nextDeadline: r.nextDeadline ?? null })),
    page: q.page,
    pageSize: q.pageSize,
    total: Number(total?.n ?? 0),
  };
}

/**
 * 「经办人」筛选下拉的候选集（canon `risk-matters.html` 查询区，口径同案件侧
 * `listMatterOwners`）：当前筛选下**真实出现过**的经办人。
 *
 * 与 `listRiskMatters` **同一个 where**，只去掉 `owner` 自己——否则一旦选了一个人，
 * 下拉里就只剩他一个，换人得先清空再选。
 *
 * `owner_id` 可空（IQ-5）：`DISTINCT` 会带回一行 `null`，那不是一个人，
 * 由前端固定的「未指派」选项承担，这里过滤掉。
 */
export async function listRiskMatterOwners(
  actor: Actor,
  q: {
    status?: string;
    keyword?: string;
    archivedOnly?: boolean;
    ownerEmpty?: boolean;
    riskLevel?: string;
    reportBucket?: "week" | "month" | "quarter";
  },
): Promise<{ id: string; displayName: string }[]> {
  const db = await getDb();
  const where = riskMattersListWhere(actor, { ...q, owner: undefined });
  const rows = await db
    .selectDistinct({
      id: riskMatter.ownerId,
      displayName: appUser.displayName,
    })
    .from(riskMatter)
    .innerJoin(appUser, eq(appUser.id, riskMatter.ownerId))
    .where(where)
    .orderBy(asc(appUser.displayName));
  return rows.map((r) => ({ id: String(r.id), displayName: r.displayName }));
}

type Db = Awaited<ReturnType<typeof getDb>>;
/** 事务句柄：与 `services/nodes.ts`、`services/parties.ts` 同一取法（从回调参数上取，别自己拼泛型） */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 建事项：编号 `FX-`，`discover_date` 是日历 `date`（§12.2）。
 *
 * `opts.dryRun`（MATT-102）与 `createMatter` 同口径：只跳过取号与写库那个事务，
 * 事务之前的配置读取与 `assertAssignable` 照常跑 —— 预检与真导共用同一段判据。
 * 理由与更完整的说明见 `services/matters.ts` 的 `createMatter`。
 */
export async function createRiskMatter(
  actor: Actor,
  input: {
    name: string;
    type: string;
    level: string;
    source?: string | null;
    description: string;
    discoverDate?: string | null;
    ownerId?: string;
    /** 创建时的关注人（IQ-5 + IQ-14 的创建期例外），见 `riskCreateSchema` 注释 */
    followerIds?: string[];
    /**
     * 当事人。**这一栏之前根本不存在**——`riskMatterParty` 全仓只有读没有写，
     * 于是走 UI 建的事项必然当事人=0，转案件必然 422 `parties_required`，
     * 而那条 422 正在叫用户「请先在事项上添加再转」，可那个入口并不存在。
     *
     * 与案件侧共用 `planPartyLinks` / `insertNewParties`：同一套值域、同一套校验、
     * 同一个 `(type, id_number)` 去重。两条宿主线在这里必须同源，否则会出现
     * "案件侧能建的事项当事人、事项侧建不出来"的错位。
     */
    parties?: readonly PartyLinkInput[];
  },
  opts: { dryRun?: boolean } = {},
) {
  const db = await getDb();
  const dryRun = opts.dryRun === true;
  const { code } = dryRun ? { code: "" } : await nextCode("riskMatter");
  const id = BigInt(nextId());
  const owner = input.ownerId ? BigInt(input.ownerId) : null;
  // 被指派者必须在册可用（MATT-49）：与案件侧同一句判定（`assertAssignable` 是唯一谓词）。
  // 事项的负责人**可空**（IQ-5），所以只有给了 id 才查——空值走不到这里。
  // 处理人与关注人合成一次查询：同一个谓词跑两遍没有额外收益。
  await assertAssignable([owner === null ? null : String(owner), ...(input.followerIds ?? [])]);

  /**
   * 创建时的关注人，**去重且转成 bigint**（与案件侧同形）。
   *
   * 去重：同一批里重复的 id 会撞 `uk_mn_risk_matter_staff_triple`。
   * 提到事务外一次算好，是为了让名单插入与 `syncFollowWatch` 吃**同一个数组**。
   */
  const followers = [...new Set(input.followerIds ?? [])].map(BigInt);
  // 在**进入事务前**取：事务内再向池子要一条连接去查配置，池子满时会互等成死锁
  const initial = await initialStatusCode("risk_matter");
  // ⚠ **事项侧不生成任何预设节点**（IQ-5：「事项是台账，案件是战场」）。
  // 这里曾调 `planPresetNodesFor("risk_matter")`，而节点类型配置里 3 行 risk_matter
  // 的 `preset_on_create` 当时还是 true，于是每建一条事项就被塞 3 个系统节点。
  // 节点改为**经办人手动添加**；节点类型行保留（可手动选），只是不再自动实例化——
  // 裁定否掉的是「塞几个」，不是「可以选什么」。
  // 同样是事务前算好——它要连库查当事人，既不能在事务里做，也要在事务外拿到冲突清单
  const partyPlan = await planPartyLinks(input.parties ?? []);

  // 预检到此为止（MATT-102）：上面的配置读取、`assertAssignable` 与当事人规划都是判据，
  // 只有下面的事务是写库。与 `createMatter` 同一处落点、同一句口径。
  if (dryRun) return { id: String(id), code, nameConflicts: partyPlan.nameConflicts };

  await db.transaction(async (tx) => {
    await tx.insert(riskMatter).values({
      id,
      code,
      name: input.name,
      type: input.type,
      level: input.level,
      source: input.source ?? null,
      description: input.description,
      /**
       * 发现日期：留空按「今天」记。
       *
       * ⚠ **「今天」必须是上海日**（2026-10-15，MATT-79）。原写法是
       * `new Date().toISOString().slice(0, 10)` —— 那是 **UTC 日**，于是上海时间
       * 00:00–08:00 之间登记的事项会被记成**前一天**，而用户无从发现（他确实是
       * 在那天登记的）。
       *
       * 这与案件侧的 `closing_date` 是**同一个错**（MATT-69，提交 `2c4806d`），
       * 两处同形、同因、同一个 helper。`businessDateKey` 的注释里早已写明为什么
       * 必须是上海日：「否则上海时间 0–8 点之间的那一批扫描会归到前一天，
       * 而前一天的 key 已经被用过 ⇒ 那一批提醒被静默吞掉」。
       *
       * 界面行为不变：表单仍提示「留空按今天记」—— 变的是**「今天」怎么算**。
       */
      discoverDate: input.discoverDate ?? businessDateKey(new Date().toISOString()),
      status: initial,
      ownerId: owner,
      createdBy: BigInt(actor.userId),
      updatedBy: BigInt(actor.userId),
    });
    // 经办人**可空**（IQ-5）：不填就落 NULL，表示"未指派处理人"，
    // 由持 L1 的人「变更处理人」接手。原实现落 `actor.userId`，等于"谁登记谁是经办人"，
    // 那让未指派状态永远不可达，而 GLOSSARY「变更处理人」条的定义正是**未指派**的事项。
    if (owner !== null) {
      await tx.insert(riskMatterStaff).values({
        id: BigInt(nextId()),
        hostId: id,
        userId: owner,
        staffRole: "owner",
      });
    }
    // 创建时的关注人（IQ-5「处理人与关注人在表单上可选填」+ IQ-14 的创建期例外）。
    // 与 owner 同事务：分开提交会留下"事项建好了但关注人没进去"的中间态，
    // 而用户看到的是"我填了关注人"——那种账对不上，也没有入口能补回来。
    // 去重：同一批里重复的 id 会撞 `uk_mn_risk_matter_staff_triple`。
    if (followers.length) {
      await tx.insert(riskMatterStaff).values(
        followers.map((uid, i) => ({
          id: BigInt(nextId()) + BigInt(i),
          hostId: id,
          userId: uid,
          staffRole: "follower",
        })),
      );
    }
    // 关注同步（ADR-0003 / MATT-63）：与案件侧同一句 —— `*_staff.follower` 与
    // `user_watch(follow)` 是**同一张表的两面**，只写名单不写关注行就是半截状态。
    await syncFollowWatch(tx, {
      host: "risk_matter",
      hostId: id,
      userIds: followers,
      action: "add",
    });
    await linkRiskParties(tx, id, partyPlan.rows, BigInt(actor.userId));
    await logActivity(tx, actor, {
      riskMatterId: id,
      targetType: "risk_matter",
      targetId: id,
      action: "RISK_CREATED",
    });
  });
  // 与案件侧同口径：同名不同证件号照建，但把冲突清单带回给前端提示，不静默吞掉
  return { id: String(id), code, nameConflicts: partyPlan.nameConflicts };
}

/**
 * 把 `planPartyLinks` 的结果写进 `mn_risk_matter_party`。
 *
 * ⚠ **不写 `represented`**：该列已随 IQ-15 软作废（企业口径下我方永不入 party 表）。
 * 列保留在库，但这是它第一次有机会被写入——在这里补一个默认值，就等于把刚摘除的
 * 语义又悄悄写回去。所以**不提供**该参数的默认值，让"忘了写"变成编译期错误。
 */
async function linkRiskParties(
  tx: Tx,
  riskMatterId: bigint,
  rows: readonly PartyLinkPlanRow[],
  actorUserId: bigint,
): Promise<void> {
  if (rows.length === 0) return;
  await insertNewParties(tx, rows, actorUserId);
  await tx.insert(riskMatterParty).values(
    rows.map((r) => ({
      id: BigInt(nextId()),
      hostId: riskMatterId,
      partyId: r.partyId,
      partyRole: r.partyRole,
      sortOrder: r.sortOrder,
    })),
  );
}

/**
 * 建事项后追加当事人。与建事项那次走同一套校验与去重。
 *
 * **冻结（MATT-82 / ADR-0005）**：事项转过案件之后当事人也不能再加 —— 判据是
 * `isRiskFrozen`。「当事人」是业务内容（这条台账把谁卷了进来），不是协作面：
 * 转案件时案件侧会**引用同一批 `mn_party` 行**复制过去，此后在事项侧补一个人，
 * 那个补上去的人**不会**出现在已经转出去的案卷里 —— 两边的当事人名单从此不一致，
 * 而界面上看两者都"正常"。这是与本票另两条门同一个失败形态：改错了不出声。
 * 排在归档与归属判定之前：冻结是这条记录的属性，与"你是不是经办人"无关。
 */
export async function appendRiskParties(
  actor: Actor,
  riskId: string,
  links: readonly PartyLinkInput[],
): Promise<{ ok: true; added: number } | { ok: false; why: "not_found" | "frozen" }> {
  const db = await getDb();
  const [src] = await db
    .select({
      id: riskMatter.id,
      isArchived: riskMatter.isArchived,
      conversionStatus: riskMatter.conversionStatus,
    })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!src) return { ok: false, why: "not_found" };
  if (isRiskFrozen(src.conversionStatus)) return { ok: false, why: "frozen" };
  if (src.isArchived) return { ok: false, why: "not_found" };

  const plan = await planPartyLinks(links);
  // 追加要从**现有最大 sort_order 之后**接着排，否则新行会插到已有行中间，
  // 当事人区在页面上的顺序会随每次追加而变。
  const [last] = await db
    .select({ max: sql<number | null>`max(${riskMatterParty.sortOrder})` })
    .from(riskMatterParty)
    .where(eq(riskMatterParty.hostId, BigInt(riskId)));
  const base = Number(last?.max ?? -1);

  await db.transaction(async (tx) => {
    await linkRiskParties(
      tx,
      BigInt(riskId),
      plan.rows.map((r, i) => ({ ...r, sortOrder: base + 1 + i })),
      BigInt(actor.userId),
    );
    await tx
      .update(riskMatter)
      .set({ updatedBy: BigInt(actor.userId), updatedAt: new Date().toISOString() })
      .where(eq(riskMatter.id, BigInt(riskId)));
  });
  return { ok: true, added: plan.rows.length };
}

/**
 * 摘除一条当事人挂接。删的是**关联行**，不是当事人本体——后者归 T3 管的档案。
 *
 * **冻结（MATT-82 / ADR-0005）**：与 `appendRiskParties` 同一条理由的另一半 ——
 * 转案件之后从事项侧摘掉一个当事人，已转出去的案卷里那一行还在，而事项侧看起来
 * 这个人从未被牵涉。名单分叉在界面上不可见（两边各自正常），所以只能在这里拒。
 * 排在归属判定之前：冻结是这条记录的属性，与"你是不是经办人"无关。
 */
export async function removeRiskParty(
  actor: Actor,
  riskId: string,
  linkId: string,
): Promise<{ ok: true } | { ok: false; why: "not_found" | "frozen" }> {
  const db = await getDb();
  const [src] = await db
    .select({ id: riskMatter.id, conversionStatus: riskMatter.conversionStatus })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!src) return { ok: false, why: "not_found" };
  if (isRiskFrozen(src.conversionStatus)) return { ok: false, why: "frozen" };

  // 删之前先按**事项 + 关联行**两道条件命中，避免误删到别的事项上去
  const [link] = await db
    .select({ id: riskMatterParty.id })
    .from(riskMatterParty)
    .where(and(eq(riskMatterParty.hostId, BigInt(riskId)), eq(riskMatterParty.id, BigInt(linkId))))
    .limit(1);
  if (!link) return { ok: false, why: "not_found" };

  await db.transaction(async (tx) => {
    await tx.delete(riskMatterParty).where(eq(riskMatterParty.id, link.id));
    await tx
      .update(riskMatter)
      .set({ updatedBy: BigInt(actor.userId), updatedAt: new Date().toISOString() })
      .where(eq(riskMatter.id, BigInt(riskId)));
  });
  return { ok: true };
}

/** 事项已挂的当事人（联表取本体，供展示与转案件校验共用一份口径） */
export async function listRiskParties(actor: Actor, riskId: string) {
  const db = await getDb();
  const [src] = await db
    .select({ id: riskMatter.id })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!src) return null;
  const rows = await db
    .select({
      id: riskMatterParty.id,
      partyId: riskMatterParty.partyId,
      partyRole: riskMatterParty.partyRole,
      sortOrder: riskMatterParty.sortOrder,
      name: party.name,
      type: party.type,
      idNumber: party.idNumber,
    })
    .from(riskMatterParty)
    .innerJoin(party, eq(party.id, riskMatterParty.partyId))
    .where(eq(riskMatterParty.hostId, BigInt(riskId)))
    .orderBy(asc(riskMatterParty.sortOrder));
  return rows.map((r) => ({
    id: String(r.id),
    partyId: String(r.partyId),
    partyRole: r.partyRole,
    name: r.name,
    type: r.type,
    /**
     * ⚠ **必须解密**：MATT-40 把 `party.id_number` 改成存密文（`v1:<base64url>` 信封）之后，
     * 直接回原文就是把密文交给接口——而信封是个合法字符串，**不会报错**，只有眼睛能发现。
     * `decryptField` 对"不是信封"的值原样返回，所以存量明文行（未回填的演示数据）照常显示。
     *
     * 这条修过一次又被并发写入覆盖（同一棵树上另一条流在改这个文件），
     * 所以它现在有冒烟断言盯着（`smoke-parties.mjs` 断言 `idNumber` 不含 `v1:` 前缀）。
     */
    idNumber: decryptField(r.idNumber),
  }));
}

/**
 * 转案件的结果。`null` 只表示"这条事项你看不见或不存在"（→ 404，元规则 3），
 * 业务性拒绝改成带原因的联合，因为前端要对「先给事项加当事人」这句话给出**下一步动作**，
 * 而不是回一句"操作失败"。
 */
export type ConvertResult =
  | { ok: true; cases: { id: string; internalCode: string }[] }
  | { ok: false; why: "not_found" | "no_parties" | "archived" | "too_many_cases" };

/** 一次转案件提交的**单张**案件卡（映射矩阵 §3.1 的逐案校验在调用它之前已完成） */
export type ConvertCaseInput = {
  name: string;
  cause: string;
  caseType: string;
  procedure: string;
  litigationRole: string;
  court?: string | null;
  level: string;
  filingDate?: string | null;
  /** 标的金额。映射矩阵 §2.4：**不继承**事项金额，逐案自填；留空即 null */
  amount?: string | null;
  /** 案号。§6.3：**非唯一**，重复只提示不阻止；留空则回退为内部编号 */
  caseNo?: string | null;
};

/** 一次提交最多几个案件 —— 与 `convertFormSchema` 的 `cases.max(20)` 同源，两边都改 */
export const MAX_CASES_PER_CONVERT = 20;

/**
 * 转案件（映射矩阵 §1/§2）。**一次提交 N 个案件**（N ≥ 1）。
 *
 * 基线 1:N 且**可追加**——一个风险衍生出多起诉讼常跨月发生；禁止追加会把用户
 * 逼回"新建案件"，从而丢掉关联，那才是真损失（§1「是否可追加」）。
 *
 * 三条实现口径，都不是风格：
 *  1. **N 个案件 + 关联回写 + 事项状态变更 = 单事务**。分批提交会留下"转了一半"的
 *     事项，而 `conversion_status` 只有 0/1 两值，**无法表达半态**（§1「原子性」）。
 *  2. `converted_case_count` 用 **COUNT(*) 重算**而非累加。累加在撤销之后会永久偏移，
 *     而计数是"已转案件"徽标的唯一数据源。
 *  3. `converted_at` / `converted_by` **仅首次写**。它记的是"什么时候第一次转的"，
 *     每次追加都刷新等于把首次时间冲掉（§4 事务第 4 步："converted_at/by 仅首次写"）。
 *
 * 当事人是**引用同一批 `mn_party` 行**、不是克隆（§2.6）：这就是为什么这里复制
 * `risk_matter_party` 的 `party_id` 而不是新建当事人。复制 `party_role` 作为默认值，
 * 逐案可改 —— 风险阶段的角色与诉讼阶段的角色通常一致，但不保证（§2.6 原话）。
 */
export async function convertToCase(
  actor: Actor,
  riskId: string,
  inputs: ConvertCaseInput[],
): Promise<ConvertResult> {
  const db = await getDb();
  const [src] = await db
    .select()
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!src) return { ok: false, why: "not_found" };
  // 归档是终态：需先 `can_unarchive` 撤销归档（§5.2 转换语义表最后一行）
  if (src.isArchived) return { ok: false, why: "archived" };
  if (inputs.length < 1 || inputs.length > MAX_CASES_PER_CONVERT) {
    return { ok: false, why: "too_many_cases" };
  }

  // 引用事项已关联的当事人。一条都没有就直接拒：修订稿 §6.2 把"每案 ≥1 当事人"定在
  // **转案件确认**这个校验时机上，放过就会建出一件没有对手方也没有委托方的案卷。
  const srcParties = await db
    .select({
      partyId: riskMatterParty.partyId,
      partyRole: riskMatterParty.partyRole,
      sortOrder: riskMatterParty.sortOrder,
    })
    .from(riskMatterParty)
    .where(eq(riskMatterParty.hostId, BigInt(riskId)))
    .orderBy(asc(riskMatterParty.sortOrder));
  if (srcParties.length === 0) return { ok: false, why: "no_parties" };

  // 取号与取配置都在**进事务之前**做完：事务里再向池子要连接，池子满时会互等成死锁。
  // 取号是 N 次——每张卡各拿一个号，且天然不重号（编号生成器是单语句原子取号）。
  const codes = await Promise.all(inputs.map(() => nextCode("matter")));
  const caseIds = inputs.map(() => BigInt(nextId()));
  const initial = await initialStatusCode("matter");
  const presetNodes = await planPresetNodesFor("matter");
  // batch_id 兼任通知聚合键（权限草案 §7.1）：一次转换发出的通知聚合成一条，
  // 否则用户会收到 N 条同源通知，然后开始屏蔽通知（G3 反例）。
  const batchId = randomUUID();

  await db.transaction(async (tx) => {
    // 逐案写入。同一批内的 N 张卡共享同一批号、同一批当事人引用与同一批预设节点。
    for (const [i, input] of inputs.entries()) {
      const code = codes[i]!.code;
      const caseId = caseIds[i]!;
      await tx.insert(matter).values({
        id: caseId,
        internalCode: code,
        // 案号默认取内部编号，可改；**非唯一**，重复只提示不阻止（§6.3）
        caseNo: input.caseNo?.trim() || code,
        // 描述**不继承**（P0-1）：只带事项名称作为初始案由说明，正文留空由负责人逐案填
        name: input.name,
        cause: input.cause,
        caseType: input.caseType,
        procedure: input.procedure,
        litigationRole: input.litigationRole,
        court: input.court ?? null,
        // 金额**不继承**事项敞口（映射矩阵 §2.4）：多起诉讼通常按案分摊，逐案自填。
        // 列是 `notNull`（把"可空"改掉是破坏性迁移，另票），所以未填落 "0"；
        // "0 元标的"与"未填"两种业务事实的区分留给导出/报表层，本轮不引入。
        amount: input.amount?.trim() || "0",
        level: input.level,
        status: initial,
        filingDate: input.filingDate ?? null,
        ownerId: BigInt(actor.userId),
        createdBy: BigInt(actor.userId),
        updatedBy: BigInt(actor.userId),
        lastProgressAt: new Date().toISOString(),
      });
      await tx.insert(matterStaff).values([
        { id: BigInt(nextId()), hostId: caseId, userId: BigInt(actor.userId), staffRole: "owner" },
        ...(src.ownerId === BigInt(actor.userId)
          ? []
          : [
              {
                id: BigInt(nextId()),
                hostId: caseId,
                userId: src.ownerId ?? BigInt(actor.userId),
                staffRole: "co_owner" as const,
              },
            ]),
      ]);
      for (const p of srcParties) {
        await tx.insert(matterParty).values({
          id: BigInt(nextId()),
          hostId: caseId,
          partyId: p.partyId,
          partyRole: p.partyRole,
          sortOrder: p.sortOrder,
        });
      }
      await insertPlannedNodes(tx, "matter", caseId, presetNodes, BigInt(actor.userId));
    }
    await tx.insert(riskMatterCase).values(
      caseIds.map((cid) => ({
        id: BigInt(nextId()),
        riskMatterId: BigInt(riskId),
        matterId: cid,
      })),
    );

    // 计数用 COUNT(*) **重算**而非累加：撤销会让累加永久偏移，而它是徽标的唯一数据源。
    // converted_at/by **仅首次写**——它记的是"第一次转的时间"，追加转换不刷新。
    await tx
      .update(riskMatter)
      .set({
        conversionStatus: 1,
        convertedAt: src.convertedAt ?? new Date().toISOString(),
        convertedBy: src.convertedBy ?? BigInt(actor.userId),
        convertedCaseCount: sql`(select count(*) from ${riskMatterCase} where ${riskMatterCase.riskMatterId} = ${BigInt(riskId)})`,
        updatedBy: BigInt(actor.userId),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(riskMatter.id, BigInt(riskId)));

    // 事件**在同事务里**写 outbox（映射矩阵 §4.1）。事后再补会丢；而在事务内同步执行
    // 规则 7 则会读到未提交行、或自身失败把整次转换一起回滚。
    //
    // `case_ids` 与 `batch_id` 一起进 payload：消费侧要为**每个案件**各生成一条通知意图
    // （MATT-41 / §7.2 合并规则 1），而它们共享同一个 `batch_id` ⇒ 聚合键相同
    // ⇒ N 条意图被吸收成 1 条事件（`merge_count` 记下吸收了几条）。
    // 少了 `actor_name`，`case_archived` 模板的 `{actor}` 就只能落 `—`。
    await tx.insert(eventOutbox).values({
      id: BigInt(nextId()),
      eventType: "risk_converted",
      batchId,
      payload: {
        risk_matter_id: riskId,
        case_ids: caseIds.map((c) => String(c)),
        from: src.code,
        actor_id: actor.userId,
        actor_name: actor.displayName,
      },
    });

    await logActivity(tx, actor, {
      matterId: caseIds[0]!,
      riskMatterId: BigInt(riskId),
      targetType: "risk_matter",
      targetId: BigInt(riskId),
      action: "CONVERTED_TO_CASE",
      payload: {
        case_ids: caseIds.map((c) => String(c)),
        from: src.code,
        batch_id: batchId,
      },
    });
  });
  return {
    ok: true,
    cases: caseIds.map((cid, i) => ({ id: String(cid), internalCode: codes[i]!.code })),
  };
}

/** 阻止撤销的原因。列出来而不是并成一个布尔：前端要逐条告诉用户"还差什么" */
export type UnconvertBlocker = "progress" | "nodes" | "expenses";

export type UnconvertResult =
  | { ok: true; caseId: string; remaining: number }
  | { ok: false; why: "not_found" | "not_linked" | "reason_required" | "frozen" }
  | { ok: false; why: "blocked"; blockers: UnconvertBlocker[] };

/**
 * 撤销转案件关联（修订稿 §3.4 + 映射矩阵 §5.1）。
 *
 * **只删 `risk_matter_case` 关联行，案件本身保留为独立案件。**
 * 修订稿 §3.4 原文：「不允许人工设置或回滚为 0：若需撤销，只能删除 `risk_matter_case` 关联行」，
 * 理由是"否则会出现事项显示已转案件但关联已被清空"。所以这里不碰 `mn_matter` 的任何列——
 * 删案件会连同用户后来在它上面做的登记一起抹掉，而那不是"撤销一次转案件"。
 *
 * 前置：**目标案件无进展/费用/节点（除 P1 预设外）**。
 * 预设节点由系统在建案时生成（`source_kind='preset'`），用户还没动手；
 * 不排除它就等于"刚转出来的案件永远撤不掉"（映射矩阵 §5.1 原话）。
 *
 * ⚠ **"费用"这条前置由 MATT-47（迁移 0011）接上**：在此之前 `mn_matter_expense` 表
 * 不存在，所以这条判定形同虚设（旧注释就记着这个缺口）。现在它走
 * `hasMatterExpenses`（`services/expenses.ts`）——与费用列表**同一份谓词**
 * （未软删 + 属于这个案件）。两处各写一遍 SQL 的失败形态是"列表里看不到的费用
 * 却挡着撤销"，而它**不报错**：前置失效是静默的。
 *
 * **不自动解除归档**（映射矩阵 §5.1）：自动回滚归档等于让一次动作隐式解开另一次
 * 状态变更，审计链会断。已归档的案件保持归档，需人工持 `can_unarchive` 撤销。
 * 同理**不写 outbox**：§5.1 只要求 `activity_log(UNCONVERT)`，且规则 7 只监听
 * `0 → 1` 这一次变更，撤销方向没有已定义的消费者。
 *
 * ⚠ **冻结（2026-10-14 裁定）使这个函数整体不可达** —— 下面第一节就把这件事写明了。
 * 端点与三条前置都按票面要求留着（用户在「保留端点并给出理由」与「删掉端点」之间选了前者），
 * 三条前置因此退成第二道防线，而不是唯一一道。
 */
export async function unconvertFromCase(
  actor: Actor,
  riskId: string,
  caseId: string,
  input: { reason: string },
): Promise<UnconvertResult> {
  // reason 必填（枚举表 §3.2）。空串要在进库前拒——审计里存一条"无理由撤销"
  // 等于没审计，而撤销是本链路上唯一不可逆的动作。
  const reason = input.reason.trim();
  if (!reason) return { ok: false, why: "reason_required" };

  const db = await getDb();
  const [src] = await db
    .select()
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!src) return { ok: false, why: "not_found" };

  /**
   * **冻结门（2026-10-14 裁定）—— 本函数的第一道，也是实际上唯一一道会命中的门。**
   *
   * 判据只有一个：这条事项转过案件没有（`isRiskFrozen`）。已转 ⇒ 冻结 ⇒ 不可撤销。
   * 返回的 `why` 是 **`frozen` 而不是 `blocked`**：`blocked` 后面跟的是"案件上已经登记了
   * 进展/节点/费用"，那些理由会**把人引向案件那边去补救**；而 `frozen` 说的是"这件事本身
   * 就不能撤"，两者要做的下一步完全不同。合成一条笼统的 422 就把这两件事说成了一件。
   *
   * **放在 `not_linked` 之前**：冻结是这条事项的属性，与请求里带的是哪个 `caseId` 无关。
   * 顺序若反过来，同一条冻结的事项会因为 `caseId` 写得对不对而给出两种答复 ——
   * 用户会以为"换个 id 就能撤"。
   *
   * ⚠ **这条门使下面整段（含三条前置与那个事务）不可达**：能走到事务里就意味着
   * "有 `risk_matter_case` 关联行"与"`conversion_status !== 1`"同时成立，而这两件事
   * 在业务上互斥（转案件同一个事务里写关联行与 `conversion_status=1`）。
   * 保留这段是票面裁定的要求；它的注释已按"不可达但不许静默错"重写，见下面事务里那几行。
   */
  if (isRiskFrozen(src.conversionStatus)) return { ok: false, why: "frozen" };

  // 关联行必须存在：本函数只管"走转案件链路生成"的案件。
  // 直接新建的案件没有关联行，它的删除走 F2-5 软删，不受本函数约束（§5.1 末段）。
  const [link] = await db
    .select({ id: riskMatterCase.id })
    .from(riskMatterCase)
    .where(
      and(
        eq(riskMatterCase.riskMatterId, BigInt(riskId)),
        eq(riskMatterCase.matterId, BigInt(caseId)),
      ),
    )
    .limit(1);
  if (!link) return { ok: false, why: "not_linked" };

  const blockers: UnconvertBlocker[] = [];
  // **排掉软删行**：与下面节点那条 `NOT is_deleted` 同口径，也与费用那条同口径 ——
  // "已经删掉的登记不算还投入在上面"。`mn_matter_progress` 确实有 `is_deleted`
  // （`auditColumns` 那一组），不排它就会出现"列表里已经看不到这条进展了，
  // 撤销却还被它挡着"——而且提示语会说"案件上已经登记了进展"。
  //
  // ⚠ 这条是**后补的**：三条前置里原先只有它没排软删，而 MATT-47 的注释
  // 已经把"软删不算投入"写成了统一口径（注释先行、实现漏了一条）。
  // 检查子代理逐条对照三处谓词时发现的——**三处谓词只对了两处，光读注释看不出来**。
  const [progressRows] = await db
    .select({ n: dcount() })
    .from(matterProgress)
    .where(and(eq(matterProgress.hostId, BigInt(caseId)), sql`NOT ${matterProgress.isDeleted}`));
  if ((progressRows?.n ?? 0) > 0) blockers.push("progress");

  // **排除 preset**：系统在建案瞬间生成的那批节点不算用户投入。
  // 与 matters.ts 同口径：宿主列是 `host_id`（多态表按宿主拆表但列名统一），
  // 且要排掉软删行——已软删的节点同样不算"还投入在上面"。
  const [nodeRows] = await db
    .select({ n: dcount() })
    .from(matterNode)
    .where(
      and(
        eq(matterNode.hostId, BigInt(caseId)),
        sql`${matterNode.sourceKind} <> 'preset'`,
        sql`NOT ${matterNode.isDeleted}`,
      ),
    );
  if ((nodeRows?.n ?? 0) > 0) blockers.push("nodes");

  /**
   * 费用（映射矩阵 §5.1 的前置第三条）。
   *
   * 判定复用 `hasMatterExpenses`（`services/expenses.ts`）：它与费用列表读的是
   * **同一份谓词**（属于这个案件 + 未软删）。这里不自己写一遍 SQL —— 那正是这条前置
   * 失效时不会报错的原因：列表里看不见的费用，会静默地挡住（或放行）一次撤销。
   *
   * 软删行**不算投入**：与上面节点那条 `NOT is_deleted` 同口径（"已经删掉的登记
   * 不算还投入在上面"）。用户删掉唯一一条费用之后，撤销就该重新可用。
   */
  if (await hasMatterExpenses(db, BigInt(caseId))) blockers.push("expenses");

  if (blockers.length > 0) return { ok: false, why: "blocked", blockers };

  /**
   * ⚠ 冻结之后**整段不可达**（见上面冻结门那段注释）。票面要求保留端点与三条前置，
   * 所以这段留着；但它已经不是活代码，下面每个"看似还要判断"的地方都按不可达重写了。
   */
  const remaining = await db.transaction(async (tx) => {
    await tx.delete(riskMatterCase).where(eq(riskMatterCase.id, link.id));

    // 计数同样用 COUNT(*) 重算。与 convertToCase 同一口径——这正是它当初被改掉的原因：
    // 累加在撤销之后会永久偏移，而它是"已转 N 个案件"徽标的唯一数据源。
    // **这一列的口径不变**（裁定明写 `converted_case_count` 仍按 COUNT(*) 重算）。
    const [cnt] = await tx
      .select({ n: dcount() })
      .from(riskMatterCase)
      .where(eq(riskMatterCase.riskMatterId, BigInt(riskId)));
    const rest = Number(cnt?.n ?? 0);

    /**
     * `rest === 0` 在冻结之后不可达：`not_linked` 已证明这条关联行存在，删掉它之后
     * 同一条 `risk_matter_case` 上必然还剩至少 0 条 —— 而 0 只在"别的并发请求刚把最后
     * 一条也撤了"时成立，那件事与本事务无关。
     *
     * 所以这里**抛错而不是回 0**。原写法 `rest > 0 ? 1 : 0` 的 `: 0` 分支会把两列不一致
     * （`conversion_status` 还挂着 0、关联行却刚被删掉）默默抹平成一个看着正常的值，
     * 而那种数据的失败形态是"徽标说没转过、案件确实存在" —— 没人报错，永远查不出来。
     * `batchArchiveRiskMatters` 对"配置表少一行归档态"也是这个处理，两处同一种取向：
     * **不可达的不变量破了要响，不要顺手填一个数。**
     */
    if (rest === 0) {
      throw new Error(
        `撤销转案件时关联计数归零（risk_matter.id=${riskId}）：` +
          `mn_risk_matter_case 与 mn_risk_matter.conversion_status 不一致，需要人工核对`,
      );
    }

    /**
     * `conversion_status` **不再由关联条数推导**（原写法 `rest > 0 ? 1 : 0`）。
     *
     * 冻结之后它只有一个合法值 1：唯一写过 0 的就是本函数，而本函数已被 `isRiskFrozen`
     * 挡在门外；裁定也明说 `conversion_status` 再也不会回落到 0。
     * 同一段里的 `convertedAt` / `convertedBy` 原先也带 `rest > 0 ?` —— 那个三元同样
     * 归零才清时间戳，而"归零"现在抛错，所以它们也一并去掉：不是"变成恒真"，是**恒真的
     * 那一支已经不存在了**，留着只会让人以为还有一个归零分支要维护。
     */
    await tx
      .update(riskMatter)
      .set({
        conversionStatus: 1,
        convertedAt: src.convertedAt,
        convertedBy: src.convertedBy,
        convertedCaseCount: rest,
        updatedBy: BigInt(actor.userId),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(riskMatter.id, BigInt(riskId)));

    await logActivity(tx, actor, {
      matterId: BigInt(caseId),
      riskMatterId: BigInt(riskId),
      targetType: "risk_matter",
      targetId: BigInt(riskId),
      action: "UNCONVERT",
      reason,
      payload: { case_id: caseId, converted_case_count: rest },
    });
    return rest;
  });

  return { ok: true, caseId, remaining };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 事项详情成链（T1）
 *
 * 这一段之前**整段不存在**：事项侧只有列表与建档，而案件侧五条路径俱全。
 * 地图把它记为「欠账，不是裁定」——所以才在这里补齐。
 *
 * 与案件侧的**刻意不对称**（IQ-5「事项是台账，案件是战场」，不是疏漏）：
 *   · 无预设节点       —— 节点只能手动加，见 `addRiskNode`
 *   · 节点只有时间点   —— 不支持时间段，建节点时按类型拒
 *   · 经办人可空       —— 见 `updateRiskMatter` 对 ownerId 的处理
 * 任何"顺手统一一下"的改动都是推翻已验收裁定。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 事项详情（T1 的主读取）。
 *
 * 读者是详情页，所以一次把页面要的块都取齐：基本事实、节点、参与人、当事人、
 * 处置记录、活动流、可用状态、已转案件反查。分多次请求会让页面逐块蹦出来。
 *
 * ⚠ `partyCount` 的教训（见 `listRiskMatters`）：`sql` 模板里的列会被渲染成**裸列名**，
 * 所以这里一律用 drizzle 的 select/where 构造，不手写列引用。
 */
export async function getRiskMatter(actor: Actor, id: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      id: riskMatter.id,
      code: riskMatter.code,
      name: riskMatter.name,
      type: riskMatter.type,
      level: riskMatter.level,
      source: riskMatter.source,
      description: riskMatter.description,
      status: riskMatter.status,
      ownerId: riskMatter.ownerId,
      // 创建人进 DTO：关注名单的管理权（§6 经办人/L1/创建人）要在界面上判
      // "右段菜单里给不给『添加关注人』"，只给布尔位会把规则抄第二份到前端
      creatorId: riskMatter.createdBy,
      discoverDate: riskMatter.discoverDate,
      isArchived: riskMatter.isArchived,
      archivedAt: riskMatter.archivedAt,
      conversionStatus: riskMatter.conversionStatus,
      convertedCaseCount: riskMatter.convertedCaseCount,
      convertedAt: riskMatter.convertedAt,
      lastProgressAt: riskMatter.lastProgressAt,
      createdAt: riskMatter.createdAt,
      updatedAt: riskMatter.updatedAt,
    })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(id))))
    .limit(1);
  // 不可见一律 404（元规则 3），不返 403 —— 403 会替调用方确认"这条存在"
  if (!row) return null;

  const [
    nodes,
    progress,
    staff,
    parties,
    comments,
    activity,
    statuses,
    converted,
    ownerRow,
    nodeTypes,
  ] = await Promise.all([
    db
      .select({
        id: riskMatterNode.id,
        nodeTypeId: riskMatterNode.nodeTypeId,
        name: riskMatterNode.name,
        timeType: riskMatterNode.timeType,
        startTime: riskMatterNode.startTime,
        endTime: riskMatterNode.endTime,
        isTimeConfirmed: riskMatterNode.isTimeConfirmed,
        deadlineTime: riskMatterNode.deadlineTime,
        status: riskMatterNode.status,
        sourceKind: riskMatterNode.sourceKind,
        sortOrder: riskMatterNode.sortOrder,
        remark: riskMatterNode.remark,
        ownerId: riskMatterNode.ownerId,
        cancelReason: riskMatterNode.cancelReason,
        completedAt: riskMatterNode.completedAt,
      })
      .from(riskMatterNode)
      .where(and(eq(riskMatterNode.hostId, BigInt(id)), sql`NOT ${riskMatterNode.isDeleted}`))
      .orderBy(asc(riskMatterNode.sortOrder), asc(riskMatterNode.id)),
    // 事项进展（迁移 0021）：与案件侧同一个读法，最新发生日在上。
    // 评论不再是"进展的唯一载体"——它退回对话（用户 2026-10-23 的口径）。
    db
      .select({
        id: riskMatterProgress.id,
        progressType: riskMatterProgress.progressType,
        content: riskMatterProgress.content,
        nextPlan: riskMatterProgress.nextPlan,
        progressDate: riskMatterProgress.progressDate,
        nodeId: riskMatterProgress.nodeId,
        createdAt: riskMatterProgress.createdAt,
        author: sql<string>`(select u.display_name from mn_app_user u where u.id = ${riskMatterProgress.authorId})`,
      })
      .from(riskMatterProgress)
      .where(
        and(eq(riskMatterProgress.hostId, BigInt(id)), sql`NOT ${riskMatterProgress.isDeleted}`),
      )
      .orderBy(desc(riskMatterProgress.progressDate)),
    db
      .select({
        id: riskMatterStaff.id,
        userId: riskMatterStaff.userId,
        staffRole: riskMatterStaff.staffRole,
        name: appUser.displayName,
      })
      .from(riskMatterStaff)
      .innerJoin(appUser, eq(appUser.id, riskMatterStaff.userId))
      .where(eq(riskMatterStaff.hostId, BigInt(id))),
    listRiskParties(actor, id),
    // 处置记录：COMMENT_CREATED / COMMENT_UPDATED 之外的东西是状态与节点变更，
    // 它们进活动流不进这里。评论按"最新在最上"给（IQ-17）。
    db
      .select({
        id: comment.id,
        body: comment.body,
        parentId: comment.parentId,
        isEdited: comment.isEdited,
        authorId: comment.authorId,
        authorName: appUser.displayName,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        /** @提及的 user id（MATT-68 / T4b2 的读取侧）；出 DTO 前换成 `parts`，见下 */
        mentionIds: comment.mentionIds,
      })
      .from(comment)
      .innerJoin(appUser, eq(appUser.id, comment.authorId))
      .where(
        and(
          eq(comment.targetType, "risk_matter"),
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
        payload: activityLog.payload,
        operatorId: activityLog.operatorId,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(eq(activityLog.riskMatterId, BigInt(id)))
      .orderBy(desc(activityLog.createdAt))
      .limit(100),
    // 状态配置按**宿主**取。事项与案件各有一套同名 code，混用会让流转判定指向另一端
    db
      .select({
        code: statusConfig.code,
        name: statusConfig.name,
        semantics: statusConfig.semantics,
        nextStatusCodes: statusConfig.nextStatusCodes,
        sortOrder: statusConfig.sortOrder,
      })
      .from(statusConfig)
      .where(eq(statusConfig.hostType, "risk_matter"))
      .orderBy(asc(statusConfig.sortOrder)),
    // 已转案件反查：详情页的「已转案件」列表靠它，不走事项列表
    db
      .select({
        id: matter.id,
        internalCode: matter.internalCode,
        caseNo: matter.caseNo,
        name: matter.name,
        status: matter.status,
        isArchived: matter.isArchived,
      })
      .from(riskMatterCase)
      .innerJoin(matter, eq(matter.id, riskMatterCase.matterId))
      .where(eq(riskMatterCase.riskMatterId, BigInt(id)))
      .orderBy(asc(matter.id)),
    // 经办人可能为空（IQ-5 事项侧可空），空值不查库——`eq` 不收 null
    row.ownerId === null
      ? Promise.resolve([] as { name: string }[])
      : db
          .select({ name: appUser.displayName })
          .from(appUser)
          .where(eq(appUser.id, row.ownerId))
          .limit(1),
    // 可选节点类型：**只有 time_type='point' 的**（IQ-5 事项节点只支持时间点）。
    // 过滤放服务端而不是让前端记一条"这个别显示"——那条规则迟早会漏。
    // addRiskNode 还会再拒一次：不给选项不等于拦得住手写请求。
    db
      .select({
        id: nodeTypeConfig.id,
        code: nodeTypeConfig.code,
        name: nodeTypeConfig.name,
      })
      .from(nodeTypeConfig)
      .where(and(eq(nodeTypeConfig.hostType, "risk_matter"), eq(nodeTypeConfig.timeType, "point")))
      .orderBy(asc(nodeTypeConfig.sortOrder)),
  ]);

  /**
   * 评论的 @提及分段（MATT-68 / T4b2），与案件侧同一实现：
   * 按 `mention_ids` 取名册状态 → 切成文本/提及段。
   * 字段逐项列出而不是 `{...c}`：`mentionIds` 是 `bigint[]`（过不了 JSON 序列化），
   * 而界面要的是渲染件而不是一串 user id。
   */
  const commentParts = await mentionPartsOf(db, comments);

  /** 评论附件（§7.1 / §1.7）：与案件侧同一实现 */
  const commentAttachments = await attachmentsOfComments(
    db,
    comments.map((c) => c.id),
  );

  return {
    ...row,
    id: String(row.id),
    ownerId: row.ownerId === null ? null : String(row.ownerId),
    creatorId: row.creatorId === null ? null : String(row.creatorId),
    ownerName: ownerRow[0]?.name ?? null,
    nodeTypes: nodeTypes.map((t) => ({ id: String(t.id), code: t.code, name: t.name })),
    nodes: nodes.map((n) => ({
      ...n,
      id: String(n.id),
      // 手工节点没有类型（0020 起可空）——不能 `String(null)` 成 "null"
      nodeTypeId: n.nodeTypeId === null ? null : String(n.nodeTypeId),
    })),
    progress: progress.map((p) => ({
      ...p,
      id: String(p.id),
      nodeId: p.nodeId === null ? null : String(p.nodeId),
    })),
    staff: staff.map((s) => ({ ...s, id: String(s.id), userId: String(s.userId) })),
    parties: parties ?? [],
    comments: comments.map((c) => ({
      id: String(c.id),
      body: c.body,
      parentId: c.parentId === null ? null : String(c.parentId),
      isEdited: c.isEdited,
      authorId: String(c.authorId),
      authorName: c.authorName,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      parts: commentParts.get(String(c.id)) ?? [],
      attachments: commentAttachments.get(String(c.id)) ?? [],
    })),
    activity: activity.map((a) => ({ ...a, id: String(a.id), operatorId: String(a.operatorId) })),
    statuses,
    convertedCases: converted.map((c) => ({ ...c, id: String(c.id) })),
    /** 我是否收藏了这条（MATT-63 / F1-13）；理由见案件侧同名字段 */
    favorited: await isFavorited(actor, "risk_matter", id),
  };
}

/**
 * 改事项主表字段（含**变更处理人**）。
 *
 * 「变更处理人」是一次**普通字段编辑**（GLOSSARY 明写）：不新增状态、不新造审计动作，
 * 沿用 `OWNER_CHANGED`。所以它在这里和改标题/金额走同一条路径，没有专属入口。
 *
 * ⚠ 经办人可空是事项侧的刻意设计（IQ-5），所以 `ownerId: null` 是**合法输入**，
 * 不是"没填"——它表示把事项退回未指派，让持 L1 的人去 `变更处理人`。
 *
 * **冻结（2026-10-14 裁定）**：事项转过案件之后业务字段不可再改，**含变更处理人**——
 * 判据是 `isRiskFrozen`，全仓唯一的一处（见它的注释）。
 * 排在归档判定之前：一条既已转案件又已归档的事项，答复要给出"为什么"。
 * 归档只读（§5.2）说的是"归档之后不能改"，冻结说的是"转过之后这件事不再由事项侧承载"，
 * 两者指向的下一步不同（前者是找持特权的人撤销归档，后者是去案件上做）。
 */
export async function updateRiskMatter(
  actor: Actor,
  id: string,
  patch: {
    name?: string;
    level?: string;
    description?: string;
    ownerId?: string | null;
  },
): Promise<
  | { ok: true }
  | {
      ok: false;
      why: "not_found" | "forbidden" | "empty" | "owner_not_selectable" | "frozen";
    }
> {
  const db = await getDb();
  const [cur] = await db
    .select({
      name: riskMatter.name,
      level: riskMatter.level,
      description: riskMatter.description,
      ownerId: riskMatter.ownerId,
      isArchived: riskMatter.isArchived,
      conversionStatus: riskMatter.conversionStatus,
    })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(id))))
    .limit(1);
  if (!cur) return { ok: false, why: "not_found" };
  if (isRiskFrozen(cur.conversionStatus)) return { ok: false, why: "frozen" };
  // 归档是只读终态（§5.2）：要改先撤销归档，而撤销需要 can_unarchive
  if (cur.isArchived) return { ok: false, why: "forbidden" };
  const changingOwner = patch.ownerId !== undefined;
  // 经办人**为空**时谁都能改（只要看得见）——这正是「变更处理人」存在的场景：
  // 未指派的事项得有人能接手。空值走不到 ownsAttribution（它不收 null），所以先兜。
  const ownerAllows = cur.ownerId === null || ownsAttribution(actor, cur.ownerId);
  if (!ownerAllows) return { ok: false, why: "forbidden" };

  const nextOwner = changingOwner
    ? patch.ownerId === null
      ? null
      : BigInt(patch.ownerId!)
    : cur.ownerId;

  /**
   * 变更处理人时，被指派的人**必须落在我的可见用户集内**（权限草案 §6 被加者条件第三条）。
   *
   * 这条校验在**写路径**上，不在界面上：只把下拉收窄是装饰——任何一个看得见这条事项的
   * 登录用户，直接 PATCH 一个任意 `ownerId` 就能绕过，那等于 Q1 收窄根本没生效。
   *
   * IQ-14 的创建期例外（放开到全体 active 用户）**不适用在这里**：那是登记表单的规则，
   * 「创建之后」的变更严格走 §4.1。
   *
   * 置空（退回未指派）不走这条：空值不构成"把人加进案卷"，且这条路径本就是
   * `ownerAllows` 放开的场景——未指派的事项得有人能接手。
   *
   * ⚠ "被指派者必须在册可用"（停用/待开通/软删）**不需要在这里再查一遍**：
   * `listSelectableUsers` 的 WHERE 里已经有那三个条件（见它的文件头注），
   * 所以能出现在 `selectable` 里的人在册状态必然合格。这里只多判"在不在我的可见集内"。
   * 两处都写一遍不会更安全，只会让"哪一处才是真的"变成需要读两遍代码才能回答的问题。
   */
  if (changingOwner && nextOwner !== null) {
    const selectable = await listSelectableUsers(actor, "risk_matter", id);
    // selectable 为 null 表示这条事项你看不见 → 上面 scopedWhere 已拦过，这里是兜底
    if (selectable === null) return { ok: false, why: "not_found" };
    if (!selectable.some((u) => u.id === nextOwner.toString())) {
      return { ok: false, why: "owner_not_selectable" };
    }
  }

  const diffs: Record<string, { from: unknown; to: unknown }> = {};
  const set: Record<string, unknown> = {};
  // 正文类字段（描述）：改动要落库、要触发 RISK_UPDATED，但**审计不落正文**
  // （ADR-0002 + logging-guidelines 既有禁令）。所以这些字段只记「改过」，不记 from/to 的值。
  // 原先与描述并列的「处置措施」已随迁移 0017 撤下，所以这一组只剩描述。
  const BODY_FIELDS = new Set(["description"]);
  const bodyChanged: string[] = [];
  const consider = (key: "name" | "level" | "description") => {
    const v = patch[key];
    if (v === undefined) return;
    if (v === cur[key]) return;
    set[key] = v;
    if (BODY_FIELDS.has(key)) bodyChanged.push(key);
    else diffs[key] = { from: cur[key], to: v };
  };
  consider("name");
  consider("level");
  consider("description");
  if (changingOwner && nextOwner !== cur.ownerId) {
    diffs["ownerId"] = {
      from: cur.ownerId === null ? null : String(cur.ownerId),
      to: patch.ownerId ?? null,
    };
    set["ownerId"] = nextOwner;
  }
  // 什么都没变就别说"改成功了"——前端会据此弹一个空提示
  if (Object.keys(set).length === 0) return { ok: false, why: "empty" };

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(riskMatter)
      .set({ ...set, updatedBy: BigInt(actor.userId), updatedAt: now })
      .where(eq(riskMatter.id, BigInt(id)));
    // 变更处理人沿用 OWNER_CHANGED，**不新造动作**（GLOSSARY「变更处理人」条）
    if (diffs["ownerId"]) {
      await logActivity(tx, actor, {
        riskMatterId: BigInt(id),
        targetType: "risk_matter",
        targetId: BigInt(id),
        action: "OWNER_CHANGED",
        diffs: { ownerId: diffs["ownerId"]! },
      });
      // 经办人换了，事项人员表要跟着换，否则列表按人员筛会漏
      if (nextOwner !== null) {
        const [existing] = await tx
          .select({ id: riskMatterStaff.id })
          .from(riskMatterStaff)
          .where(
            and(
              eq(riskMatterStaff.hostId, BigInt(id)),
              eq(riskMatterStaff.userId, nextOwner),
              eq(riskMatterStaff.staffRole, "owner"),
            ),
          )
          .limit(1);
        if (!existing) {
          await tx.insert(riskMatterStaff).values({
            id: BigInt(nextId()),
            hostId: BigInt(id),
            userId: nextOwner,
            staffRole: "owner",
          });
        }
      }
    }
    const nonOwnerFields = Object.keys(diffs).filter((k) => k !== "ownerId");
    if (nonOwnerFields.length > 0 || bodyChanged.length > 0) {
      // 正文类字段只进 `bodyFields`（改了哪些），值一律不落审计表——
      // 审计表不能变成明文书的存放处（logging-guidelines §SENSITIVE 同一条理由）。
      await logActivity(tx, actor, {
        riskMatterId: BigInt(id),
        targetType: "risk_matter",
        targetId: BigInt(id),
        action: "RISK_UPDATED",
        diffs: Object.fromEntries(nonOwnerFields.map((k) => [k, diffs[k]!])),
        payload: bodyChanged.length ? { bodyFields: bodyChanged } : undefined,
      });
    }
  });
  return { ok: true };
}

/**
 * 写一条事项进展（迁移 0021）。
 *
 * 与案件侧 `addProgress` 逐条同构：先按范围谓词判可见（不可见连写都不给，404），
 * 再在**同一事务**里插进展、落审计、刷新宿主 `last_progress_at`。
 *
 * ⚠ 事项的 `last_progress_at` **不接**规则 4（IQ-9 / Q37 只扫案件）。刷新它只是让
 * 详情页与排序有同一个读数；哪天要把事项纳入提醒，列已经在了，不需要再补一次迁移。
 *
 * 冻结门：事项转过案件之后节点/状态都不可再推，进展也一样 —— 否则会出现
 * "事项已经冻结、却还在往里写新事实"的形态。判据复用 `isRiskFrozen`。
 */
export async function addRiskProgress(
  actor: Actor,
  riskId: string,
  input: ProgressInput,
): Promise<{ ok: true; id: string } | { ok: false; why: "not_found" | "forbidden" | "frozen" }> {
  const db = await getDb();
  const [visible] = await db
    .select({
      id: riskMatter.id,
      isArchived: riskMatter.isArchived,
      conversionStatus: riskMatter.conversionStatus,
    })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!visible) return { ok: false, why: "not_found" };
  // 冻结门排在归档之前：已转案件是这条记录的属性，与"你是不是经办人"无关
  if (isRiskFrozen(visible.conversionStatus)) return { ok: false, why: "frozen" };
  if (visible.isArchived) return { ok: false, why: "forbidden" };

  const id = BigInt(nextId());
  await db.transaction(async (tx) => {
    await tx.insert(riskMatterProgress).values({
      id,
      hostId: BigInt(riskId),
      nodeId: input.nodeId ? BigInt(input.nodeId) : null,
      progressType: input.progressType,
      content: input.content,
      progressDate: businessDateKey(new Date(`${input.progressDate}T00:00:00+08:00`)),
      nextPlan: input.nextPlan ? input.nextPlan : null,
      authorId: BigInt(actor.userId),
      createdBy: BigInt(actor.userId),
      updatedBy: BigInt(actor.userId),
    });
    await logActivity(tx, actor, {
      riskMatterId: BigInt(riskId),
      action: "PROGRESS_CREATED",
      targetType: "risk_matter_progress",
      targetId: id,
    });
    await tx
      .update(riskMatter)
      .set({
        lastProgressAt: new Date().toISOString(),
        updatedBy: BigInt(actor.userId),
      })
      .where(eq(riskMatter.id, BigInt(riskId)));
  });
  return { ok: true, id: String(id) };
}

/** 处置记录 = 评论对话（2026-10-23 起）；结构化办理记录走进展页签。 */
export async function addRiskComment(
  actor: Actor,
  riskId: string,
  body: string,
  parentId?: string | null,
  /** §7.1：已上传（草稿态）的附件 id；空/不传 = 没有附件 */
  attachmentIds: readonly string[] = [],
): Promise<{ id: string } | null> {
  const db = await getDb();
  const [visible] = await db
    .select({ id: riskMatter.id })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!visible) return null;
  const id = BigInt(nextId());
  // @提及在事务外解析（候选人是全体在职账号，与这次写入无一致性要求）。与案件侧同一口径
  const mentionIds = await resolveMentionIds(db, body);
  // 附件草稿也在事务外核（要读对象存储）；事务里只剩 `comment_id` 的赋值
  const drafts = await verifyDraftAttachments(actor, "risk_matter", riskId, attachmentIds);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(comment).values({
        id,
        targetType: "risk_matter",
        targetId: BigInt(riskId),
        body,
        parentId: parentId ? BigInt(parentId) : null,
        // 列注「通知链路将来靠它展开」的落点（基线 0000 就有这一列）
        mentionIds: mentionIds.map(BigInt),
        authorId: BigInt(actor.userId),
        createdBy: BigInt(actor.userId),
        updatedBy: BigInt(actor.userId),
      });
      await attachToComment(tx, actor, {
        host: "risk_matter",
        hostId: riskId,
        commentId: id,
        rows: drafts,
      });
      await logActivity(tx, actor, {
        riskMatterId: BigInt(riskId),
        targetType: "risk_matter",
        targetId: BigInt(riskId),
        action: "COMMENT_CREATED",
      });
      // 新评论的通知意图：**只写 outbox**（预置规则 8 的触发是 `comment_added` 领域事件）。
      // 归档事项返回 false（不发通知），但评论照写 —— 基线 1.7 明写"归档后仍可新增评论"。
      await enqueueCommentIntent(actor, tx, {
        host: "risk_matter",
        hostId: BigInt(riskId),
        commentId: id,
        quoted: quoteOf(body),
        mentionIds,
      });
    });
  } catch (e) {
    // 评论没落库 ⇒ 刚传上去的附件不该留下（草稿行 + 对象一起清）。补偿不抛。
    await discardDrafts(attachmentIds);
    throw e;
  }
  return { id: String(id) };
}

/**
 * 编辑处置记录。只允许作者本人改（`authorId` 必须是自己）。
 *
 * 编辑后置 `is_edited`，前端显示「（已编辑）」标记，并写 `COMMENT_UPDATED` 审计。
 * 允许"改了不留痕"会让处置记录失去作为证据的价值。
 */
export async function editRiskComment(
  actor: Actor,
  riskId: string,
  commentId: string,
  body: string,
): Promise<{ ok: true } | { ok: false; why: "not_found" | "forbidden" }> {
  const db = await getDb();
  const [vis] = await db
    .select({ id: riskMatter.id })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!vis) return { ok: false, why: "not_found" };
  // 三条件一起命中：防串目标（同一 id 在别的事项下的评论）
  const [row] = await db
    .select({ id: comment.id, authorId: comment.authorId })
    .from(comment)
    .where(
      and(
        eq(comment.id, BigInt(commentId)),
        eq(comment.targetType, "risk_matter"),
        eq(comment.targetId, BigInt(riskId)),
        sql`NOT ${comment.isDeleted}`,
      ),
    )
    .limit(1);
  if (!row) return { ok: false, why: "not_found" };
  if (row.authorId !== BigInt(actor.userId)) return { ok: false, why: "forbidden" };

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(comment)
      .set({ body, isEdited: true, updatedBy: BigInt(actor.userId), updatedAt: now })
      .where(eq(comment.id, row.id));
    await logActivity(tx, actor, {
      riskMatterId: BigInt(riskId),
      targetType: "risk_matter",
      targetId: BigInt(riskId),
      action: "COMMENT_UPDATED",
    });
  });
  return { ok: true };
}

/**
 * 手动新增事项节点（IQ-5：事项侧**无预设节点**，只能手动加）。
 *
 * 2026-10-23 起与案件侧同形：字段只有名称、描述（入 `remark`）、时间；不再选节点类型
 * （类型是模板的概念，手工节点没有模板可依），新节点从「进行中」起算。
 *
 * **冻结（MATT-80 / ADR 0005）**：事项转过案件之后**节点也不能再加** —— 判据是
 * `isRiskFrozen`。事项节点常是硬期限（举证期、开庭日、答复期），转案件之后期限的
 * 实际推进已在案件侧，此刻还能在台账上加一条，**没人会察觉那条期限是后补的**。
 * 排在归档判定之前：冻结是这条记录的属性，与"你是不是经办人"无关。
 */
export async function addRiskNode(
  actor: Actor,
  riskId: string,
  input: { name: string; description?: string; startTime: string },
): Promise<{ ok: true; id: string } | { ok: false; why: "not_found" | "forbidden" | "frozen" }> {
  const db = await getDb();
  const [vis] = await db
    .select({
      id: riskMatter.id,
      ownerId: riskMatter.ownerId,
      isArchived: riskMatter.isArchived,
      conversionStatus: riskMatter.conversionStatus,
    })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!vis) return { ok: false, why: "not_found" };
  if (isRiskFrozen(vis.conversionStatus)) return { ok: false, why: "frozen" };
  if (vis.isArchived) return { ok: false, why: "forbidden" };

  const startTime = new Date(input.startTime).toISOString();
  const [last] = await db
    .select({ max: sql<number | null>`max(${riskMatterNode.sortOrder})` })
    .from(riskMatterNode)
    .where(eq(riskMatterNode.hostId, BigInt(riskId)));
  const id = BigInt(nextId());

  await db.transaction(async (tx) => {
    await tx.insert(riskMatterNode).values({
      id,
      hostId: BigInt(riskId),
      nodeTypeId: null,
      name: input.name.trim(),
      timeType: "point",
      startTime,
      endTime: null,
      isTimeConfirmed: true,
      status: "in_progress",
      // 手动新增 —— 系统生成才算 preset，这里是人的动作
      sourceKind: "manual",
      ownerId: vis.ownerId,
      remindDays: initialRemindDays(startTime),
      sortOrder: Number(last?.max ?? -1) + 1,
      remark: input.description?.trim() ? input.description.trim() : null,
      createdBy: BigInt(actor.userId),
      updatedBy: BigInt(actor.userId),
    });
    await logActivity(tx, actor, {
      riskMatterId: BigInt(riskId),
      targetType: "risk_matter_node",
      targetId: id,
      action: "NODE_CREATED",
      diffs: { node: { from: null, to: input.name.trim() } },
    });
  });
  return { ok: true, id: String(id) };
}

/** 事项节点写操作的统一返回 */
export type RiskNodeWriteOutcome =
  { ok: true; id: string } | { ok: false; why: "not_found" | "forbidden" | "frozen" };

/** 编辑事项节点：名称 / 描述 / 时间，随时可改（归档与冻结除外） */
export async function updateRiskNode(
  actor: Actor,
  riskId: string,
  nodeId: string,
  input: { name: string; description?: string; startTime: string },
): Promise<RiskNodeWriteOutcome> {
  const db = await getDb();
  const [node] = await db
    .select({
      id: riskMatterNode.id,
      name: riskMatterNode.name,
      startTime: riskMatterNode.startTime,
      nodeOwnerId: riskMatterNode.ownerId,
      hostOwnerId: riskMatter.ownerId,
      hostCreatorId: riskMatter.createdBy,
      isArchived: riskMatter.isArchived,
      conversionStatus: riskMatter.conversionStatus,
    })
    .from(riskMatterNode)
    .innerJoin(riskMatter, eq(riskMatter.id, riskMatterNode.hostId))
    .where(
      and(
        eq(riskMatterNode.hostId, BigInt(riskId)),
        eq(riskMatterNode.id, BigInt(nodeId)),
        scopedWhere("risk_matter", actor),
        sql`NOT ${riskMatterNode.isDeleted}`,
      ),
    )
    .limit(1);
  if (!node) return { ok: false, why: "not_found" };
  if (isRiskFrozen(node.conversionStatus)) return { ok: false, why: "frozen" };
  if (node.isArchived) return { ok: false, why: "forbidden" };
  const allowed = await canManageNode(db, actor, "risk_matter", BigInt(riskId), {
    nodeOwnerId: node.nodeOwnerId,
    hostOwnerId: node.hostOwnerId,
    hostCreatorId: node.hostCreatorId,
  });
  if (!allowed) return { ok: false, why: "forbidden" };

  const startTime = new Date(input.startTime).toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(riskMatterNode)
      .set({
        name: input.name.trim(),
        remark: input.description?.trim() ? input.description.trim() : null,
        timeType: "point",
        startTime,
        endTime: null,
        isTimeConfirmed: true,
        remindDays: initialRemindDays(startTime),
        updatedBy: BigInt(actor.userId),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(riskMatterNode.id, BigInt(nodeId)));
    await logActivity(tx, actor, {
      riskMatterId: BigInt(riskId),
      targetType: "risk_matter_node",
      targetId: node.id,
      action: "NODE_UPDATED",
      diffs: {
        name: { from: node.name, to: input.name.trim() },
        start_time: { from: node.startTime, to: startTime },
      },
    });
  });
  return { ok: true, id: String(nodeId) };
}

/** 删除事项节点（软删 + NODE_DELETED 审计） */
export async function deleteRiskNode(
  actor: Actor,
  riskId: string,
  nodeId: string,
): Promise<RiskNodeWriteOutcome> {
  const db = await getDb();
  const [node] = await db
    .select({
      id: riskMatterNode.id,
      name: riskMatterNode.name,
      status: riskMatterNode.status,
      nodeOwnerId: riskMatterNode.ownerId,
      hostOwnerId: riskMatter.ownerId,
      hostCreatorId: riskMatter.createdBy,
      isArchived: riskMatter.isArchived,
      conversionStatus: riskMatter.conversionStatus,
    })
    .from(riskMatterNode)
    .innerJoin(riskMatter, eq(riskMatter.id, riskMatterNode.hostId))
    .where(
      and(
        eq(riskMatterNode.hostId, BigInt(riskId)),
        eq(riskMatterNode.id, BigInt(nodeId)),
        scopedWhere("risk_matter", actor),
        sql`NOT ${riskMatterNode.isDeleted}`,
      ),
    )
    .limit(1);
  if (!node) return { ok: false, why: "not_found" };
  if (isRiskFrozen(node.conversionStatus)) return { ok: false, why: "frozen" };
  if (node.isArchived) return { ok: false, why: "forbidden" };
  const allowed = await canManageNode(db, actor, "risk_matter", BigInt(riskId), {
    nodeOwnerId: node.nodeOwnerId,
    hostOwnerId: node.hostOwnerId,
    hostCreatorId: node.hostCreatorId,
  });
  if (!allowed) return { ok: false, why: "forbidden" };

  await db.transaction(async (tx) => {
    await tx
      .update(riskMatterNode)
      .set({
        isDeleted: true,
        deletedAt: new Date().toISOString(),
        updatedBy: BigInt(actor.userId),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(riskMatterNode.id, BigInt(nodeId)));
    await logActivity(tx, actor, {
      riskMatterId: BigInt(riskId),
      targetType: "risk_matter_node",
      targetId: node.id,
      action: "NODE_DELETED",
      payload: { name: node.name, status: node.status },
    });
  });
  return { ok: true, id: String(nodeId) };
}

/**
 * 事项节点的状态（三态，2026-10-23）。
 *
 * 与案件侧同一套：三态之间自由跳、取消必填原因、状态没变 422；
 * **冻结（MATT-80 / ADR 0005）** 与归档仍挡在最前面（记录自身属性，先于归属判定）。
 * 完成是进度事实，能看见就能标；取消会抹掉期限，限 `canManageNode`。
 */
export async function setRiskNodeStatus(
  actor: Actor,
  riskId: string,
  nodeId: string,
  status: string,
  cancelReason?: string | null,
): Promise<
  | { ok: true }
  | { ok: false; why: "not_found" | "forbidden" | "reason_required" | "unchanged" | "frozen" }
> {
  const db = await getDb();
  const [node] = await db
    .select({
      id: riskMatterNode.id,
      name: riskMatterNode.name,
      status: riskMatterNode.status,
      nodeOwnerId: riskMatterNode.ownerId,
      hostOwnerId: riskMatter.ownerId,
      hostCreatorId: riskMatter.createdBy,
      isArchived: riskMatter.isArchived,
      conversionStatus: riskMatter.conversionStatus,
    })
    .from(riskMatterNode)
    .innerJoin(riskMatter, eq(riskMatter.id, riskMatterNode.hostId))
    .where(
      and(
        // 两个 id 都要对得上：只按 nodeId 判会让 `/…/999/nodes/<真 id>` 也成功
        eq(riskMatterNode.hostId, BigInt(riskId)),
        eq(riskMatterNode.id, BigInt(nodeId)),
        scopedWhere("risk_matter", actor),
        sql`NOT ${riskMatterNode.isDeleted}`,
      ),
    )
    .limit(1);
  if (!node) return { ok: false, why: "not_found" };
  if (isRiskFrozen(node.conversionStatus)) return { ok: false, why: "frozen" };
  if (node.isArchived) return { ok: false, why: "forbidden" };
  if (status === node.status) return { ok: false, why: "unchanged" };
  if (status === "cancelled" && !cancelReason?.trim()) return { ok: false, why: "reason_required" };
  if (status === "cancelled") {
    const allowed = await canManageNode(db, actor, "risk_matter", BigInt(riskId), {
      nodeOwnerId: node.nodeOwnerId,
      hostOwnerId: node.hostOwnerId,
      hostCreatorId: node.hostCreatorId,
    });
    if (!allowed) return { ok: false, why: "forbidden" };
  }

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(riskMatterNode)
      .set({
        status,
        cancelReason: status === "cancelled" ? cancelReason : null,
        completedAt: status === "completed" ? now : null,
        completedBy: status === "completed" ? BigInt(actor.userId) : null,
        updatedBy: BigInt(actor.userId),
        updatedAt: now,
      })
      .where(eq(riskMatterNode.id, node.id));
    // 取消必须带原因 —— 这是 `NODE_CANCELLED` 在枚举表 §3.2 里的必填口径
    await logActivity(tx, actor, {
      riskMatterId: BigInt(riskId),
      targetType: "risk_matter_node",
      targetId: node.id,
      action:
        status === "completed"
          ? "NODE_COMPLETED"
          : status === "cancelled"
            ? "NODE_CANCELLED"
            : "NODE_UPDATED",
      reason: status === "cancelled" ? (cancelReason ?? null) : null,
      diffs: { nodeStatus: { from: node.status, to: status } },
    });
  });
  return { ok: true };
}

/**
 * 软删事项（F2-5）。**没有回收站界面**（T1 验收标准原文）——
 * 库内可恢复、普通用户不可见已删行，恢复留给有特权的人。
 *
 * **冻结（MATT-82 / ADR-0005）**：事项转过案件之后不可软删 —— 判据是 `isRiskFrozen`。
 * 事项是案件的**上游台账**：`mn_risk_matter_case` 上的关联与案件详情页的「来源事项卡」
 * 都以它为源。正被 N 个案件引用时把事项软删掉，那些卡片就**断源** —— 卡片还在、
 * 反查却查不到台账，而删的那一侧没有任何提示说"有案件在用"。
 * 排在归属判定之前：冻结是这条记录的属性，与"你是不是经办人"无关。
 */
export async function deleteRiskMatter(
  actor: Actor,
  id: string,
): Promise<{ ok: true } | { ok: false; why: "not_found" | "forbidden" | "frozen" }> {
  const db = await getDb();
  const [cur] = await db
    .select({ ownerId: riskMatter.ownerId, conversionStatus: riskMatter.conversionStatus })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(id))))
    .limit(1);
  if (!cur) return { ok: false, why: "not_found" };
  if (isRiskFrozen(cur.conversionStatus)) return { ok: false, why: "frozen" };
  if (cur.ownerId !== null && !ownsAttribution(actor, cur.ownerId))
    return { ok: false, why: "forbidden" };

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(riskMatter)
      .set({
        isDeleted: true,
        deletedAt: now,
        updatedBy: BigInt(actor.userId),
        updatedAt: now,
      })
      .where(eq(riskMatter.id, BigInt(id)));
    await logActivity(tx, actor, {
      riskMatterId: BigInt(id),
      targetType: "risk_matter",
      targetId: BigInt(id),
      action: "RISK_DELETED",
    });
  });
  return { ok: true };
}

/* ─────────────────────────── 关注组（MATT-56 / IQ-19 批注④ / ADR-0003） ─────────────────────────── */

/**
 * 关注人（`*_staff.staff_role='follower'`）的读写。
 *
 * ## 两道门，不是一道（ADR-0003 的原文结构）
 *
 * · **自我关注**（把**自己**加/摘出名单）：唯一的门是「操作者现在就能看见这条记录」。
 *   这道校验就是 `scopedWhere` 本身——看不见 → 查不到行 → 404。
 *   去掉它，拿到/枚举到事项 id 就能自取读写（follower 进 L2 可见性、可写节点与评论），
 *   等于放开权限草案 §6 的整节风控。**这道门槛不许拆。**
 * · **给别人加/摘**：门是 §6 的名单管理权——经办人 / L1（含 is_admin）/ **创建人**。
 *   协办与关注没有这条权利（他们看得见，但管不了名单）。
 *   且每个被加者还要过 §4.1 的可见用户集（复用 `listSelectableUsers`，与写处理人同一条路）。
 *
 * ## 归档态
 *
 * 归档是只读终态（§5.2）：名单**仍可读**（原型批注：只读不等于看不见谁在关注），
 * 但写一律拒——与评论、节点、字段编辑同一口径。
 *
 * ## `user_watch(follow)` 的连带删除（票面第 ⑥ 条）
 *
 * `mn_user_watch` 表**还不存在**（属 M5/M6，见 `collab.ts` 头注）。按本仓纪律
 * （审计 F4 的 `revoked_at`、MATT-53 的停用守卫都是这条），给不存在的表写删除代码
 * 就是死代码——所以这里不写，等 T4/M5 建表时在同批接上。摘 `follower` 行本身是真的。
 */

/** 取事项 + 判可见性；null = 看不见或不存在（→ 404） */
async function loadRiskForStaff(db: Awaited<ReturnType<typeof getDb>>, actor: Actor, id: string) {
  const [row] = await db
    .select({
      id: riskMatter.id,
      ownerId: riskMatter.ownerId,
      creatorId: riskMatter.createdBy,
      isArchived: riskMatter.isArchived,
    })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(id))))
    .limit(1);
  return row ?? null;
}

/**
 * §6 名单管理权：经办人 / L1 / is_admin / 创建人。
 *
 * ⚠ 2026-10-13：实现**已提取到 `scope/guards.ts`**（MATT-49 做案件侧时要用同一份）。
 * 这里不再留第二份——"谁能改名单"漂移了不会报错，只会让某个协办悄悄获得加人的能力。
 * 本文件仍从 guards 导入后使用，函数名与语义不变。
 */

/** 当前关注名单（详情页右段「n 人关注」与菜单的唯一数据源） */
export async function listRiskFollowers(actor: Actor, riskId: string) {
  const db = await getDb();
  const src = await loadRiskForStaff(db, actor, riskId);
  if (!src) return null;
  const rows = await db
    .select({
      id: riskMatterStaff.id,
      userId: riskMatterStaff.userId,
      name: appUser.displayName,
    })
    .from(riskMatterStaff)
    .innerJoin(appUser, eq(appUser.id, riskMatterStaff.userId))
    .where(
      and(eq(riskMatterStaff.hostId, BigInt(riskId)), eq(riskMatterStaff.staffRole, "follower")),
    )
    .orderBy(asc(appUser.displayName));
  return rows.map((r) => ({ id: String(r.id), userId: String(r.userId), name: r.name }));
}

export type AddFollowersResult =
  | { ok: true; added: number; skipped: string[] }
  | { ok: false; why: "not_found" | "archived" | "forbidden" };

/**
 * 加关注人。`userIds` 里**自己**与**他人**分开走两道门（见文件头注）：
 * 自己只看可见性；他人要名单管理权 + 可见用户集。
 * 一批里混着两种身份时按最严的来：没有管理权的人提交别人的 id ⇒ 整请求 403
 * （部分成功会让"我加了三个同事只有一个进去了"变成看不见的洞）。
 */
export async function addRiskFollowers(
  actor: Actor,
  riskId: string,
  userIds: readonly string[],
): Promise<AddFollowersResult> {
  const db = await getDb();
  const src = await loadRiskForStaff(db, actor, riskId);
  if (!src) return { ok: false, why: "not_found" };
  if (src.isArchived) return { ok: false, why: "archived" };

  const me = BigInt(actor.userId);
  const targets = userIds.map(BigInt);
  const hasOthers = targets.some((t) => t !== me);
  if (hasOthers && !canManageStaffList(actor, src)) return { ok: false, why: "forbidden" };

  // 被加者条件（§6 第三条）：只对"他人"查；自己永远在自己可见（能走到这里就说明看得见宿主）
  if (hasOthers) {
    const selectable = await listSelectableUsers(actor, "risk_matter", riskId);
    if (selectable === null) return { ok: false, why: "not_found" };
    const allowed = new Set(selectable.map((u) => u.id));
    const rejected = targets.filter((t) => t !== me && !allowed.has(String(t)));
    if (rejected.length > 0) return { ok: false, why: "forbidden" };
  }

  // 已在名单里的跳过而不是报错——眼睛连点两下、菜单里重复勾选都不该变成一次失败
  const existing = await db
    .select({ userId: riskMatterStaff.userId })
    .from(riskMatterStaff)
    .where(
      and(
        eq(riskMatterStaff.hostId, BigInt(riskId)),
        eq(riskMatterStaff.staffRole, "follower"),
        inArray(riskMatterStaff.userId, targets),
      ),
    );
  const have = new Set(existing.map((e) => String(e.userId)));
  const fresh = [...new Set(targets)].filter((t) => !have.has(String(t)));
  if (fresh.length === 0) return { ok: true, added: 0, skipped: targets.map(String) };

  const skipped = targets.filter((t) => have.has(t.toString())).map(String);
  await db.transaction(async (tx) => {
    await tx.insert(riskMatterStaff).values(
      fresh.map((userId) => ({
        id: BigInt(nextId()),
        hostId: BigInt(riskId),
        userId,
        staffRole: "follower",
      })),
    );
    // 关注同步（ADR-0003 / MATT-63）：事项侧的关注人**只有** `follower` 一个角色，
    // 所以这里无条件同步，不像案件侧要判 `staffRole`。
    await syncFollowWatch(tx, {
      host: "risk_matter",
      hostId: BigInt(riskId),
      userIds: fresh,
      action: "add",
    });
    await tx
      .update(riskMatter)
      .set({ updatedBy: BigInt(actor.userId), updatedAt: new Date().toISOString() })
      .where(eq(riskMatter.id, BigInt(riskId)));
    await logActivity(tx, actor, {
      riskMatterId: BigInt(riskId),
      targetType: "risk_matter",
      targetId: BigInt(riskId),
      action: "STAFF_CHANGED",
      payload: { add: "follower", userIds: fresh.map(String) },
    });
  });
  return { ok: true, added: fresh.length, skipped };
}

export type RemoveFollowerResult =
  { ok: true } | { ok: false; why: "not_found" | "archived" | "forbidden" };

/**
 * 摘一个关注人。**摘自己**永远允许（取消关注 = 眼睛的右半程，不受名单管理权约束，
 * ADR-0003 明写）；摘**别人**要管理权。
 */
export async function removeRiskFollower(
  actor: Actor,
  riskId: string,
  userId: string,
): Promise<RemoveFollowerResult> {
  const db = await getDb();
  const src = await loadRiskForStaff(db, actor, riskId);
  if (!src) return { ok: false, why: "not_found" };
  if (src.isArchived) return { ok: false, why: "archived" };

  const isSelf = BigInt(userId) === BigInt(actor.userId);
  if (!isSelf && !canManageStaffList(actor, src)) return { ok: false, why: "forbidden" };

  const [link] = await db
    .select({ id: riskMatterStaff.id })
    .from(riskMatterStaff)
    .where(
      and(
        eq(riskMatterStaff.hostId, BigInt(riskId)),
        eq(riskMatterStaff.userId, BigInt(userId)),
        eq(riskMatterStaff.staffRole, "follower"),
      ),
    )
    .limit(1);
  // 不在名单里 = 已经是目标态。给 404 会误导（事项明明在），幂等成功更诚实。
  if (!link) return { ok: true };

  await db.transaction(async (tx) => {
    await tx.delete(riskMatterStaff).where(eq(riskMatterStaff.id, link.id));
    // 关注同步（ADR-0003 / MATT-63）：移除关注人时**连带删** `user_watch(follow)` 行。
    await syncFollowWatch(tx, {
      host: "risk_matter",
      hostId: BigInt(riskId),
      userIds: [BigInt(userId)],
      action: "remove",
    });
    await tx
      .update(riskMatter)
      .set({ updatedBy: BigInt(actor.userId), updatedAt: new Date().toISOString() })
      .where(eq(riskMatter.id, BigInt(riskId)));
    await logActivity(tx, actor, {
      riskMatterId: BigInt(riskId),
      targetType: "risk_matter",
      targetId: BigInt(riskId),
      action: "STAFF_CHANGED",
      payload: { remove: "follower", userIds: [userId] },
    });
  });
  return { ok: true };
}

/* ─────────────── 批量低风险动作（MATT-45：改状态 / 归档 / 加标签） ─────────────── */

/**
 * 事项侧的三个批量动作，与案件侧（`services/matters.ts` 同名段落）**逐条同构**。
 *
 * 为什么要两份而不是抽一个泛型：两侧的宿主表、审计外键列（`matter_id` /
 * `risk_matter_id`）都不同，而共用一段"参数化的 SQL"会让每次改一侧都要重新证明另一侧
 * 没被改动。同构表对在本仓的既有姿态也是各写一份，所以这里保持同形，
 * 差异点只在注释里点出来。
 *
 * 状态机**不在此列**：2026-10-24 起两侧共用 `status-change.ts` 的
 * `changeHostStatus`（判定顺序、三档审计动作、通知意图都在那一处），
 * 所以下面循环体里没有第二份"改状态"的实现。
 *
 * 口径四条（不可见静默排除 / 跳过只算看得见但没做成 / 审计逐条用既有动作值 /
 * 上限 50 在 schema 层拦）与案件侧完全一致，逐字理由见 `shared/schema/batch.ts` 文件头。
 *
 * ⚠ 事项侧有一处**刻意的不对称**：`mn_risk_matter.owner_id` 可空（IQ-5），
 * 无主事项**谁都能推它的状态**——那条判定在 `host-status-policy.ts` 的事项策略里。
 * 批量改状态沿用同一个判定——这里不另判一次归属，否则"单条能推、批量推不动"就出现了。
 */

/** 批量预读要的那几列（与案件侧同名同形） */
type RiskBatchRow = {
  id: string;
  status: string;
  isArchived: boolean;
  tagIds: bigint[];
};

/**
 * 可见行收敛。**这张表不是安全边界**，真正的边界是 `changeHostStatus` 自己那次
 * `scopedWhere`（标签动作没有第二道，所以那里这次读就是边界——见 `revred-batch.mjs`
 * 的 `tag-scope-risk`）。
 */
async function loadRiskBatchRows(
  db: Awaited<ReturnType<typeof getDb>>,
  actor: Actor,
  ids: readonly string[],
): Promise<Map<string, RiskBatchRow>> {
  const uniq = [...new Set(ids)].map((i) => BigInt(i));
  const rows = await db
    .select({
      id: riskMatter.id,
      status: riskMatter.status,
      isArchived: riskMatter.isArchived,
      tagIds: riskMatter.tagIds,
    })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, inArray(riskMatter.id, uniq)));
  return new Map(rows.map((r) => [String(r.id), { ...r, id: String(r.id) }]));
}

function skipRiskRow(id: string, reason: BatchSkipReason): BatchSummary["skipped"][number] {
  return { id, reason };
}

/** 批量改事项状态。目标状态先按配置表验一次（理由同案件侧：参数错不该退化成空摘要）。 */
export async function batchChangeRiskStatus(
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
        eq(statusConfig.hostType, "risk_matter"),
        eq(statusConfig.code, to),
        eq(statusConfig.isEnabled, true),
      ),
    )
    .limit(1);
  if (!target) return { ok: false, why: "bad_status" };

  const byId = await loadRiskBatchRows(db, actor, ids);
  const skipped: BatchSummary["skipped"] = [];
  let applied = 0;

  for (const id of [...new Set(ids)]) {
    const row = byId.get(id);
    // 不可见 / 已软删 / 不存在：**什么都不说**
    if (!row) continue;

    // 撤销归档要 can_unarchive；判据与案件侧同（已归档 **且** 目标不是归档语义）
    if (row.isArchived && target.semantics !== "archived" && !actor.privileges.canUnarchive) {
      skipped.push(skipRiskRow(id, "privilege_required"));
      continue;
    }

    const r = await changeHostStatus({ host: "risk_matter", actor, id, to, reason });
    if (r.ok) {
      applied++;
      continue;
    }
    if (r.why === "not_found") continue; // 竞态：按同一条口径吞掉
    skipped.push(skipRiskRow(id, r.why));
  }
  return { ok: true, applied, skipped };
}

/** 批量归档事项。归档态 code 服务端查（配置驱动），原因由 schema 强制。 */
export async function batchArchiveRiskMatters(
  actor: Actor,
  ids: readonly string[],
  reason: string,
): Promise<{ ok: true } & BatchSummary> {
  const db = await getDb();
  const statuses = await hostStatusRows("risk_matter");
  const archived = statuses.find((s) => s.semantics === "archived");
  if (!archived) {
    throw new Error(
      "mn_status_config 缺少 host_type=risk_matter 且 semantics='archived' 的启用状态行",
    );
  }

  const byId = await loadRiskBatchRows(db, actor, ids);
  const skipped: BatchSummary["skipped"] = [];
  let applied = 0;

  for (const id of [...new Set(ids)]) {
    const row = byId.get(id);
    if (!row) continue;

    const r = await changeHostStatus({
      host: "risk_matter",
      actor,
      id,
      to: archived.code,
      reason,
    });
    if (r.ok) {
      applied++;
      continue;
    }
    if (r.why === "not_found") continue;
    skipped.push(skipRiskRow(id, r.why));
  }
  return { ok: true, applied, skipped };
}

/**
 * 批量加事项标签。**追加不替换**；归档行一律拒（§5.2）。
 *
 * 审计用 `RISK_UPDATED`（事项侧的字段编辑动作值）而不是新造 `TAG_CHANGED`——
 * 理由与案件侧逐字相同，见 `matters.ts` 里 `batchTagMatters` 的那段注释。
 *
 * **冻结不拦这里 —— 这是刻意豁免，不是漏加的门**（2026-10-16 裁定 / ADR-0005）。
 * 理由在函数体开头（写在体里，好让 `risks.spec.ts` 那条断言钉得住它）。
 */
export async function batchTagRiskMatters(
  actor: Actor,
  ids: readonly string[],
  tagIds: readonly string[],
): Promise<({ ok: true } & BatchSummary) | { ok: false; why: "bad_tag" }> {
  /**
   * **冻结：不加门是刻意豁免，不是漏加**（2026-10-16 裁定 / ADR-0005）。
   *
   * 标签只做分类、不改业务事实 —— 与节点 / 当事人 / 软删那几条"改了没人察觉"的路径
   * 不同：标签加错了**一眼能看见**（列表上就挂着），也能当场摘掉，不存在静默损害。
   * 所以这条路径绕过状态流转（`changeHostStatus`）直接写 `tag_ids` 是有意为之。
   *
   * ⚠ 想给它补冻结门的人：先回 ADR-0005 的 Consequences 第 3 条，那里写明
   * 「豁免清单从此有约束力」。改这条豁免要与那条 ADR 一起改，否则本文件与 ADR 互相打架。
   */
  const db = await getDb();
  const wanted = [...new Set(tagIds)].map((t) => BigInt(t));
  // 不过滤 is_enabled：与 `/api/meta` 的标签字典同口径（理由见案件侧同名注释）
  const found = await db
    .select({ id: tag.id })
    .from(tag)
    .where(and(eq(tag.hostType, "risk_matter"), inArray(tag.id, wanted)));
  if (found.length !== wanted.length) return { ok: false, why: "bad_tag" };

  const byId = await loadRiskBatchRows(db, actor, ids);
  const skipped: BatchSummary["skipped"] = [];
  let applied = 0;

  for (const id of [...new Set(ids)]) {
    const row = byId.get(id);
    // 不可见：静默排除
    if (!row) continue;

    if (row.isArchived) {
      skipped.push(skipRiskRow(id, "archived"));
      continue;
    }

    const have = new Set(row.tagIds.map(String));
    const add = wanted.filter((t) => !have.has(String(t)));
    if (!add.length) {
      skipped.push(skipRiskRow(id, "unchanged"));
      continue;
    }
    const next = [...row.tagIds, ...add];

    await db.transaction(async (tx) => {
      await tx
        .update(riskMatter)
        .set({ tagIds: next, updatedBy: BigInt(actor.userId), updatedAt: new Date().toISOString() })
        .where(eq(riskMatter.id, BigInt(id)));
      await logActivity(tx, actor, {
        riskMatterId: BigInt(id),
        targetType: "risk_matter",
        targetId: BigInt(id),
        action: "RISK_UPDATED",
        // `.map(String)`：`field_diffs` 是 jsonb，BigInt 进不了 JSON.stringify（见案件侧注释）
        diffs: { tag_ids: { from: row.tagIds.map(String), to: next.map(String) } },
      });
    });
    applied++;
  }
  return { ok: true, applied, skipped };
}

/* ───────────────────── 列表导出（MATT-64 / F1-20：脱敏 / 明文两档） ───────────────────── */

/** 一次导出最多这么多行；超出时 `truncated=true`（与 `MATTER_EXPORT_LIMIT` / `PARTY_EXPORT_LIMIT` 同值同义） */
export const RISK_EXPORT_LIMIT = 1000;

/** 导出的一行：列表那一屏的列 */
export type RiskExportRow = {
  code: string;
  name: string;
  type: string;
  level: string;
  status: string;
  discoverDate: string;
  ownerName: string | null;
  conversionStatus: number | null;
  convertedCaseCount: number;
  updatedAt: string;
};

/**
 * 事项列表的 CSV。
 *
 * ⚠ 脱敏规则、CSV 单元格编码、BOM 与行分隔都不在本文件里 —— 它们与整卷导出、
 * 当事人导出、案件列表导出共用 `exports.ts` 那一份实现；本文件只留"事项这张表
 * 在列表上有哪几列"这一件只有它才知道的事。
 *
 * 列逐项照 `risks-view.tsx` 的表头（没有多列）：这一份导出就是"这一屏的行"。
 * 「转案件」与「经办人」两列的说法与列表**逐字相同**（`已转 · N` / `未转` / `未指派`）
 * —— 同一份数据两个说法，用户会以为导错了。
 */
export function riskMattersExportCsv(
  rows: readonly RiskExportRow[],
  dict: { statusNames?: Record<string, string>; levelNames?: Record<string, string> },
): string {
  const header = [
    "编号",
    "事项名称",
    "类型",
    "等级",
    "状态",
    "转案件",
    "发现日期",
    "负责人",
    "更新",
  ];
  const lines = rows.map((r) => [
    r.code,
    r.name,
    RISK_MATTER_TYPE_LABELS[r.type as keyof typeof RISK_MATTER_TYPE_LABELS] ?? r.type,
    dict.levelNames?.[r.level] ?? r.level,
    dict.statusNames?.[r.status] ?? r.status,
    // 「转案件」这一列问的是与冻结门**同一个事实**（有没有转过案件），所以走同一个判据
    // `isRiskFrozen` —— 不在导出里再写一遍 `=== 1`。`risks.spec.ts` 那条
    // 「只出现一次」的源码守卫就是为这件事存在的（本票的第一次实现正是被它拦下的）。
    isRiskFrozen(r.conversionStatus) ? `已转 · ${r.convertedCaseCount}` : "未转",
    r.discoverDate,
    // 空值与列表同口径：留白会被读成"数据缺失"，而它是一个有业务含义的状态（待人接手）
    r.ownerName ?? "未指派",
    r.updatedAt,
  ]);
  return csvText([header, ...lines]);
}

/**
 * 事项列表导出（F1-20）：**吃列表当前的那套筛选**（含 `ownerEmpty`）。
 *
 * 口径与案件侧 `exportMatters` 逐条相同（集合逐行一致 / 服务层不判 `canReadPlain` /
 * 整批一条 `EXPORT`），差异只有本表的三件事：状态值域是配置驱动的、
 * 「转案件」列、经办人可空。
 */
export async function exportRiskMatters(
  actor: Actor,
  q: RiskMatterListExportQuery,
): Promise<{ plain: boolean; rows: number; count: number; truncated: boolean; csv: string }> {
  const db = await getDb();
  const where = riskMattersListWhere(actor, q);
  const col = SORTABLE[q.sortBy];
  /**
   * ⚠ 这里**不**带列表那两个 join（负责人姓名、当事人条数）：导出的列里没有它们，
   * 而带上 `leftJoin(mn_risk_matter_party)` 会让 `where` 语义以外的行数也变
   * —— 导出与列表的"逐行一致"是**谓词**的一致，不是 select 形状的一致。
   * 负责人姓名按同一表达式取（列表用的也是这一列）。
   */
  const rows = await db
    .select({
      code: riskMatter.code,
      name: riskMatter.name,
      type: riskMatter.type,
      level: riskMatter.level,
      status: riskMatter.status,
      discoverDate: riskMatter.discoverDate,
      ownerName: appUser.displayName,
      conversionStatus: riskMatter.conversionStatus,
      convertedCaseCount: riskMatter.convertedCaseCount,
      updatedAt: riskMatter.updatedAt,
    })
    .from(riskMatter)
    .leftJoin(appUser, eq(appUser.id, riskMatter.ownerId))
    .where(where)
    .orderBy(q.sortDir === "asc" ? asc(col) : desc(col), desc(riskMatter.id))
    .limit(RISK_EXPORT_LIMIT + 1);

  const truncated = rows.length > RISK_EXPORT_LIMIT;
  const kept = truncated ? rows.slice(0, RISK_EXPORT_LIMIT) : rows;
  const csv = riskMattersExportCsv(
    kept.map((r) => ({ ...r, ownerName: r.ownerName ?? null })),
    await configNameDict("risk_matter"),
  );

  await db.transaction(async (tx) => {
    await logActivity(tx, actor, {
      // 落点见 `listExportLanding`：跨宿主导出挂不到某一条事项上（挂上去是说谎）
      ...listExportLanding(actor),
      action: "EXPORT",
      payload: exportAuditPayload({
        targetType: "risk_matter",
        scope: "risk_matter_list",
        rows: kept.length,
        count: kept.length,
        plain: q.plain,
      }),
    });
  });

  return { plain: q.plain, rows: kept.length, count: kept.length, truncated, csv };
}

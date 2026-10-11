import { and, asc, count as dcount, desc, eq, sql, type SQL } from "drizzle-orm";
import { nextId } from "@/shared/ids/snowflake";
import { SORTABLE_COLUMNS } from "@/shared/schema/list-query";
import { getDb } from "../db/client";
import {
  matter,
  matterStaff,
  matterParty,
  matterNode,
  matterProgress,
  riskMatter,
  riskMatterCase,
  riskMatterParty,
  riskMatterStaff,
} from "../db/schema";
import { appUser, eventOutbox } from "../db/schema";
import { party } from "../db/schema";
import {
  insertNewParties,
  planPartyLinks,
  type PartyLinkInput,
  type PartyLinkPlanRow,
} from "./parties";
import { archivedFilter, keywordFilter, scopedWhere } from "../scope/visibility";
import { insertPlannedNodes, planPresetNodesFor } from "./nodes";
import type { Actor } from "../auth/auth";
import { nextCode } from "./numbering";
import { initialStatusCode } from "./statuses";
import { logActivity } from "./activity";
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
 * 排序键 → 列，与案件侧共用同一套白名单（`shared/schema/list-query` 的 `SORTABLE_COLUMNS`）。
 *
 * 写成 `Record<白名单, SQL>` 而不是 `Record<string, SQL>`：少一个键编译期就报缺属性，
 * 不会出现"表头点了、数据没动"（本表此前只收 `sortDir`、不收 `sortBy`，
 * 前端那一列排序箭头全是死控件——这个映射就是来补上的）。
 */
const SORTABLE: Record<(typeof SORTABLE_COLUMNS)[number], SQL> = {
  code: sql`${riskMatter.code}`,
  name: sql`${riskMatter.name}`,
  status: sql`${riskMatter.status}`,
  risk_level: sql`${riskMatter.level}`,
  owner_name: sql`(select u.display_name from mn_app_user u where u.id = ${riskMatter.ownerId})`,
  amount: sql`${riskMatter.amount}`,
  created_at: sql`${riskMatter.createdAt}`,
  updated_at: sql`${riskMatter.updatedAt}`,
};

export async function listRiskMatters(
  actor: Actor,
  q: {
    page: number;
    pageSize: number;
    keyword?: string;
    status?: string;
    sortBy?: (typeof SORTABLE_COLUMNS)[number];
    archivedOnly?: boolean;
    sortDir?: "asc" | "desc";
  },
) {
  const db = await getDb();
  const where = and(
    scopedWhere("risk_matter", actor),
    archivedFilter("risk_matter", Boolean(q.archivedOnly)),
    q.status ? eq(riskMatter.status, q.status) : undefined,
    keywordFilter("risk_matter", q.keyword),
  );
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
      amount: riskMatter.amount,
      status: riskMatter.status,
      conversionStatus: riskMatter.conversionStatus,
      convertedCaseCount: riskMatter.convertedCaseCount,
      isArchived: riskMatter.isArchived,
      archivedAt: riskMatter.archivedAt,
      discoverDate: riskMatter.discoverDate,
      updatedAt: riskMatter.updatedAt,
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
    items: rows.map((r) => ({ ...r, id: String(r.id) })),
    page: q.page,
    pageSize: q.pageSize,
    total: Number(total?.n ?? 0),
  };
}

type Db = Awaited<ReturnType<typeof getDb>>;
/** 事务句柄：与 `services/nodes.ts`、`services/parties.ts` 同一取法（从回调参数上取，别自己拼泛型） */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 建事项：编号 `FX-`，`discover_date` 是日历 `date`（§12.2） */
export async function createRiskMatter(
  actor: Actor,
  input: {
    name: string;
    type: string;
    level: string;
    source?: string | null;
    description: string;
    measure?: string | null;
    amount?: string;
    discoverDate?: string | null;
    ownerId?: string;
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
) {
  const db = await getDb();
  const { code } = await nextCode("riskMatter");
  const id = BigInt(nextId());
  const owner = BigInt(input.ownerId ?? actor.userId);
  // 在**进入事务前**取：事务内再向池子要一条连接去查配置，池子满时会互等成死锁
  const initial = await initialStatusCode("risk_matter");
  // ⚠ **事项侧不生成任何预设节点**（IQ-5：「事项是台账，案件是战场」）。
  // 这里曾调 `planPresetNodesFor("risk_matter")`，而节点类型配置里 3 行 risk_matter
  // 的 `preset_on_create` 当时还是 true，于是每建一条事项就被塞 3 个系统节点。
  // 节点改为**经办人手动添加**；节点类型行保留（可手动选），只是不再自动实例化——
  // 裁定否掉的是「塞几个」，不是「可以选什么」。
  // 同样是事务前算好——它要连库查当事人，既不能在事务里做，也要在事务外拿到冲突清单
  const partyPlan = await planPartyLinks(input.parties ?? []);
  await db.transaction(async (tx) => {
    await tx.insert(riskMatter).values({
      id,
      code,
      name: input.name,
      type: input.type,
      level: input.level,
      source: input.source ?? null,
      description: input.description,
      measure: input.measure ?? null,
      amount: input.amount ?? "0",
      discoverDate: input.discoverDate ?? new Date().toISOString().slice(0, 10),
      status: initial,
      ownerId: owner,
      createdBy: BigInt(actor.userId),
      updatedBy: BigInt(actor.userId),
    });
    await tx
      .insert(riskMatterStaff)
      .values({ id: BigInt(nextId()), hostId: id, userId: owner, staffRole: "owner" });
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

/** 建事项后追加当事人。与建事项那次走同一套校验与去重。 */
export async function appendRiskParties(
  actor: Actor,
  riskId: string,
  links: readonly PartyLinkInput[],
): Promise<{ ok: true; added: number } | { ok: false; why: "not_found" }> {
  const db = await getDb();
  const [src] = await db
    .select({ id: riskMatter.id, isArchived: riskMatter.isArchived })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!src) return { ok: false, why: "not_found" };
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

/** 摘除一条当事人挂接。删的是**关联行**，不是当事人本体——后者归 T3 管的档案。 */
export async function removeRiskParty(
  actor: Actor,
  riskId: string,
  linkId: string,
): Promise<{ ok: true } | { ok: false; why: "not_found" }> {
  const db = await getDb();
  const [src] = await db
    .select({ id: riskMatter.id })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!src) return { ok: false, why: "not_found" };

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
    idNumber: r.idNumber,
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
    await tx.insert(eventOutbox).values({
      id: BigInt(nextId()),
      eventType: "risk_converted",
      batchId,
      payload: {
        risk_matter_id: riskId,
        case_ids: caseIds.map((c) => String(c)),
        from: src.code,
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
export type UnconvertBlocker = "progress" | "nodes";

export type UnconvertResult =
  | { ok: true; caseId: string; remaining: number }
  | { ok: false; why: "not_found" | "not_linked" | "reason_required" }
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
 * **已知缺口（属 T9）**：`mn_matter_expense` 表**尚不存在**，所以"费用"这条前置
 * 目前**形同虚设**。T9 落费用表时必须把 `expenses` 加进下面的 `blockers` 判定，
 * 否则费用录满的案件也能被撤。已在 T9 票面记为验收项，不靠注释备忘。
 *
 * **不自动解除归档**（映射矩阵 §5.1）：自动回滚归档等于让一次动作隐式解开另一次
 * 状态变更，审计链会断。已归档的案件保持归档，需人工持 `can_unarchive` 撤销。
 * 同理**不写 outbox**：§5.1 只要求 `activity_log(UNCONVERT)`，且规则 7 只监听
 * `0 → 1` 这一次变更，撤销方向没有已定义的消费者。
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
  const [progressRows] = await db
    .select({ n: dcount() })
    .from(matterProgress)
    .where(eq(matterProgress.matterId, BigInt(caseId)));
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

  if (blockers.length > 0) return { ok: false, why: "blocked", blockers };

  const remaining = await db.transaction(async (tx) => {
    await tx.delete(riskMatterCase).where(eq(riskMatterCase.id, link.id));

    // 计数同样用 COUNT(*) 重算。与 convertToCase 同一口径——这正是它当初被改掉的原因：
    // 累加在撤销之后会永久偏移，而它是"已转 N 个案件"徽标的唯一数据源。
    const [cnt] = await tx
      .select({ n: dcount() })
      .from(riskMatterCase)
      .where(eq(riskMatterCase.riskMatterId, BigInt(riskId)));
    const rest = Number(cnt?.n ?? 0);

    // 归零才回 0 + 清时间戳。事项若还挂着别的案件，徽标就该继续显示"已转 N 个"，
    // 清成 0 会让用户以为"转过但没了"，而关联其实还在。
    await tx
      .update(riskMatter)
      .set({
        conversionStatus: rest > 0 ? 1 : 0,
        convertedAt: rest > 0 ? src.convertedAt : null,
        convertedBy: rest > 0 ? src.convertedBy : null,
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

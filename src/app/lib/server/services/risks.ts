import { and, asc, count as dcount, desc, eq, sql, type SQL } from "drizzle-orm";
import { nextId } from "@/shared/ids/snowflake";
import { SORTABLE_COLUMNS } from "@/shared/schema/list-query";
import { getDb } from "../db/client";
import {
  matter,
  matterStaff,
  matterParty,
  riskMatter,
  riskMatterCase,
  riskMatterParty,
  riskMatterStaff,
} from "../db/schema";
import { eventOutbox } from "../db/schema";
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
      ownerName: sql<string>`(select u.display_name from mn_app_user u where u.id = ${riskMatter.ownerId})`,
    })
    .from(riskMatter)
    .where(where)
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
  },
) {
  const db = await getDb();
  const { code } = await nextCode("riskMatter");
  const id = BigInt(nextId());
  const owner = BigInt(input.ownerId ?? actor.userId);
  // 在**进入事务前**取：事务内再向池子要一条连接去查配置，池子满时会互等成死锁
  const initial = await initialStatusCode("risk_matter");
  /** 清单#3「事项默认 3 个节点」由 seed 的 3 行 `preset_on_create` 承载（修订稿 §4 P1） */
  const presetNodes = await planPresetNodesFor("risk_matter");
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
    await insertPlannedNodes(tx, "risk_matter", id, presetNodes, BigInt(actor.userId));
    await logActivity(tx, actor, {
      riskMatterId: id,
      targetType: "risk_matter",
      targetId: id,
      action: "RISK_CREATED",
    });
  });
  return { id: String(id), code };
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

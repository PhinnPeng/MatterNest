import { and, asc, count as dcount, desc, eq, sql } from "drizzle-orm";
import { nextId } from "@/shared/ids/snowflake";
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
import { archivedFilter, keywordFilter, scopedWhere } from "../scope/visibility";
import { insertPlannedNodes, planPresetNodesFor } from "./nodes";
import type { Actor } from "../auth/auth";
import { nextCode } from "./numbering";
import { initialStatusCode } from "./statuses";
import { logActivity } from "./activity";

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

export async function listRiskMatters(
  actor: Actor,
  q: {
    page: number;
    pageSize: number;
    keyword?: string;
    status?: string;
    includeArchived?: boolean;
    sortDir?: "asc" | "desc";
  },
) {
  const db = await getDb();
  const where = and(
    scopedWhere("risk_matter", actor),
    archivedFilter("risk_matter", Boolean(q.includeArchived)),
    q.status ? eq(riskMatter.status, q.status) : undefined,
    keywordFilter("risk_matter", q.keyword),
  );
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
      discoverDate: riskMatter.discoverDate,
      updatedAt: riskMatter.updatedAt,
      ownerName: sql<string>`(select u.display_name from mn_app_user u where u.id = ${riskMatter.ownerId})`,
    })
    .from(riskMatter)
    .where(where)
    .orderBy(
      q.sortDir === "asc" ? asc(riskMatter.updatedAt) : desc(riskMatter.updatedAt),
      desc(riskMatter.id),
    )
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
  { ok: true; id: string; internalCode: string } | { ok: false; why: "not_found" | "no_parties" };

/**
 * 转案件（映射矩阵 §2）。返回新案件的内部编号，前端据此跳详情。
 * 幂等性：同一事项可多次转（`converted_case_count` 递增），因为"已转案件"是与结案正交的第二事实（§3.4）。
 *
 * 当事人是**引用同一批 `mn_party` 行**、不是克隆（§2.6）：这就是为什么这里复制
 * `risk_matter_party` 的 `party_id` 而不是新建当事人。复制 `party_role` 作为默认值，
 * 逐案可改 —— 风险阶段的角色与诉讼阶段的角色通常一致，但不保证（§2.6 原话）。
 */
export async function convertToCase(
  actor: Actor,
  riskId: string,
  input: {
    name: string;
    cause: string;
    caseType: string;
    procedure: string;
    litigationRole: string;
    court?: string | null;
    level: string;
    filingDate?: string | null;
  },
): Promise<ConvertResult> {
  const db = await getDb();
  const [src] = await db
    .select()
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(riskId))))
    .limit(1);
  if (!src) return { ok: false, why: "not_found" };

  // 引用事项已关联的当事人。一条都没有就直接拒：修订稿 §6.2 把"每案 ≥1 当事人"定在
  // **转案件确认**这个校验时机上，放过就会建出一件没有对手方也没有委托方的案卷。
  const srcParties = await db
    .select({
      partyId: riskMatterParty.partyId,
      partyRole: riskMatterParty.partyRole,
      represented: riskMatterParty.represented,
      sortOrder: riskMatterParty.sortOrder,
    })
    .from(riskMatterParty)
    .where(eq(riskMatterParty.hostId, BigInt(riskId)))
    .orderBy(asc(riskMatterParty.sortOrder));
  if (srcParties.length === 0) return { ok: false, why: "no_parties" };

  const { code } = await nextCode("matter");
  const caseId = BigInt(nextId());
  // 同 createRiskMatter：取初始态与预设节点都要在进事务之前，别在事务里向池子再要一条连接
  const initial = await initialStatusCode("matter");
  const presetNodes = await planPresetNodesFor("matter");
  await db.transaction(async (tx) => {
    await tx.insert(matter).values({
      id: caseId,
      internalCode: code,
      caseNo: code,
      // 描述**不继承**（P0-1）：只带事项名称作为初始案由说明，正文留空由承办人逐案填
      name: input.name,
      cause: input.cause,
      caseType: input.caseType,
      procedure: input.procedure,
      litigationRole: input.litigationRole,
      court: input.court ?? null,
      amount: "0",
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
        represented: p.represented,
        sortOrder: p.sortOrder,
      });
    }
    await insertPlannedNodes(tx, "matter", caseId, presetNodes, BigInt(actor.userId));
    await tx
      .insert(riskMatterCase)
      .values({ id: BigInt(nextId()), riskMatterId: BigInt(riskId), matterId: caseId });
    await tx
      .update(riskMatter)
      .set({
        conversionStatus: 1,
        convertedAt: new Date().toISOString(),
        convertedBy: BigInt(actor.userId),
        convertedCaseCount: sql`${riskMatter.convertedCaseCount} + 1`,
        updatedBy: BigInt(actor.userId),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(riskMatter.id, BigInt(riskId)));
    await logActivity(tx, actor, {
      matterId: caseId,
      riskMatterId: BigInt(riskId),
      targetType: "risk_matter",
      targetId: BigInt(riskId),
      action: "CONVERTED_TO_CASE",
      payload: { case_ids: [String(caseId)], from: src.code },
    });
  });
  return { ok: true, id: String(caseId), internalCode: code };
}

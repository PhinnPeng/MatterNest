import { asc, eq } from "drizzle-orm";
import { AUDIT_ACTION_LABELS } from "@/shared/enums/audit";
import {
  CASE_TYPE_LABELS,
  DATA_SCOPES,
  EXPENSE_STATUS_LABELS,
  HOST_TYPES,
  ID_TYPE_LABELS,
  LITIGATION_ROLE_LABELS,
  NODE_STATUS_LABELS,
  NODE_SOURCE_KIND_LABELS,
  PARTY_TYPE_LABELS,
  PROCEDURE_LABELS,
  PROGRESS_TYPE_LABELS,
  RISK_MATTER_SOURCE_LABELS,
  RISK_MATTER_TYPE_LABELS,
  STAFF_ROLE_LABELS,
  STATUS_SEMANTIC_LABELS,
  TIME_TYPE_LABELS,
} from "@/shared/enums";
import { readActor } from "@/app/lib/server/auth/auth";
import { getDb } from "@/app/lib/server/db/client";
import { riskLevelConfig, tag } from "@/app/lib/server/db/schema";
import { listExpenseItems } from "@/app/lib/server/services/expenses";
import { hostStatusRows } from "@/app/lib/server/services/statuses";
import { json, unauthorized } from "@/app/lib/server/http";

/**
 * 下拉字典。
 *
 * 分两半是有原因的：状态、风险等级与**费用项目**是**配置驱动**（枚举表 §0），
 * 运营可改，所以从库里读；案件类型/审级/诉讼地位/节点状态是硬编码枚举，
 * 从 `@/shared/enums` 出，中文名字典也来自同一份 —— 前端不再自己抄一份中文，
 * 那是"两份实现"最常见的起点。
 */
export async function GET(req: Request) {
  const actor = await readActor();
  if (!actor) return unauthorized();
  const hostType =
    new URL(req.url).searchParams.get("host") === "risk_matter" ? "risk_matter" : "matter";
  const db = await getDb();
  const [statuses, levels, tags, expenseItems] = await Promise.all([
    // 走服务层同一个函数：这里原来自己 select 了一遍 statusConfig，
    // 少了 `is_enabled` 过滤 ⇒ 被停用的状态仍会出现在下拉里、还能被提交。
    hostStatusRows(hostType),
    db
      .select({ code: riskLevelConfig.code, name: riskLevelConfig.name })
      .from(riskLevelConfig)
      .orderBy(asc(riskLevelConfig.sortOrder)),
    db
      .select({ id: tag.id, name: tag.name })
      .from(tag)
      .where(eq(tag.hostType, hostType))
      .orderBy(asc(tag.sortOrder)),
    /**
     * 费用项目（F5-4 / 基线 7.6）。**走服务层那一个读出口**，不在这里再 select 一遍：
     * 选择器要的是"启用的"，详情与导出要的是"含停用的"（历史费用指着它），
     * 两处各查一遍就会漂移。这里给全量 + `isEnabled`，由调用方按用途过滤。
     */
    listExpenseItems(actor),
  ]);
  return json({
    actor,
    statuses,
    levels,
    tags: tags.map((t) => ({ id: String(t.id), name: t.name })),
    expenseItems,
    enums: {
      caseTypes: CASE_TYPE_LABELS,
      procedures: PROCEDURE_LABELS,
      litigationRoles: LITIGATION_ROLE_LABELS,
      partyTypes: PARTY_TYPE_LABELS,
      idTypes: ID_TYPE_LABELS,
      riskTypes: RISK_MATTER_TYPE_LABELS,
      riskSources: RISK_MATTER_SOURCE_LABELS,
      nodeStatuses: NODE_STATUS_LABELS,
      // 详情页三个 Tab 要显示的三类中文标签。都从枚举出，前端不抄第二份（本文件顶部第三条理由）
      progressTypes: PROGRESS_TYPE_LABELS,
      staffRoles: STAFF_ROLE_LABELS,
      nodeSourceKinds: NODE_SOURCE_KIND_LABELS,
      timeTypes: TIME_TYPE_LABELS,
      auditActions: AUDIT_ACTION_LABELS,
      semantics: STATUS_SEMANTIC_LABELS,
      hostTypes: HOST_TYPES,
      dataScopes: DATA_SCOPES,
      // E20 三值（不含 approved）：费用列表那一列与选择器的中文名都从这一份出
      expenseStatuses: EXPENSE_STATUS_LABELS,
    },
  });
}

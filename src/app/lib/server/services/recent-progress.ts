import { and, count, desc, inArray, sql } from "drizzle-orm";

import type { Actor } from "../auth/auth";
import { getDb } from "../db/client";
import { matter, matterProgress, riskMatter, riskMatterProgress } from "../db/schema";
import { scopedWhere } from "../scope/visibility";
import { PROGRESS_TYPE_LABELS } from "@/shared/enums/business";
import type { HostType } from "@/shared/enums/targets";
import type {
  RecentProgressDays,
  RecentProgressItem,
  RecentProgressPayload,
  RecentProgressScope,
} from "@/shared/schema/reports";
import { logActivity } from "./activity";
import { EXPORT_SECTION_LIMIT, csvText, exportAuditPayload, listExportLanding } from "./exports";

/**
 * 「报表 · 最近进展」的服务端查询（2026-10-24）。
 *
 * 与工作台「近期活动」同一口径：可见范围（`scopedWhere`）+ 未归档 + 至少一条进展，
 * 按 `last_progress_at` 倒序；每行取该宿主**最新一条**进展正文（按录入时间）。
 *
 * 工作台预览与报表页共用本文件的 `queryRecent`——两处各写一份 SQL 时，口径漂移不会报错，
 * 只会出现"工作台说 3 条、报表说 5 条"这种没人能解释的差。
 */

const HOST_COLUMN: Record<RecentProgressScope, "matter_id" | "risk_matter_id"> = {
  matter: "matter_id",
  risk_matter: "risk_matter_id",
};

/** 滚动时间窗（含时分）。`all` 不设条件，由 `last_progress_at IS NOT NULL` 兜底。 */
function cutoffOf(days: RecentProgressDays): string | null {
  if (days === "all") return null;
  return new Date(Date.now() - Number(days) * 86_400_000).toISOString();
}

function progressTypeLabel(type: string | null): string {
  if (!type) return "";
  return PROGRESS_TYPE_LABELS[type as keyof typeof PROGRESS_TYPE_LABELS] ?? type;
}

type QueryOptions = {
  scope: RecentProgressScope;
  days: RecentProgressDays;
  limit: number;
  offset: number;
  /**
   * 工作台/导出不需要总数：`count(*)` 在两张宿主表上各跑一次是白付的往返。
   * 页面分页才传 true。
   */
  withTotal?: boolean;
};

export async function queryRecent(
  actor: Actor,
  opts: QueryOptions,
): Promise<{ items: RecentProgressItem[]; total: number }> {
  const db = await getDb();
  const scope = opts.scope as HostType;
  const host = scope === "matter" ? matter : riskMatter;
  const progress = scope === "matter" ? matterProgress : riskMatterProgress;
  const cutoff = cutoffOf(opts.days);
  const hostColumn = HOST_COLUMN[opts.scope];

  const where = and(
    scopedWhere(scope, actor),
    sql`NOT ${host.isArchived}`,
    sql`${host.lastProgressAt} IS NOT NULL`,
    // `last_progress_at` 在建案时也写 now()，所以必须有至少一条进展行才算"有进展"。
    // 子查询手写列名：从 `"mn_matter_progress" p` 起别名后，drizzle 渲染的
    // `"mn_matter_progress"."matter_id"` 会被别名遮住（PG 报 missing FROM-clause）。
    sql`exists (select 1 from ${progress} p where p.${sql.raw(hostColumn)} = ${host.id} and not p.is_deleted)`,
    cutoff ? sql`${host.lastProgressAt} >= ${cutoff}` : undefined,
  );

  const rows = await db
    .select({
      hostId: host.id,
      code: scope === "matter" ? matter.caseNo : riskMatter.code,
      name: host.name,
      progressAt: host.lastProgressAt,
      owner: sql<
        string | null
      >`(select u.display_name from mn_app_user u where u.id = ${host.ownerId})`,
    })
    .from(host)
    .where(where)
    .orderBy(desc(host.lastProgressAt), desc(host.id))
    .limit(opts.limit)
    .offset(opts.offset);

  // 两张表分开 count：`from(union)` 的返回类型在 TS 里会并成联合，取 `.n` 报不存在。
  const totalRows =
    opts.withTotal === false
      ? []
      : scope === "matter"
        ? await db.select({ n: count() }).from(matter).where(where)
        : await db.select({ n: count() }).from(riskMatter).where(where);
  const total = Number(totalRows[0]?.n ?? 0);

  const ids = rows.map((r) => r.hostId);
  const latest = ids.length
    ? await db
        .selectDistinctOn([progress.hostId], {
          hostId: progress.hostId,
          progressType: progress.progressType,
          content: progress.content,
        })
        .from(progress)
        .where(and(inArray(progress.hostId, ids), sql`NOT ${progress.isDeleted}`))
        .orderBy(progress.hostId, desc(progress.createdAt), desc(progress.id))
    : [];
  const latestMap = new Map(latest.map((r) => [String(r.hostId), r]));

  return {
    total,
    items: rows.map((r) => {
      const l = latestMap.get(String(r.hostId));
      const type = l?.progressType ?? null;
      return {
        hostId: String(r.hostId),
        code: r.code ?? "—",
        name: r.name,
        progressType: type ?? "",
        progressLabel: progressTypeLabel(type),
        content: l?.content ?? "",
        progressAt: String(r.progressAt),
        owner: r.owner,
      };
    }),
  };
}

/** 页面分页查询：返回与 `recentProgressQuerySchema` 对齐的固定形状（type-safety：列表固定形态）。 */
export async function recentProgress(
  actor: Actor,
  q: { scope: RecentProgressScope; days: RecentProgressDays; page: number; pageSize: number },
): Promise<RecentProgressPayload> {
  const r = await queryRecent(actor, {
    scope: q.scope,
    days: q.days,
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
    withTotal: true,
  });
  return {
    scope: q.scope,
    days: q.days,
    page: q.page,
    pageSize: q.pageSize,
    total: r.total,
    items: r.items,
  };
}

/**
 * 导出当前筛选（不分页，上限 1000 行）。
 *
 * 一档导出：这六列没有证件号与金额，给「明文/脱敏」两个选项等于造一个假的差异，
 * 所以不需要 `canReadPlain`。审计仍按 `EXPORT` 落账号维度（列表导出同一条落点）。
 */
export async function exportRecentProgress(
  actor: Actor,
  q: { scope: RecentProgressScope; days: RecentProgressDays },
): Promise<{ rows: number; truncated: boolean; csv: string }> {
  const { items } = await queryRecent(actor, {
    scope: q.scope,
    days: q.days,
    limit: EXPORT_SECTION_LIMIT + 1,
    offset: 0,
    withTotal: false,
  });
  const truncated = items.length > EXPORT_SECTION_LIMIT;
  const kept = truncated ? items.slice(0, EXPORT_SECTION_LIMIT) : items;

  const csv = csvText([
    ["案号/编号", "名称", "进展类型", "进展内容", "进展时间", "经办人"],
    ...kept.map((r) => [
      r.code,
      r.name,
      r.progressLabel,
      r.content,
      new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(r.progressAt)),
      r.owner ?? "",
    ]),
  ]);

  const db = await getDb();
  await db.transaction(async (tx) => {
    await logActivity(tx, actor, {
      ...listExportLanding(actor),
      action: "EXPORT",
      payload: exportAuditPayload({
        targetType: q.scope,
        scope: `${q.scope}_recent_progress_${q.days}`,
        rows: kept.length,
        plain: false,
      }),
    });
  });

  return { rows: kept.length, truncated, csv };
}

import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { LITIGATION_ROLES, NODE_OPEN_STATUSES } from "@/shared/enums/business";
import { HOST_TYPES } from "@/shared/enums/targets";
import { archivedOnlyField, configStatusField, ownerEmptyField } from "@/shared/schema/list-query";
import type { Actor } from "../auth/auth";
import { getDb } from "../db/client";
import {
  matter,
  matterNode,
  riskLevelConfig,
  riskMatter,
  riskMatterNode,
  statusConfig,
} from "../db/schema";
import { HOSTS, archivedFilter, scopedWhere, type HostKind } from "../scope/visibility";

/**
 * 报表两卡的服务端聚合（MATT-46 / F8-1 + F8-2）。
 *
 * ## 两张卡与它们的维度
 *
 * 卡①总览：**案件 = 状态 × 风险等级 × 我方诉讼地位**、**事项 = 状态 × 风险等级**。
 * 卡②节点到期：跨 `mn_matter_node` 与 `mn_risk_matter_node` 两张**同构**表 UNION 后的三档计数。
 * 「同构」不是本文件的假设：MATT-8 的契约测试守着两张表的列集合
 * （`db/enum-check.spec.ts` 的 `ISO_PAIRS`），所以下面两条分支可以逐字对称地写。
 *
 * ## 三条纪律（口径见 `docs/PRD-phase1-master.md` §4.7）
 *
 * 1. **可见性只有一个出口**：每张卡的每一格都经 `scopeOf()` → `scopedWhere`（权限草案 §4）。
 *    本文件里没有第二处拼范围条件的地方，也不写 `owner_id = …`。
 * 2. **归档是二态开关，不混着看**：`archiveOf()` → `archivedFilter`，与两张列表同一语义
 *    （`archivedOnly=1` 看归档，默认看在办；没有"混入"的第三种）。
 * 3. **聚合全在服务端**：两张卡各一条聚合查询（不是每格一次），返回的是已经摆好
 *    行 / 列 / 合计的矩阵；界面不做求和、不做分组、也不按行二次取数。
 * 4. **列表筛选进得来、也只有一个出口**：`listFilterOf()` → 三个筛选（状态 / 未指派 /
 *    在办·已归档），两个宿主同一谓词；关键词与分页排序**不是**筛选（§4.7 第 6 条）。
 *
 * ## 为什么不复用工作台的查询
 *
 * 工作台（`services/overview.ts`）是"我的待办视角"：临期硬编码 7 天、只看案件节点、带 top10 明细。
 * 报表是"全局聚合视角"：按节点自身提醒档分档、跨两宿主、只给计数。两者共用 `scopedWhere`，
 * 但**不共用查询函数**——共用会让两套口径一起漂移，而它们的读者与用途不同（§4.7 第 4 条）。
 */

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * 查询参数 = **列表筛选里那三个**（F8-1「随筛选联动」）+ 归档开关。
 *
 * 字段定义全部从 `@/shared/schema/list-query` 引（禁令⑧），与两张列表**同名同义**：
 * 列表页把当前筛选原样交给卡片，卡片就能跟着变，不需要第二套"报表专用筛选"词汇。
 *
 * **关键词、排序、分页不在里面**，`missingMaterials` 也不在（理由见 §4.7 第 6 条）。
 * `.strict()` 是刻意的：多传一个（比如把列表那份 `toQuery` 原样发过来）会 400，
 * 而不是被 zod 默认剥掉——静默剥掉正是"筛选点了没反应"那类缺陷的形态
 * （`ownerEmpty` 在客户端漏输出过一次，见 `use-list-state.spec.ts`）。
 */
export const reportsQuerySchema = z
  .object({
    status: configStatusField.optional(),
    ownerEmpty: ownerEmptyField,
    archivedOnly: archivedOnlyField,
  })
  .strict();
export type ReportsQuery = z.infer<typeof reportsQuerySchema>;

/**
 * 到期三档。**报表自己的词汇**，不是域枚举——所以它随报表 DTO 一起下发（键 + 中文名），
 * 界面按服务端给的顺序画列，不自己再定义一份档位（否则服务端加一档，界面会静默少一列）。
 */
export const DEADLINE_BUCKETS = [
  { key: "overdue", label: "已逾期" },
  { key: "soon", label: "临期" },
  { key: "later", label: "更远" },
] as const;
export type DeadlineBucketKey = (typeof DEADLINE_BUCKETS)[number]["key"];

/** 矩阵的一列（案件卡是诉讼地位，事项卡是风险等级）：**只列有数据的**，顺序由服务端排好 */
export type MatrixColumn = { code: string; total: number };

export type MatterMatrix = {
  total: number;
  /** 列 = 我方诉讼地位，顺序按枚举表 E12（配置页与详情页看到的同一个顺序） */
  roles: MatrixColumn[];
  /** 行 = 状态 × 等级；`statusTotal` 是同一状态跨等级的小计（界面用它画合并单元格） */
  rows: {
    status: string;
    statusTotal: number;
    level: string;
    total: number;
    /** 诉讼地位 code → 计数；缺键 = 该格为 0 */
    counts: Record<string, number>;
  }[];
};

export type RiskMatrix = {
  total: number;
  /** 列 = 风险等级，顺序按 `mn_risk_level_config.sort_order` */
  levels: MatrixColumn[];
  rows: { status: string; total: number; counts: Record<string, number> }[];
};

export type NodeDeadlineCard = {
  total: number;
  buckets: { key: DeadlineBucketKey; label: string }[];
  /** 两行恒在（案件 / 事项），0 也留着——"这个宿主没有到期节点"是结论，不是缺行 */
  rows: { kind: HostKind; total: number; counts: Record<string, number> }[];
  /** 每一档的合计（表尾那一行）。**服务端算**：界面不求和，连表尾也不求 */
  bucketTotals: Record<string, number>;
};

export type ReportsPayload = {
  /** 回显口径：这两张卡算的是在办还是归档（界面据此标注，不靠本地状态猜） */
  archivedOnly: boolean;
  matters: MatterMatrix;
  risks: RiskMatrix;
  nodes: NodeDeadlineCard;
};

/* ───────────────────────── 三条口径，各只有一个出口 ───────────────────────── */

/**
 * 可见性谓词（权限草案 §4「禁止裸表访问」）。
 * 报表是最容易漏套范围的那类查询——它没有"这一行"的概念，漏了只会让数字变大。
 * 所以两张卡的三个查询全部从这里取，一处改、三处生效。
 */
function scopeOf(host: HostKind, actor: Actor): SQL {
  return scopedWhere(host, actor);
}

/**
 * 归档口径：**二态**。默认在办（`NOT is_archived`），`archivedOnly` 时只看归档。
 * 与两张列表共用 `archivedFilter`，所以"报表里的归档"与"归档页里的归档"是同一个谓词。
 */
function archiveOf(host: HostKind, archivedOnly: boolean): SQL {
  return archivedFilter(host, archivedOnly);
}

/**
 * 列表筛选 → 报表谓词（F8-1「随筛选联动」的**唯一一处**）。
 *
 * 三个筛选对两个宿主**用同一个谓词**：卡片上的每个数字都是"当前筛选下的读数"，
 * 一句话能解释整张卡——所以不按"这一行是不是本页宿主"分叉（那会让同一张卡的两行
 * 处在两套范围里，读者无法从界面上分辨）。代价写在 §4.7 第 6 条：案件 `owner_id`
 * 是 NOT NULL（IQ-6），所以「未指派」下案件那一行是 0 —— 那是事实，不是缺数。
 *
 * 列引用取 `HOSTS[host]`（`scopeOf` / `archiveOf` 用的也是它），所以这里不会长出
 * 第二份表名/列名映射；无筛选时给 `sql\`true\`` 而不是 `undefined`，
 * 因为调用点会把它直接嵌进 sql 模板（嵌 undefined 是运行时错误）。
 */
function listFilterOf(host: HostKind, q: ReportsQuery): SQL {
  const h = HOSTS[host];
  return (
    and(
      q.status ? eq(h.table.status, q.status) : undefined,
      // 「未指派」= `owner_id IS NULL`，与事项列表那条筛选逐字同一个判据
      // （`listRiskMatters` 里也是 `isNull`，`= ''` / `NOT EXISTS` 是另外两种"空"）
      q.ownerEmpty ? isNull(h.table.ownerId) : undefined,
    ) ?? sql`true`
  );
}

type NodeTable = typeof matterNode | typeof riskMatterNode;

/**
 * 节点扫描谓词。前两条与提醒扫描器**逐字同源**（修订稿 §6.1 的 `ix_node_scan` partial index）：
 * `is_time_confirmed AND status ∈ NODE_OPEN_STATUSES`。理由是 A8 与票面那条纪律——
 * **未确认时间的节点不该算进"临期"**（时间都没定，谈不上还剩几天），已完成/已取消的也不再算到期。
 * 后两条：软删的行不是"看不见"而是"不存在"；`deadline_time IS NOT NULL` 是因为生成列
 * `COALESCE(end_time, start_time)` 在两列都空时仍是 NULL，而"时间已确认但没填时间"的行
 * 算不出"还剩几天"——归进任何一档都是编的，所以不进统计。
 */
function nodeScan(n: NodeTable): SQL {
  return and(
    sql`NOT ${n.isDeleted}`,
    sql`${n.isTimeConfirmed}`,
    inArray(n.status, NODE_OPEN_STATUSES),
    sql`${n.deadlineTime} IS NOT NULL`,
  ) as SQL;
}

/**
 * 到期分档。`临期` 的窗口**不是一个常数**：取该节点自己 `remind_days` 里最远的一档
 * （`{7,3,1}` → 7 天，`{3,1}` → 3 天），空数组回落到 7 天——所以同一张卡上"还剩 5 天"的节点
 * 在 `{7,3,1}` 下算临期、在 `{3,1}` 下算更远。这正是配置驱动的意思，也是它与工作台
 * 硬编码 7 天档的差别（§4.7 第 2、4 条）。
 *
 * 每行跑一次 `max(unnest(…))`：提醒档是个位数长度的数组、报表不是热路径，
 * 不值得为它建表达式索引（真要优化，那是先有慢查询证据之后的事）。
 */
function bucketCase(n: NodeTable): SQL {
  return sql`case
    when ${n.deadlineTime} < now() then 'overdue'
    when ${n.deadlineTime} < now() + make_interval(days => coalesce((select max(d) from unnest(${n.remindDays}) as t(d)), 7)) then 'soon'
    else 'later'
  end`;
}

/* ───────────────────────────── 卡①：两张矩阵 ───────────────────────────── */

type MatterCellRow = {
  status: string;
  level: string;
  litigationRole: string;
  statusSort: number;
  levelSort: number;
  n: number;
};

type RiskCellRow = {
  status: string;
  level: string;
  statusSort: number;
  levelSort: number;
  n: number;
};

/**
 * 案件格：`group by 状态, 等级, 诉讼地位`，一次查完所有格子。
 *
 * 状态名与等级名**不在这里翻**：它们是配置驱动的字典，唯一出口是 `/api/meta`
 * （工作台的状态分布也是拿 `byStatus` 的 code 去对 `meta.statuses`）。服务层只给 code，
 * 这样运营在配置页改一次显示名，报表与列表一起变。
 *
 * 排序键（`statusSort` / `levelSort`）取自配置表：行顺序必须与配置页一致，
 * 否则"高 / 中 / 低"会被字典序排成"低 / 中 / 高"。
 */
function matterCells(db: Db, actor: Actor, q: ReportsQuery) {
  return db
    .select({
      status: matter.status,
      level: matter.level,
      litigationRole: matter.litigationRole,
      statusSort: sql<number>`(select ${statusConfig.sortOrder} from ${statusConfig}
        where ${statusConfig.hostType} = 'matter' and ${statusConfig.code} = ${matter.status})`,
      levelSort: sql<number>`(select ${riskLevelConfig.sortOrder} from ${riskLevelConfig}
        where ${riskLevelConfig.code} = ${matter.level})`,
      n: sql<number>`count(*)::int`,
    })
    .from(matter)
    .where(
      and(scopeOf("matter", actor), archiveOf("matter", q.archivedOnly), listFilterOf("matter", q)),
    )
    .groupBy(matter.status, matter.level, matter.litigationRole);
}

/** 事项格：`group by 状态, 等级`（事项侧没有"我方诉讼地位"这一列，维度到此为止） */
function riskCells(db: Db, actor: Actor, q: ReportsQuery) {
  return db
    .select({
      status: riskMatter.status,
      level: riskMatter.level,
      statusSort: sql<number>`(select ${statusConfig.sortOrder} from ${statusConfig}
        where ${statusConfig.hostType} = 'risk_matter' and ${statusConfig.code} = ${riskMatter.status})`,
      levelSort: sql<number>`(select ${riskLevelConfig.sortOrder} from ${riskLevelConfig}
        where ${riskLevelConfig.code} = ${riskMatter.level})`,
      n: sql<number>`count(*)::int`,
    })
    .from(riskMatter)
    .where(
      and(
        scopeOf("risk_matter", actor),
        archiveOf("risk_matter", q.archivedOnly),
        listFilterOf("risk_matter", q),
      ),
    )
    .groupBy(riskMatter.status, riskMatter.level);
}

/** 行顺序：状态按配置序、等级按配置序，最后用 code 兜底（配置里没有的历史 code 也要有确定位置） */
function byConfigOrder<
  T extends { status: string; statusSort: number; level: string; levelSort: number },
>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      a.statusSort - b.statusSort ||
      a.status.localeCompare(b.status) ||
      a.levelSort - b.levelSort ||
      a.level.localeCompare(b.level),
  );
}

/** 诉讼地位的列顺序取枚举表 E12 的顺序：与详情页、下拉框看到的是同一个次序 */
function roleRank(code: string): number {
  const i = (LITIGATION_ROLES as readonly string[]).indexOf(code);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

function shapeMatters(rows: MatterCellRow[]): MatterMatrix {
  const roleTotals: Record<string, number> = {};
  const statusTotals: Record<string, number> = {};
  const out: MatterMatrix["rows"] = [];
  const index = new Map<string, MatterMatrix["rows"][number]>();
  let total = 0;

  for (const c of byConfigOrder(rows)) {
    roleTotals[c.litigationRole] = (roleTotals[c.litigationRole] ?? 0) + c.n;
    statusTotals[c.status] = (statusTotals[c.status] ?? 0) + c.n;
    total += c.n;
    // 同一个 (状态, 等级) 的格子聚成一行：行键是这两维，列是诉讼地位
    const key = `${c.status}\u0000${c.level}`;
    let row = index.get(key);
    if (!row) {
      row = { status: c.status, statusTotal: 0, level: c.level, total: 0, counts: {} };
      index.set(key, row);
      out.push(row);
    }
    row.counts[c.litigationRole] = c.n;
    row.total += c.n;
  }
  // 状态小计要等所有等级都聚完才知道（界面用它画合并单元格里的"共 N 条"）
  for (const row of out) row.statusTotal = statusTotals[row.status] ?? 0;

  return {
    total,
    roles: Object.keys(roleTotals)
      .sort((a, b) => roleRank(a) - roleRank(b) || a.localeCompare(b))
      .map((code) => ({ code, total: roleTotals[code] ?? 0 })),
    rows: out,
  };
}

function shapeRisks(rows: RiskCellRow[]): RiskMatrix {
  const levelTotals: Record<string, number> = {};
  const levelSort = new Map<string, number>();
  const out: RiskMatrix["rows"] = [];
  const index = new Map<string, RiskMatrix["rows"][number]>();
  let total = 0;

  for (const c of byConfigOrder(rows)) {
    levelTotals[c.level] = (levelTotals[c.level] ?? 0) + c.n;
    levelSort.set(c.level, c.levelSort);
    total += c.n;
    let row = index.get(c.status);
    if (!row) {
      row = { status: c.status, total: 0, counts: {} };
      index.set(c.status, row);
      out.push(row);
    }
    row.counts[c.level] = c.n;
    row.total += c.n;
  }

  return {
    total,
    levels: Object.keys(levelTotals)
      .sort((a, b) => (levelSort.get(a) ?? 0) - (levelSort.get(b) ?? 0) || a.localeCompare(b))
      .map((code) => ({ code, total: levelTotals[code] ?? 0 })),
    rows: out,
  };
}

/* ──────────────────────────── 卡②：节点到期 ──────────────────────────── */

type NodeBucketRow = { kind: string; bucket: string; n: number };

/**
 * 到期分档计数：两张节点表 `union all` 后一次 `group by`。
 *
 * 两个分支逐字对称（同构表对，见文件头注），每边都带自己宿主的范围谓词与归档谓词——
 * 节点自己没有范围列，可见性**跟着宿主走**（与工作台的活动日志同一条理由：
 * 能看见这条案卷才看得见它的节点，否则报表会变成案卷存在性的侧信道）。
 */
async function nodeBuckets(db: Db, actor: Actor, q: ReportsQuery): Promise<NodeBucketRow[]> {
  return db.execute<NodeBucketRow>(sql`
    with scanned as (
      select 'matter' as kind, ${bucketCase(matterNode)} as bucket
      from ${matterNode}
      inner join ${matter} on ${matter.id} = ${matterNode.hostId}
      where ${scopeOf("matter", actor)} and ${archiveOf("matter", q.archivedOnly)}
        and ${nodeScan(matterNode)}
        and ${listFilterOf("matter", q)}
      union all
      select 'risk_matter' as kind, ${bucketCase(riskMatterNode)} as bucket
      from ${riskMatterNode}
      inner join ${riskMatter} on ${riskMatter.id} = ${riskMatterNode.hostId}
      where ${scopeOf("risk_matter", actor)} and ${archiveOf("risk_matter", q.archivedOnly)}
        and ${nodeScan(riskMatterNode)}
        and ${listFilterOf("risk_matter", q)}
    )
    select kind, bucket, count(*)::int as n
    from scanned
    group by kind, bucket
  `);
}

function shapeNodes(rows: NodeBucketRow[]): NodeDeadlineCard {
  const counts = new Map<string, Record<string, number>>();
  const bucketTotals: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const cell = counts.get(r.kind) ?? {};
    cell[r.bucket] = Number(r.n);
    counts.set(r.kind, cell);
    bucketTotals[r.bucket] = (bucketTotals[r.bucket] ?? 0) + Number(r.n);
    total += Number(r.n);
  }
  return {
    total,
    buckets: DEADLINE_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
    // 两个宿主恒各一行（含 0）：界面不用判"这行有没有出现"，合计行也不会因缺行算少。
    // 集合引 `HOST_TYPES` 而不写第二份字面量 —— 见 `selectable-users.ts` 里同一条理由。
    rows: HOST_TYPES.map((kind) => {
      const cell = counts.get(kind) ?? {};
      return {
        kind,
        counts: cell,
        total: DEADLINE_BUCKETS.reduce((acc, b) => acc + (cell[b.key] ?? 0), 0),
      };
    }),
    bucketTotals,
  };
}

/* ──────────────────────────────── 出口 ──────────────────────────────── */

/**
 * 两张卡一起给：列表页一次请求拿到全部格子（同一次查询时刻，两张卡不会互相错开）。
 * 三个聚合查询并发发出去——它们之间没有依赖。
 *
 * 界面只画自己宿主那一张矩阵（案件列表画案件矩阵、事项列表画事项矩阵），但**两张矩阵都算**
 * ——它们在同一个响应里，读者看到的是同一时刻的两个读数，而不是"先看案件、两秒后看事项"。
 */
export async function reports(actor: Actor, q: ReportsQuery): Promise<ReportsPayload> {
  const db = await getDb();
  const [matters, risks, nodes] = await Promise.all([
    matterCells(db, actor, q),
    riskCells(db, actor, q),
    nodeBuckets(db, actor, q),
  ]);
  return {
    archivedOnly: q.archivedOnly,
    matters: shapeMatters(matters),
    risks: shapeRisks(risks),
    nodes: shapeNodes(nodes),
  };
}

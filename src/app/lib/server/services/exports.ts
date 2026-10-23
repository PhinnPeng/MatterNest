import { and, asc, eq, sql } from "drizzle-orm";
import {
  EXPENSE_STATUS_LABELS,
  LITIGATION_ROLE_LABELS,
  NODE_SOURCE_KIND_LABELS,
  NODE_STATUS_LABELS,
  PARTY_TYPE_LABELS,
  PROGRESS_TYPE_LABELS,
  TIME_TYPE_LABELS,
} from "@/shared/enums/business";
import { getDb } from "../db/client";
import {
  expenseItemConfig,
  matter,
  matterExpense,
  matterNode,
  matterParty,
  matterProgress,
  party,
  riskLevelConfig,
  riskMatter,
  riskMatterExpense,
  riskMatterNode,
  riskMatterParty,
} from "../db/schema";
import { decryptField } from "../crypto/field-crypto";
import { scopedWhere, type HostKind } from "../scope/visibility";
import { hostStatusRows } from "./statuses";
import { logActivity } from "./activity";
import type { Actor } from "../auth/auth";

/**
 * 导出的**公共件**（US-42 / IQ-12 的第三重防线）：脱敏规则、CSV 编码、`EXPORT` 载荷、
 * 以及"整卷导出"本身。
 *
 * ## 为什么这些必须只有一处实现
 *
 * 本仓已有两档导出：当事人档案（MATT-40 的 `parties.ts` 的 `exportParties`）与整卷
 * （本文件的 `exportHostFile`）。它们共享三件东西，每一件各写一份都会**静默漂移**：
 *
 *   1. **脱敏规则**（`maskValue`）：留尾四位。两处各写一遍，某天一处改成"留前两位"，
 *      另一处不改 —— 两条导出链路对同一份证件号给出两种脱敏结果，而两边都不报错；
 *   2. **CSV 编码**（`csvCell` / `csvText`）：引号、逗号、换行、BOM。这份文本要在
 *      Excel 里打开，写错一个引号就串列，且只在含逗号的备注上出现；
 *   3. **`EXPORT` 载荷**（`exportAuditPayload`）：`{target_type, scope, rows, count?, plain}`。
 *      载荷形状是事后审计的查询契约（"所有明文导出"要能一条 SQL 捞出来），
 *      两处形状不一致等于审计口径有两个。
 *
 * ⚠ 服务层不再判 `can_read_plain`：那是 HTTP 层的特权口径（`http.ts` 的 `requirePrivilege`），
 * 服务层再判一次就会出现两套口径（与 `exportParties` 同一条理由）。
 */

/**
 * 脱敏：**只留尾四位**。短于五位的一律全遮 —— 留两位等于没遮。
 *
 * 这是**导出档**的写法，不是展示层：展示层全明文（IQ-12），两者不要互相借用。
 */
export function maskValue(v: string | null): string {
  if (!v) return "";
  const s = v.trim();
  if (s.length <= 4) return "****";
  return `****${s.slice(-4)}`;
}

/** CSV 单元格：逗号/引号/换行都要包起来，换行折成空格（Excel 里一行一条才对得上） */
export function csvCell(v: string): string {
  const s = v.replace(/\r?\n/g, " ");
  return /[",\s]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 拼 CSV 文本（**服务端**拼，浏览器只负责下载）。
 *
 * BOM 是给 Excel 的：没有它，中文表头在 Windows 版 Excel 里是乱码。
 * 行分隔一律 `\r\n`（RFC 4180；`\n` 在部分 Excel 版本里会把两行并成一行）。
 */
export function csvText(lines: readonly (readonly string[])[]): string {
  return `\uFEFF${lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n")}`;
}

/**
 * `EXPORT` 的载荷形状。
 *
 * `rows` 与 `count` 是**两个量纲**，不是同一个数的两种写法：
 *   · `rows`  —— 本次导出写出的**数据行数**（不含区段标题与表头行）；
 *   · `count` —— 本次导出覆盖的**案卷件数**。单卷导出恒为 1；列表类导出（当事人档案）
 *                没有"件"这个量纲，所以它**不写**这一项，形状仍然是同一个类型。
 *
 * 载荷**绝不记行内容**（枚举表 §3.3 与权限草案 §7.3 的既有禁令）：审计要能回答
 * "谁在什么时候导出了多少行、是不是明文"，不需要把导出内容再存一份 ——
 * 那等于把敏感数据复制到一个权限更宽的表里。
 */
export type ExportAuditPayload = {
  target_type: string;
  scope: string;
  rows: number;
  plain: boolean;
  count?: number;
};

export function exportAuditPayload(p: {
  targetType: string;
  scope: string;
  rows: number;
  plain: boolean;
  count?: number;
}): ExportAuditPayload {
  return {
    target_type: p.targetType,
    scope: p.scope,
    rows: p.rows,
    plain: p.plain,
    ...(p.count === undefined ? {} : { count: p.count }),
  };
}

/** 每个区段最多导出的行数。超了就把 `truncated` 置真 —— 静默截断等于骗人 */
export const EXPORT_SECTION_LIMIT = 1000;

/**
 * **列表类导出**的审计落点：操作者账号维度（`target_type='app_user'`，不挂宿主列）。
 *
 * 当事人档案动作（`parties.ts` 里那个 `partyAuditLanding` 是它的别名）与两份列表导出
 * 共用这一处 —— 三处各写一遍的下场是某天一处换了落点、另一处没换，而两边都"看着对"。
 *
 * ## 为什么是这个落点（一处已知偏差，理由与代价写在这里）
 *
 *   · E03 `target_type` 的 7 个取值里没有"列表"这个概念，`ck_mn_activity_host` 又要求
 *     "日志必须挂在案件/事项上（`app_user` 除外）"——一份**跨宿主**的导出清单
 *     挂到哪一个案件上都是**说谎**（那条日志与那个案件无关）；
 *   · 迁移 0006 为账号动作开的那个口子（`target_type='app_user'` + 不挂宿主）
 *     是既有唯一"无业务宿主"的合法落点，于是它承接列表导出，
 *     `payload.target_type` 里写清**导出的是什么**（`matter` / `risk_matter`）；
 *   · 正确修法是给 E03 加一个列表/批次的维度（注册表 + 文档 + 迁移三向同批），
 *     那三处都不在本票写范围内，已写进交付报告。
 *
 * ⚠ 别把它换成"挂到第一条导出的记录上"：那会让这条审计出现在某个案件的活动日志里，
 * 读起来像"这个案件被导出了"，而实际导出的是几十条。
 */
export function listExportLanding(actor: Actor): { targetType: string; targetId: bigint } {
  return { targetType: "app_user", targetId: BigInt(actor.userId) };
}

/**
 * 状态与风险等级的中文名字典 —— 这两份是**配置驱动**的（枚举表 §0，运营可改名），
 * 列表页从 `/api/meta` 取，导出自己查一次。
 *
 * 抽到公共件是因为两个宿主列表导出都要它，而"各查一遍"会漂成两份不同口径的
 * 「进行中」文案。`hostStatusRows` 已经是状态读取的**唯一出口**（`/api/meta` 也走它），
 * 这里不自己 select `mn_status_config`。
 */
export async function configNameDict(
  host: HostKind,
): Promise<{ statusNames: Record<string, string>; levelNames: Record<string, string> }> {
  const db = await getDb();
  const [statuses, levels] = await Promise.all([
    hostStatusRows(host),
    db
      .select({ code: riskLevelConfig.code, name: riskLevelConfig.name })
      .from(riskLevelConfig)
      .orderBy(asc(riskLevelConfig.sortOrder)),
  ]);
  return {
    statusNames: Object.fromEntries(statuses.map((s) => [s.code, s.name])),
    levelNames: Object.fromEntries(levels.map((l) => [l.code, l.name])),
  };
}

/** 一段 CSV：标题行 + 表头行 + 数据行 */
type Section = { title: string; header: readonly string[]; rows: readonly (readonly string[])[] };

function sectionLines(s: Section): string[][] {
  return [[`[${s.title}]`], [...s.header], ...s.rows.map((r) => [...r])];
}

export type HostFileExport = {
  plain: boolean;
  /** 数据行数（不含区段标题与表头行）——与 `EXPORT` 载荷的 `rows` 同一个数 */
  rows: number;
  /** 案卷件数：单卷导出恒 1 */
  count: number;
  /** 某一段被 `EXPORT_SECTION_LIMIT` 截断过 */
  truncated: boolean;
  csv: string;
};

/**
 * 整卷导出（US-42）：一条案件/事项的全部事实 + 两档。
 *
 * ## 两档差在哪
 *
 * 只差**加密列**：当事人的证件号与联系方式。其余字段本来就是展示层全明文（IQ-12），
 * 没有第二处需要脱敏的东西 —— 所以"两档"不是两套导出实现，而是同一份数据在
 * 写 CSV 前经过一次 `maskValue` 或不经过。这条口径与当事人导出逐字相同。
 *
 * ## 可见性
 *
 * 宿主行先过 `scopedWhere`（全项目唯一一处范围谓词）：看不见就是 `null` → 路由给 404，
 * 与"不存在"同一个响应（权限草案 §1 元规则 3）。从属行只在宿主可见之后才查 ——
 * 反过来写（先查从属再过滤）就会出现"导出比详情页多给几行"。
 *
 * ## 审计
 *
 * **一次导出记一条 `EXPORT`**（不是一行记一条），落在宿主维度上：
 * `matter_id` / `risk_matter_id` 有值，`target_type` 是宿主类型 —— 这样它同时出现在
 * 该案卷的活动日志里。载荷见 `exportAuditPayload`，**不含内容**。
 */
export async function exportHostFile(
  actor: Actor,
  host: HostKind,
  hostId: string,
  opts: { plain: boolean },
): Promise<HostFileExport | null> {
  const db = await getDb();
  const id = BigInt(hostId);
  const sections: Section[] = [];
  let truncated = false;
  const cap = (n: number) => {
    if (n > EXPORT_SECTION_LIMIT) truncated = true;
    return n > EXPORT_SECTION_LIMIT;
  };
  /**
   * 加密列的两档写法 —— **整卷导出里两档的唯一差别**。
   * 明文档解密后原样给出；脱敏档过 `maskValue`（只留尾四位）。
   * 写成一个函数而不是在两处三元：这条规则与当事人导出共用同一个 `maskValue`，
   * 而"哪几列算敏感列"也只在这里决定一次。
   */
  const twoTier = (v: string | null) =>
    opts.plain ? (decryptField(v) ?? "") : maskValue(decryptField(v));

  if (host === "matter") {
    const [row] = await db
      .select()
      .from(matter)
      .where(scopedWhere("matter", actor, eq(matter.id, id)))
      .limit(1);
    if (!row) return null;

    sections.push({
      title: "案件",
      header: ["字段", "值"],
      rows: [
        ["内部编号", row.internalCode],
        ["正式案号", row.caseNo],
        ["名称", row.name],
        ["案由", row.cause],
        ["案件类型", row.caseType],
        ["审级/程序", row.procedure],
        ["我方诉讼地位", row.litigationRole],
        ["受理法院", row.court ?? ""],
        ["标的额", row.amount],
        ["风险等级", row.level],
        ["状态", row.status],
        ["立案日期", row.filingDate ?? ""],
        ["结案日期", row.closingDate ?? ""],
        ["是否归档", row.isArchived ? "是" : "否"],
        ["归档时间", row.archivedAt ?? ""],
        ["基本情况", row.description ?? ""],
        ["更新时间", row.updatedAt],
      ],
    });

    const links = await db
      .select({
        partyRole: matterParty.partyRole,
        sortOrder: matterParty.sortOrder,
        name: party.name,
        type: party.type,
        idNumber: party.idNumber,
        contact: party.contact,
      })
      .from(matterParty)
      .innerJoin(party, eq(party.id, matterParty.partyId))
      .where(eq(matterParty.hostId, id))
      .orderBy(asc(matterParty.sortOrder), asc(matterParty.id))
      .limit(EXPORT_SECTION_LIMIT + 1);
    const partyRows = links.slice(0, EXPORT_SECTION_LIMIT);
    truncated ||= cap(links.length);
    sections.push({
      title: "当事人",
      header: ["名称", "类型", "诉讼地位", "证件号", "联系方式"],
      rows: partyRows.map((p) => [
        p.name,
        PARTY_TYPE_LABELS[p.type as keyof typeof PARTY_TYPE_LABELS] ?? p.type,
        LITIGATION_ROLE_LABELS[p.partyRole as keyof typeof LITIGATION_ROLE_LABELS] ?? p.partyRole,
        // 两档的唯一差别就在这两列
        twoTier(p.idNumber),
        twoTier(p.contact),
      ]),
    });

    const nodeRows = await db
      .select({
        name: matterNode.name,
        timeType: matterNode.timeType,
        startTime: matterNode.startTime,
        endTime: matterNode.endTime,
        deadlineTime: matterNode.deadlineTime,
        status: matterNode.status,
        sourceKind: matterNode.sourceKind,
        remark: matterNode.remark,
      })
      .from(matterNode)
      .where(and(eq(matterNode.hostId, id), sql`NOT ${matterNode.isDeleted}`))
      .orderBy(asc(matterNode.sortOrder), asc(matterNode.id))
      .limit(EXPORT_SECTION_LIMIT + 1);
    const keptNodes = nodeRows.slice(0, EXPORT_SECTION_LIMIT);
    truncated ||= cap(nodeRows.length);
    sections.push({
      title: "时间节点",
      header: ["名称", "时间形态", "开始", "结束", "期限", "状态", "来源", "备注"],
      rows: keptNodes.map((n) => [
        n.name,
        TIME_TYPE_LABELS[n.timeType as keyof typeof TIME_TYPE_LABELS] ?? n.timeType,
        n.startTime ?? "",
        n.endTime ?? "",
        n.deadlineTime ?? "",
        NODE_STATUS_LABELS[n.status as keyof typeof NODE_STATUS_LABELS] ?? n.status,
        NODE_SOURCE_KIND_LABELS[n.sourceKind as keyof typeof NODE_SOURCE_KIND_LABELS] ??
          n.sourceKind,
        n.remark ?? "",
      ]),
    });

    const progressRows = await db
      .select({
        progressType: matterProgress.progressType,
        progressDate: matterProgress.progressDate,
        content: matterProgress.content,
        nextPlan: matterProgress.nextPlan,
      })
      .from(matterProgress)
      .where(and(eq(matterProgress.matterId, id), sql`NOT ${matterProgress.isDeleted}`))
      .orderBy(asc(matterProgress.progressDate), asc(matterProgress.id))
      .limit(EXPORT_SECTION_LIMIT + 1);
    const keptProgress = progressRows.slice(0, EXPORT_SECTION_LIMIT);
    truncated ||= cap(progressRows.length);
    sections.push({
      title: "案件进展",
      header: ["类型", "日期", "内容", "下一步"],
      rows: keptProgress.map((p) => [
        PROGRESS_TYPE_LABELS[p.progressType as keyof typeof PROGRESS_TYPE_LABELS] ?? p.progressType,
        p.progressDate,
        p.content,
        p.nextPlan ?? "",
      ]),
    });

    const expenses = await loadExpenseRows("matter", id);
    truncated ||= cap(expenses.length);
    sections.push(expenseSection(expenses.slice(0, EXPORT_SECTION_LIMIT)));
  } else {
    const [row] = await db
      .select()
      .from(riskMatter)
      .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, id)))
      .limit(1);
    if (!row) return null;

    sections.push({
      title: "事项",
      header: ["字段", "值"],
      rows: [
        ["编号", row.code],
        ["名称", row.name],
        ["风险类型", row.type],
        ["风险等级", row.level],
        ["来源", row.source ?? ""],
        ["描述", row.description],
        // 「处置措施」「涉及金额」两行已随事项侧那两列一起撤下（迁移 0017）；
        // 「币种」随迁移 0019 撤下：一期只有 CNY，金额口径不需要第二列。
        ["状态", row.status],
        ["发现日期", row.discoverDate],
        ["是否转案件", row.conversionStatus === 1 ? `已转 ${row.convertedCaseCount} 个` : "未转"],
        ["是否归档", row.isArchived ? "是" : "否"],
        ["更新时间", row.updatedAt],
      ],
    });

    const links = await db
      .select({
        partyRole: riskMatterParty.partyRole,
        sortOrder: riskMatterParty.sortOrder,
        name: party.name,
        type: party.type,
        idNumber: party.idNumber,
        contact: party.contact,
      })
      .from(riskMatterParty)
      .innerJoin(party, eq(party.id, riskMatterParty.partyId))
      .where(eq(riskMatterParty.hostId, id))
      .orderBy(asc(riskMatterParty.sortOrder), asc(riskMatterParty.id))
      .limit(EXPORT_SECTION_LIMIT + 1);
    const partyRows = links.slice(0, EXPORT_SECTION_LIMIT);
    truncated ||= cap(links.length);
    sections.push({
      title: "当事人",
      header: ["名称", "类型", "诉讼地位", "证件号", "联系方式"],
      rows: partyRows.map((p) => [
        p.name,
        PARTY_TYPE_LABELS[p.type as keyof typeof PARTY_TYPE_LABELS] ?? p.type,
        LITIGATION_ROLE_LABELS[p.partyRole as keyof typeof LITIGATION_ROLE_LABELS] ?? p.partyRole,
        twoTier(p.idNumber),
        twoTier(p.contact),
      ]),
    });

    const nodeRows = await db
      .select({
        name: riskMatterNode.name,
        timeType: riskMatterNode.timeType,
        startTime: riskMatterNode.startTime,
        deadlineTime: riskMatterNode.deadlineTime,
        status: riskMatterNode.status,
        sourceKind: riskMatterNode.sourceKind,
        remark: riskMatterNode.remark,
      })
      .from(riskMatterNode)
      .where(and(eq(riskMatterNode.hostId, id), sql`NOT ${riskMatterNode.isDeleted}`))
      .orderBy(asc(riskMatterNode.sortOrder), asc(riskMatterNode.id))
      .limit(EXPORT_SECTION_LIMIT + 1);
    const keptNodes = nodeRows.slice(0, EXPORT_SECTION_LIMIT);
    truncated ||= cap(nodeRows.length);
    sections.push({
      title: "事项节点",
      header: ["名称", "时间形态", "开始", "期限", "状态", "来源", "备注"],
      rows: keptNodes.map((n) => [
        n.name,
        TIME_TYPE_LABELS[n.timeType as keyof typeof TIME_TYPE_LABELS] ?? n.timeType,
        n.startTime ?? "",
        n.deadlineTime ?? "",
        NODE_STATUS_LABELS[n.status as keyof typeof NODE_STATUS_LABELS] ?? n.status,
        NODE_SOURCE_KIND_LABELS[n.sourceKind as keyof typeof NODE_SOURCE_KIND_LABELS] ??
          n.sourceKind,
        n.remark ?? "",
      ]),
    });

    const expenses = await loadExpenseRows("risk_matter", id);
    truncated ||= cap(expenses.length);
    sections.push(expenseSection(expenses.slice(0, EXPORT_SECTION_LIMIT)));
  }

  const rows = sections.reduce((acc, s) => acc + s.rows.length, 0);
  const header: string[][] = [
    [opts.plain ? "整卷导出（明文档）" : "整卷导出（脱敏档）"],
    ...sections.flatMap(sectionLines),
  ];
  const csv = csvText(header);

  await db.transaction(async (tx) => {
    await logActivity(tx, actor, {
      matterId: host === "matter" ? id : null,
      riskMatterId: host === "risk_matter" ? id : null,
      targetType: host,
      targetId: id,
      action: "EXPORT",
      payload: exportAuditPayload({
        targetType: host,
        scope: `${host}_file`,
        rows,
        count: 1,
        plain: opts.plain,
      }),
    });
  });

  return { plain: opts.plain, rows, count: 1, truncated, csv };
}

/** 费用行（含项目名）：两个宿主的列名不同，所以只在这一处分叉 */
async function loadExpenseRows(host: HostKind, hostId: bigint) {
  const db = await getDb();
  if (host === "matter") {
    return db
      .select({
        itemName: expenseItemConfig.name,
        amount: matterExpense.amount,
        occurredDate: matterExpense.occurredDate,
        status: matterExpense.status,
        remark: matterExpense.remark,
      })
      .from(matterExpense)
      .innerJoin(expenseItemConfig, eq(expenseItemConfig.id, matterExpense.itemId))
      .where(and(eq(matterExpense.hostId, hostId), sql`NOT ${matterExpense.isDeleted}`))
      .orderBy(asc(matterExpense.occurredDate), asc(matterExpense.id))
      .limit(EXPORT_SECTION_LIMIT + 1);
  }
  return db
    .select({
      itemName: expenseItemConfig.name,
      amount: riskMatterExpense.amount,
      occurredDate: riskMatterExpense.occurredDate,
      status: riskMatterExpense.status,
      remark: riskMatterExpense.remark,
    })
    .from(riskMatterExpense)
    .innerJoin(expenseItemConfig, eq(expenseItemConfig.id, riskMatterExpense.itemId))
    .where(and(eq(riskMatterExpense.hostId, hostId), sql`NOT ${riskMatterExpense.isDeleted}`))
    .orderBy(asc(riskMatterExpense.occurredDate), asc(riskMatterExpense.id))
    .limit(EXPORT_SECTION_LIMIT + 1);
}

/** 费用区段。金额是 `numeric` 的原样字符串（两位小数），导出**不重算**、不格式化 */
function expenseSection(
  rows: readonly {
    itemName: string;
    amount: string;
    occurredDate: string;
    status: string;
    remark: string | null;
  }[],
): Section {
  return {
    title: "费用",
    header: ["费用项目", "金额", "发生日期", "状态", "备注"],
    rows: rows.map((e) => [
      e.itemName,
      e.amount,
      e.occurredDate,
      EXPENSE_STATUS_LABELS[e.status as keyof typeof EXPENSE_STATUS_LABELS] ?? e.status,
      e.remark ?? "",
    ]),
  };
}

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "../db/client";
import { matter, matterNode } from "../db/schema";
import { NODE_OPEN_STATUSES } from "@/shared/enums/business";

/**
 * 归档完备性判定（F2-26 / G4 的功能载体，IQ-16）。
 *
 * ## 这项判定只实现一次，两个读出口从它取数
 *
 * 出口一：案件详情页「归档就绪」卡（`judgeArchiveReadiness`，逐项红绿）。
 * 出口二：案件列表「已结案缺材料」筛选（`archiveMissingSql`，一条 SQL 谓词）。
 *
 * 两个出口各写一份判定是这条 AC 最容易走歪的地方——两份判定的漂移**不会报错**，
 * 只会让"列表说有缺、详情页说齐备"同时成立，而用户只会信其中一个。
 * 所以两份都住在本文件里、相邻摆放；`smoke-archive.mjs` 里有一条
 * **两出口一致性断言**（详情页判为缺的案件，列表筛选必须也能找到它）。
 *
 * ## 三项校验
 *
 * ① 裁判文书类附件 ≥1（`attachment.category='judgment'`）
 * ② `closing_date` 已填
 * ③ 无待定未决节点（`*_node.status ∈ NODE_OPEN_STATUSES`）
 *
 * **仅案件侧**：事项没有材料完整要求（与"事项是台账"一致），所以本文件只认 `matter`。
 *
 * ## 第①项为什么仍是 `unavailable`（虽然附件通道已打通）
 *
 * 2026-10-22 附件通道已经落地（`mn_attachment` + MinIO），但**这一项还判不了**：
 * 判定要的是 `attachment.category='judgment'`，而目前的唯一入口是评论附件，
 * 它不产生分类（`category` 为 NULL）。换句话说，数据源有了，**"这份是判决书"这个事实
 * 还没有地方可以输入** —— 按 `category` 查会恒得 0，那就等于把每一条案件都判成缺材料。
 *
 * 它不能算绿（那是假齐备），也不能算红（假红会污染 G4 指标「归档材料完整率」——
 * 那个指标的唯一数据源就是 `missing_at_archive`）。所以继续单列 `unavailable`。
 *
 * 槽位仍在原位：等附件页签（能选分类）落地后，把这一项的 `state` 从 `unavailable`
 * 换成对 `mn_attachment` 的查询——判定结构、落库字段、两个出口都不用动。
 */

/** 事务句柄：从 `transaction` 的回调参数上取，比自己拼 PgTransaction 泛型稳（仓内既有写法） */
type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

/**
 * 三项校验的**判定键**（本文件是它的**源头声明**，刻意不从 shared 推导）。
 *
 * ⚠ 同一件事在通知那边还有第二套词汇（B5 的 `judgment_doc`/`closing_date`/`pending_nodes`），
 * 两套之间的翻译**单一来源**在 `@/shared/notification/template` 的 `READINESS_SEAM`——
 * 那张表是推导出来的，而这里这份联合是**手写的**。所以两边各改一处时会漂移，
 * 抓住它的是 `archive-reminder.spec.ts`（拿本文件的 `READINESS_CHECKS` 逐键比对那张表）。
 * 别把这里也改成从 shared 推导：两侧同源之后那条比对断言就成了永真。
 *
 * MATT-70 说明了为什么两套词汇都留着（两套都已写进 jsonb 里的历史行，统一口径要回填审计事实）。
 */
export type ReadinessCheckKey = "judgment" | "closingDate" | "openNodes";

/** `unavailable` 是第三种状态：不是"红"也不是"绿"——见文件头注 */
export type CheckState = "ok" | "missing" | "unavailable";

export type ReadinessCheck = {
  key: ReadinessCheckKey;
  state: CheckState;
  /** `unavailable` 时说明为什么（目前只有附件那一项会用到） */
  reason?: "attachment_not_built";
  /** `missing` 时的补充事实（如未决节点数），供界面把话说具体 */
  count?: number;
};

export type ArchiveReadiness = {
  checks: ReadinessCheck[];
  /** 落库用：判为缺的项。**空数组不等于齐备**——还要看 `unavailable` */
  missing: ReadinessCheckKey[];
  /** 落库用：没有数据源、这次没判的项 */
  unavailable: ReadinessCheckKey[];
  /**
   * **已判项**是否全部齐备（即 `missing` 为空）。
   *
   * ⚠ 它**不**等于"三项齐备"——附件那项没有数据源（`unavailable`），所以界面必须说
   * "已判的两项齐备"，不能说"三项齐备"。这个字段曾经写成 `checks.every(ok)`，
   * 而第①项恒为 `unavailable` ⇒ **它恒为 false**，于是详情卡永远说"缺项"、
   * 归档弹窗对同一条案件说"三项都齐备"——同一个判定的两个显示面互相矛盾（检查子代理抓到的）。
   * 现在两边都用同一个口径：`missing.length === 0` ⇒ 已判项齐备。
   */
  ready: boolean;
};

/** 三项的固定顺序与中文名（界面与落库共用一份，不各写一遍） */
export const READINESS_CHECKS: readonly { key: ReadinessCheckKey; label: string }[] = [
  { key: "judgment", label: "裁判文书已归档" },
  { key: "closingDate", label: "结案日期已填" },
  { key: "openNodes", label: "无未决时间节点" },
];

/**
 * 判定一条案件的归档完备性。传 `tx` 时复用调用方的事务连接
 * （事务内再向池子要一条连接会互等成死锁，这条在本仓有前例）。
 *
 * 查不到这条案件时返回 `null` —— 调用方负责给 404（可见性判定在 `scopedWhere` 那边，
 * 本函数不做权限判断）。
 */
export async function judgeArchiveReadiness(
  conn: Conn,
  matterId: string,
): Promise<ArchiveReadiness | null> {
  const [row] = await conn
    .select({ closingDate: matter.closingDate })
    .from(matter)
    .where(eq(matter.id, BigInt(matterId)))
    .limit(1);
  if (!row) return null;

  /**
   * 未决节点数**单独一条查询**，不写成关联子查询。
   *
   * ⚠ 这里踩过一个只有真库能现形的坑：关联子查询写在 **select 列表**里时，drizzle 把
   * `${matter.id}` 渲染成**无限定**的 `"id"`（它假定单表 select 不必带表名前缀），
   * 而子查询自己就有一张带 `id` 的表 ⇒ `n.matter_id = "id"` 被解析成 `n.matter_id = n.id`，
   * **恒假**，计数恒为 0。类型检查、代码审阅、静态分析全都看不出来。
   * 同一个 `${matter.id}` 写在 **where 上下文**里却会渲染成 `"mn_matter"."id"`（正确）——
   * 所以 `archiveMissingSql` 那条是好的，坏的只有这一处。
   * 教训：**跨表关联不要靠模板里的列引用**，用类型化列引用另起一条查询。
   */
  const [nodeRow] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(matterNode)
    .where(
      and(
        eq(matterNode.hostId, BigInt(matterId)),
        sql`not ${matterNode.isDeleted}`,
        inArray(matterNode.status, [...NODE_OPEN_STATUSES]),
      ),
    );
  const openNodes = Number(nodeRow?.n ?? 0);

  const checks: ReadinessCheck[] = [
    // ① 附件：见文件头注（表已建，但还没有"给附件分类"的入口 ⇒ 仍暂不可判）
    { key: "judgment", state: "unavailable", reason: "attachment_not_built" },
    { key: "closingDate", state: row.closingDate ? "ok" : "missing" },
    { key: "openNodes", state: openNodes === 0 ? "ok" : "missing", count: openNodes },
  ];

  const missing = checks.filter((c) => c.state === "missing").map((c) => c.key);
  return {
    checks,
    missing,
    unavailable: checks.filter((c) => c.state === "unavailable").map((c) => c.key),
    // 见类型上的注释：`ready` 的口径是"已判项齐备"，不是"三项齐备"
    ready: missing.length === 0,
  };
}

/**
 * 列表出口：**已结案且缺材料**的案件。
 *
 * 与 `judgeArchiveReadiness` 是同一条判定的两种形态（一个是逐项状态、一个是 SQL 谓词），
 * 所以放在同一个文件里相邻摆放。第①项在两边都不参与判定（表未建）——
 * 这一点也必须一致：**列表筛选不能悄悄把附件那项算进来**。
 *
 * ⚠ 只收"已归档"的案件：未归档的缺材料不是问题，是"还在办"。
 */
export function archiveMissingSql(): SQL {
  return and(
    eq(matter.isArchived, true),
    sql`(
      ${matter.closingDate} is null
      or exists (
        select 1 from ${matterNode} n
        where n.matter_id = ${matter.id} and not n.is_deleted
          and ${inArray(sql`n.status`, [...NODE_OPEN_STATUSES])}
      )
    )`,
  ) as SQL;
}

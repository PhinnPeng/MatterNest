import { and, asc, count as dcount, desc, eq, sql } from "drizzle-orm";
import { EXPENSE_STATUS_LABELS, type ExpenseStatus } from "@/shared/enums/business";
import type { z } from "zod";
import { nextId } from "@/shared/ids/snowflake";
import type { expenseCreateSchema, expenseUpdateSchema } from "@/shared/schema/expenses";
import { getDb } from "../db/client";
import {
  expenseItemConfig,
  matter,
  matterExpense,
  riskMatter,
  riskMatterExpense,
} from "../db/schema";
import { scopedWhere, type HostKind } from "../scope/visibility";
import { logActivity } from "./activity";
import type { Actor } from "../auth/auth";

/**
 * 费用（US-41 / 基线 4.6「仅支出」）。
 *
 * ## 三条口径
 *
 *   1. **可见性只有一个出口**：宿主行先过 `scopedWhere`，从属行只在宿主可见之后才查。
 *      服务层不拼第二份范围条件（禁令：仓储与页面不许自己拼可见性条件）。
 *   2. **明细不加归属护栏**（权限草案 §2.2 护栏 2，`scope/guards.ts` 头注点名了费用）：
 *      能看到宿主就能写它的明细。写成第二道判定反而会误伤 —— "能看就能写明细"是原文。
 *   3. **金额全程字符串**：列是 `numeric(18,2)`，合计在 SQL 里 `sum()`，
 *      出口 `::numeric(18,2)::text`。JS 里**一次 `Number()` 都没有** ——
 *      `Number("0.10")` 之后再 `String()` 得到 `"0.1"`，两位小数这个刻度就丢了，
 *      而它不会报错（修订稿 §12.2）。
 *
 * ## 归档态
 *
 * 归档是只读终态（§5.2）：**读照常、写一律拒**（`why: "archived"` → 403），
 * 与节点、参与人名单同一口径。注意**结案不是归档** —— US-35「结案后仍能追加费用」
 * （执行回款到账、终本裁定）说的是 `semantics=closed`，那条路上 `is_archived` 仍是 false，
 * 所以本判定不挡它。
 */

/** 费用表的 TS 视图：两张同构表由同一个工厂产出，列名逐个相同（只有 DB 侧宿主列名不同） */
type ExpenseTable = typeof matterExpense;

/**
 * 宿主 → 费用表。
 *
 * ⚠ **全仓唯一一处把两张同构表当同一张用**，是一次刻意的类型收窄：
 * `expenseTable()` 工厂保证两边的 TS 列名完全一致（宿主外键在 TS 侧两边都叫 `hostId`，
 * 只有 DB 列名是 `matter_id` / `risk_matter_id`），所以每条查询只写一遍是安全的 ——
 * 而写两遍的代价是"以后只给一侧改条件"这种静默漂移。
 * 运行时拿到的仍是真实的那张表（断言在编译后被擦除），SQL 里的列名因此是对的。
 */
const EXPENSE_TABLES: Record<HostKind, ExpenseTable> = {
  matter: matterExpense,
  risk_matter: riskMatterExpense as unknown as ExpenseTable,
};

function expenseTableOf(host: HostKind): ExpenseTable {
  return EXPENSE_TABLES[host];
}

/** 宿主行（判可见性 + 归档位）。`null` = 看不见或不存在 → 路由给 404 */
async function loadHost(actor: Actor, host: HostKind, hostId: string) {
  const db = await getDb();
  const id = BigInt(hostId);
  if (host === "matter") {
    const [row] = await db
      .select({ id: matter.id, isArchived: matter.isArchived })
      .from(matter)
      .where(scopedWhere("matter", actor, eq(matter.id, id)))
      .limit(1);
    return row ?? null;
  }
  const [row] = await db
    .select({ id: riskMatter.id, isArchived: riskMatter.isArchived })
    .from(riskMatter)
    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * 审计落点。
 *
 * 案件侧用 E03 里那个专门的落点 `matter_expense`（+ 费用行 id），这是枚举表给费用留的位。
 * **事项侧没有对应的枚举值**（E03 只有 `matter_expense`，没有 `risk_matter_expense`），
 * 所以那一侧挂在宿主上（`risk_matter` + 事项 id），费用 id 记进 `field_diffs.expense_id`。
 * 这不是偷懒：往 `matter_expense` 里塞一条事项费用的日志是**说谎**（读日志的人会去找一个
 * 不存在的案件费用），而"给 E03 加一个值"要走注册表 + 文档 + 迁移三向同批，不在本票范围。
 * 已写进交付报告的范围外发现。
 */
function auditLanding(host: HostKind, hostId: bigint, expenseId: bigint) {
  return host === "matter"
    ? { targetType: "matter_expense", targetId: expenseId, matterId: hostId, riskMatterId: null }
    : { targetType: "risk_matter", targetId: hostId, matterId: null, riskMatterId: hostId };
}

/* ───────────────────────── 费用项目配置（只读） ───────────────────────── */

/**
 * 费用项目清单（基线 7.6 / 枚举表 §0「配置驱动」）。
 *
 * **只读**：配置页（P16 `/settings/expense-items`）归 M5，本票不提供写接口。
 * 返回**含停用项**并带 `isEnabled`：停用只是"新费用不能再选它"，而历史费用仍然指着它，
 * 详情与导出要能把名字显示出来（只回启用项会让老费用显示成空白项目）。
 * 选择器那一侧按 `isEnabled` 过滤 —— 判定只有一份数据，两个读法。
 *
 * 读全体登录用户可用（M5 口径：配置写要 `can_manage_config`，读不需要）。
 */
export async function listExpenseItems(actor: Actor) {
  void actor; // 读全体登录可用；留着参数是为了与写路径同签名（actor 一律第一个参数）
  const db = await getDb();
  const rows = await db
    .select({
      id: expenseItemConfig.id,
      code: expenseItemConfig.code,
      name: expenseItemConfig.name,
      sortOrder: expenseItemConfig.sortOrder,
      isEnabled: expenseItemConfig.isEnabled,
    })
    .from(expenseItemConfig)
    .orderBy(asc(expenseItemConfig.sortOrder), asc(expenseItemConfig.id));
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

/** 费用项目可用性：不存在或已停用都不接受新写入（"费用项目走配置"的闸门） */
async function checkItemUsable(itemId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: expenseItemConfig.id, name: expenseItemConfig.name })
    .from(expenseItemConfig)
    .where(and(eq(expenseItemConfig.id, BigInt(itemId)), eq(expenseItemConfig.isEnabled, true)))
    .limit(1);
  return row ?? null;
}

/* ───────────────────────────── 读 ───────────────────────────── */

export type ExpenseListQuery = { page: number; pageSize: number };

/**
 * 宿主下的费用列表 + **合计**（`SUM(amount)`）+ **按项目分组**（F2-13）。
 *
 * 合计与分组都是**整卷口径**（不受分页影响）：用户问的是"这条案子花了多少"，
 * 只算当页会给出一个随分页变化的数字 —— 那比不给更糟。
 */
export async function listExpenses(
  actor: Actor,
  host: HostKind,
  hostId: string,
  q: ExpenseListQuery,
) {
  const hostRow = await loadHost(actor, host, hostId);
  if (!hostRow) return null;
  const db = await getDb();
  const t = expenseTableOf(host);
  const id = BigInt(hostId);
  const where = and(eq(t.hostId, id), sql`NOT ${t.isDeleted}`);

  const [totalRow] = await db.select({ n: dcount() }).from(t).where(where);
  const rows = await db
    .select({
      id: t.id,
      itemId: t.itemId,
      amount: t.amount,
      occurredDate: t.occurredDate,
      status: t.status,
      remark: t.remark,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      itemName: sql<string>`(select c.name from mn_expense_item_config c where c.id = ${t.itemId})`,
    })
    .from(t)
    .where(where)
    .orderBy(desc(t.occurredDate), desc(t.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  /**
   * 合计：`sum()` 在 SQL 里做，出口 `::numeric(18,2)::text`。
   *
   * `coalesce(..., 0)` 是必要的：空集的 `sum()` 是 NULL，而"没有费用"与"合计 0.00"
   * 在界面上是同一句话，给 NULL 会让前端各写一次兜底。`::numeric(18,2)` 把刻度钉成
   * 两位小数（`0.30` 而不是 `0.3`）—— 这正是 float 会在 `::float8` 那一步丢掉的东西。
   */
  const [totals] = await db
    .select({
      sum: sql<string>`coalesce(sum(${t}.amount), 0)::numeric(18,2)::text`,
      n: sql<number>`count(*)::int`,
    })
    .from(t)
    .where(where);

  // 按项目分组：**不 join 配置表**（join 会把"配置里没被用到的项目"混进来，
  // 也会让 group by 需要两个表的列）。项目名在 JS 侧用同一份只读清单映射。
  const grouped = await db
    .select({
      itemId: t.itemId,
      sum: sql<string>`coalesce(sum(${t}.amount), 0)::numeric(18,2)::text`,
      n: sql<number>`count(*)::int`,
    })
    .from(t)
    .where(where)
    .groupBy(t.itemId);

  const items = await listExpenseItems(actor);
  const nameOf = new Map(items.map((i) => [i.id, i.name]));
  const orderOf = new Map(items.map((i) => [i.id, i.sortOrder]));
  const byItem = grouped
    .map((g) => ({
      itemId: String(g.itemId),
      itemName: nameOf.get(String(g.itemId)) ?? "",
      sum: g.sum,
      count: g.n,
    }))
    .sort((a, b) => (orderOf.get(a.itemId) ?? 0) - (orderOf.get(b.itemId) ?? 0));

  return {
    items: rows.map((r) => ({ ...r, id: String(r.id), itemId: String(r.itemId) })),
    page: q.page,
    pageSize: q.pageSize,
    total: Number(totalRow?.n ?? 0),
    totals: { sum: totals?.sum ?? "0.00", count: totals?.n ?? 0 },
    byItem,
  };
}

/** 单条费用。宿主不可见 → `null`（404），宿主可见但这条不存在/已删/不属于它 → 也 `null` */
export async function getExpense(actor: Actor, host: HostKind, hostId: string, expenseId: string) {
  const hostRow = await loadHost(actor, host, hostId);
  if (!hostRow) return null;
  const db = await getDb();
  const t = expenseTableOf(host);
  const [row] = await db
    .select({
      id: t.id,
      hostId: t.hostId,
      itemId: t.itemId,
      amount: t.amount,
      occurredDate: t.occurredDate,
      status: t.status,
      remark: t.remark,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      itemName: sql<string>`(select c.name from mn_expense_item_config c where c.id = ${t.itemId})`,
    })
    .from(t)
    // 两个 id 必须**同时**对上：父资源 id 只是装饰的写法会让
    // `/api/matters/999/expenses/<别的案子的费用id>` 也能读到（与 setNodeStatus 同一条理由）
    .where(and(eq(t.hostId, BigInt(hostId)), eq(t.id, BigInt(expenseId)), sql`NOT ${t.isDeleted}`))
    .limit(1);
  return row
    ? { ...row, id: String(row.id), hostId: String(row.hostId), itemId: String(row.itemId) }
    : null;
}

/* ───────────────────────────── 写 ───────────────────────────── */

export type ExpenseWriteRejection =
  | { ok: false; why: "not_found" }
  | { ok: false; why: "archived" }
  | { ok: false; why: "item_unavailable"; itemId: string };

export type ExpenseWriteOk = { ok: true; id: string };

export async function createExpense(
  actor: Actor,
  host: HostKind,
  hostId: string,
  input: z.infer<typeof expenseCreateSchema>,
): Promise<ExpenseWriteOk | ExpenseWriteRejection> {
  const hostRow = await loadHost(actor, host, hostId);
  if (!hostRow) return { ok: false, why: "not_found" };
  if (hostRow.isArchived) return { ok: false, why: "archived" };

  const item = await checkItemUsable(input.itemId);
  if (!item) return { ok: false, why: "item_unavailable", itemId: input.itemId };

  const db = await getDb();
  const id = BigInt(nextId());
  const hid = BigInt(hostId);
  const status: ExpenseStatus = input.status ?? "pending_pay";
  const remark = input.remark?.trim() ? input.remark.trim() : null;

  await db.transaction(async (tx) => {
    // 两张表的 values 形状逐个字段相同（宿主列在 TS 侧两边都叫 hostId），所以只写一份
    const values = {
      id,
      hostId: hid,
      itemId: BigInt(input.itemId),
      amount: input.amount,
      occurredDate: input.occurredDate,
      status,
      remark,
      createdBy: BigInt(actor.userId),
      updatedBy: BigInt(actor.userId),
    };
    if (host === "matter") await tx.insert(matterExpense).values(values);
    else await tx.insert(riskMatterExpense).values(values);

    await logActivity(tx, actor, {
      ...auditLanding(host, hid, id),
      action: "EXPENSE_CREATED",
      diffs: {
        item_id: { from: null, to: input.itemId, name: item.name },
        amount: { from: null, to: input.amount },
        occurred_date: { from: null, to: input.occurredDate },
        status: { from: null, to: status, label: EXPENSE_STATUS_LABELS },
        ...(remark ? { remark: { from: null, to: remark } } : {}),
      },
    });
  });
  return { ok: true, id: String(id) };
}

export async function updateExpense(
  actor: Actor,
  host: HostKind,
  hostId: string,
  expenseId: string,
  input: z.infer<typeof expenseUpdateSchema>,
): Promise<ExpenseWriteOk | ExpenseWriteRejection> {
  const hostRow = await loadHost(actor, host, hostId);
  if (!hostRow) return { ok: false, why: "not_found" };
  if (hostRow.isArchived) return { ok: false, why: "archived" };

  const db = await getDb();
  const t = expenseTableOf(host);
  const hid = BigInt(hostId);
  const eid = BigInt(expenseId);
  const [cur] = await db
    .select()
    .from(t)
    .where(and(eq(t.hostId, hid), eq(t.id, eid), sql`NOT ${t.isDeleted}`))
    .limit(1);
  if (!cur) return { ok: false, why: "not_found" };

  if (input.itemId && input.itemId !== String(cur.itemId)) {
    const item = await checkItemUsable(input.itemId);
    if (!item) return { ok: false, why: "item_unavailable", itemId: input.itemId };
  }

  // 只写**真的变了**的字段（§3.2 末行：`*_UPDATED` 只在业务字段变化时写）。
  // 全量覆写会让审计里出现一堆 `from === to` 的噪声，读日志时看不出改了什么。
  const diffs: Record<string, unknown> = {};
  const patch: Partial<{
    itemId: bigint;
    amount: string;
    occurredDate: string;
    status: string;
    remark: string | null;
  }> = {};
  if (input.itemId !== undefined && input.itemId !== String(cur.itemId)) {
    patch.itemId = BigInt(input.itemId);
    diffs.item_id = { from: String(cur.itemId), to: input.itemId };
  }
  if (input.amount !== undefined && input.amount !== cur.amount) {
    patch.amount = input.amount;
    diffs.amount = { from: cur.amount, to: input.amount };
  }
  if (input.occurredDate !== undefined && input.occurredDate !== cur.occurredDate) {
    patch.occurredDate = input.occurredDate;
    diffs.occurred_date = { from: cur.occurredDate, to: input.occurredDate };
  }
  if (input.status !== undefined && input.status !== cur.status) {
    patch.status = input.status;
    diffs.status = { from: cur.status, to: input.status, label: EXPENSE_STATUS_LABELS };
  }
  if (input.remark !== undefined) {
    const next = input.remark.trim() ? input.remark.trim() : null;
    if (next !== cur.remark) {
      patch.remark = next;
      diffs.remark = { from: cur.remark, to: next };
    }
  }
  if (Object.keys(patch).length === 0) return { ok: true, id: expenseId };

  await db.transaction(async (tx) => {
    await tx
      .update(t)
      .set({ ...patch, updatedBy: BigInt(actor.userId), updatedAt: new Date().toISOString() })
      .where(eq(t.id, eid));
    await logActivity(tx, actor, {
      ...auditLanding(host, hid, eid),
      action: "EXPENSE_UPDATED",
      diffs,
    });
  });
  return { ok: true, id: expenseId };
}

/**
 * 删除费用：**软删**（`auditColumns` 的 `is_deleted`）。
 *
 * 为什么不硬删：费用是可被引用的事实（导出、活动日志、`UNCONVERT` 前置判定都看它），
 * 硬删会让"这条案子当时花了多少"永久不可考；而软删同时让撤销前置能排除它
 * （与节点那条 `NOT is_deleted` 同口径）。
 */
export async function deleteExpense(
  actor: Actor,
  host: HostKind,
  hostId: string,
  expenseId: string,
): Promise<ExpenseWriteOk | ExpenseWriteRejection> {
  const hostRow = await loadHost(actor, host, hostId);
  if (!hostRow) return { ok: false, why: "not_found" };
  if (hostRow.isArchived) return { ok: false, why: "archived" };

  const db = await getDb();
  const t = expenseTableOf(host);
  const hid = BigInt(hostId);
  const eid = BigInt(expenseId);
  const [cur] = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.hostId, hid), eq(t.id, eid), sql`NOT ${t.isDeleted}`))
    .limit(1);
  if (!cur) return { ok: false, why: "not_found" };

  await db.transaction(async (tx) => {
    await tx
      .update(t)
      .set({
        isDeleted: true,
        deletedAt: new Date().toISOString(),
        updatedBy: BigInt(actor.userId),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(t.id, eid));
    await logActivity(tx, actor, {
      ...auditLanding(host, hid, eid),
      action: "EXPENSE_DELETED",
      diffs: { is_deleted: { from: false, to: true } },
    });
  });
  return { ok: true, id: expenseId };
}

/**
 * 「目标案件有没有费用」——**撤销转案件的前置判定**（映射矩阵 §5.1）。
 *
 * 单独导出而不是让 `risks.ts` 自己查：这条判定的口径（软删行不算、只算目标案件）
 * 与上面的列表**必须**一致，两处各写一遍 SQL 的失败形态是"列表里看不到的费用
 * 却挡着撤销"，而它不报错。
 */
export async function hasMatterExpenses(db: Awaited<ReturnType<typeof getDb>>, matterId: bigint) {
  const [row] = await db
    .select({ n: dcount() })
    .from(matterExpense)
    .where(and(eq(matterExpense.hostId, matterId), sql`NOT ${matterExpense.isDeleted}`));
  return Number(row?.n ?? 0) > 0;
}

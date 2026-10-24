import { and, eq, inArray } from "drizzle-orm";
import { needsChangeReason } from "@/shared/schema/status-transition";
import type { Actor } from "../auth/auth";
import { getDb } from "../db/client";
import { statusConfig } from "../db/schema";
import type { HostKind } from "../scope/visibility";
import { logActivity } from "./activity";
import { HOST_STATUS_POLICIES } from "./host-status-policy";
import { notifyStatusChanged } from "./notifications";

/**
 * **案件与事项的状态变更 —— 判定顺序与整笔事务的唯一实现。**
 *
 * 这一层存在的理由：两侧原来是两份同构函数（`matters.ts` / `risks.ts`），守卫顺序只写在
 * 注释里，`risks.spec.ts` 靠把源码当字符串读来钉住「冻结门排在归档与归属之前」。
 * 现在顺序由 `decideStatusChange` 一个纯函数拥有，那条断言读它，不再读源码文本。
 *
 * ## 顺序（改动前请先读完）
 *
 *   1. 可见 —— 不可见 / 已软删 / 不存在一律 `not_found`（→ 404，元规则 3）；
 *   2. 冻结 —— **排在归属之前**：冻结是这条记录的属性，与「你是不是经办人」无关。
 *      排在后面的话，冻结的事项会先被告知「你不是经办人」，用户去找经办人，
 *      找到之后拿到的还是同一句（ADR-0005 的裁定）；
 *   3. 归属 —— 护栏 1（权限草案 §2.2）；
 *   4. 没变 —— 目标与现状相同是正常结局，不是错；
 *   5. 目标状态未知 —— 与「不存在」同话术；
 *   6. 原因 —— 偏离推荐路径、或撤销归档（恒必填）；
 *   7. 撤销归档的特权（`privilege_required`）。
 *
 * ## 三档审计动作
 *
 * `ARCHIVED` / `UNARCHIVED` / `STATUS_CHANGED` 是三种**不同后果**：前两个恒要原因、
 * 一个不可逆、一个需特权。混成一个的时候，「谁撤了归档」在审计链里按动作名筛不出来。
 *
 * ## 为什么返回 `why` 而不是抛
 *
 * 调用方（两条路由、两处批量循环）要按失败原因做不同的 HTTP / 摘要，而`not_found`
 * 在批量里是**要吞掉的**（竞态与不可见同型）。`why` 是这套口径的唯一来源。
 */

export type StatusChangeWhy =
  "not_found" | "reason_required" | "unchanged" | "forbidden" | "frozen";

export type StatusChangeResult = { ok: true } | { ok: false; why: StatusChangeWhy };

/** 判决所需的**事实**。全部由调用方读好传进来，判决本身不连库 —— 它才是测试面。 */
export type StatusChangeFacts = {
  /** `scopedWhere` 查到了这一行没有（不可见 / 已软删 / 不存在都是 `false`） */
  visible: boolean;
  frozen: boolean;
  isArchived: boolean;
  ownerAllowed: boolean;
  from: string;
  to: string;
  /** 目标状态的语义；`null` = 配置表里没有这个 code（或已被停用） */
  targetSemantics: string | null;
  fromNextCodes: readonly (string | null)[];
  hasReason: boolean;
};

export type StatusChangePlan =
  | { ok: false; why: StatusChangeWhy }
  | {
      ok: true;
      archiving: boolean;
      unarchiving: boolean;
      action: "ARCHIVED" | "UNARCHIVED" | "STATUS_CHANGED";
    };

/**
 * 判决：**只做判断，不碰库、不开事务**。
 *
 * 把它单独抽出来的目的是可测：`pnpm verify` 离线跑，而状态变更本体一进去就连库。
 * `status-change.spec.ts` 用「喂一组事实」的方式钉住顺序与三档动作，
 * 不必再读源码字符串。
 */
export function decideStatusChange(f: StatusChangeFacts): StatusChangePlan {
  if (!f.visible) return { ok: false, why: "not_found" };
  // 冻结排在归属之前 —— 见文件头第 2 条
  if (f.frozen) return { ok: false, why: "frozen" };
  if (!f.ownerAllowed) return { ok: false, why: "forbidden" };
  if (f.from === f.to) return { ok: false, why: "unchanged" };
  if (f.targetSemantics === null) return { ok: false, why: "not_found" };

  const archiving = f.targetSemantics === "archived";
  /** 撤销归档 = 当前**是**归档态、目标不是归档语义。判据是记录属性，不是目标能推断的 */
  const unarchiving = f.isArchived && !archiving;

  const reasonRequired =
    unarchiving ||
    needsChangeReason({
      from: f.from,
      fromNextCodes: f.fromNextCodes,
      to: f.to,
      toSemantics: f.targetSemantics,
    });
  if (reasonRequired && !f.hasReason) return { ok: false, why: "reason_required" };

  return {
    ok: true,
    archiving,
    unarchiving,
    action: archiving ? "ARCHIVED" : unarchiving ? "UNARCHIVED" : "STATUS_CHANGED",
  };
}

/**
 * 改一条案件 / 事项的状态。宿主只是参数 —— 两个宿主的不同全部在 `HOST_STATUS_POLICIES`。
 *
 * 用法上只有一处要记住：**不可见与不存在返回同一个 `not_found`**，路由翻成 404。
 * 不要把 403 用在可见性上：案号可枚举，403 等于替探测者确认「这条存在」。
 */
export async function changeHostStatus(input: {
  host: HostKind;
  actor: Actor;
  id: string;
  to: string;
  reason?: string | null;
}): Promise<StatusChangeResult> {
  const { host, actor, id, to } = input;
  const policy = HOST_STATUS_POLICIES[host];
  const db = await getDb();

  const row = await policy.read(actor, id);
  if (!row) return { ok: false, why: "not_found" };

  // 当前态与目标态一起取：偏离判定要两边的 code 与语义（修订稿 §3.3 第 3 条）
  const rows = await db
    .select({
      code: statusConfig.code,
      // `name` 一起取：通知文案的 `{from} → {to}` 要用**显示名**（已登记/进行中/已处理），
      // 不是 code —— 通知是给人读的
      name: statusConfig.name,
      semantics: statusConfig.semantics,
      nextStatusCodes: statusConfig.nextStatusCodes,
    })
    .from(statusConfig)
    .where(and(eq(statusConfig.hostType, host), inArray(statusConfig.code, [row.status, to])));

  const curRow = rows.find((r) => r.code === row.status);
  const target = rows.find((r) => r.code === to);

  const plan = decideStatusChange({
    visible: true,
    frozen: policy.frozen(row),
    isArchived: row.isArchived,
    ownerAllowed: policy.ownerAllowed(actor, row),
    from: row.status,
    to,
    targetSemantics: target?.semantics ?? null,
    fromNextCodes: curRow?.nextStatusCodes ?? [],
    hasReason: Boolean(input.reason?.trim()),
  });
  if (!plan.ok) return plan;

  const now = new Date().toISOString();
  const idBig = BigInt(id);

  await db.transaction(async (tx) => {
    const closingDate = policy.closingDate(target!.semantics, row.closingDate, now);
    /**
     * 归档完备性：**判定在事务内跑**，与归档写、审计写同一事务 —— 判定结果要随
     * `ARCHIVED` 落库，分开算会留下「审计里记的缺项与实际归档状态不一致」。
     * 缺项不阻断（IQ-16）：它只把 reason 从可选变必填（上面已拦），并把清单记进审计。
     */
    const readiness = plan.archiving ? await policy.readiness(tx, id) : null;

    await policy.writeStatus(tx, {
      id: idBig,
      to,
      archiving: plan.archiving,
      closingDate,
      now,
      updatedBy: BigInt(actor.userId),
    });

    /**
     * 审计。动作名按三档分支调用 —— **这里刻意写三遍字面量**，不是手滑：
     * `enum-check.spec.ts` 的「清单里每个值都写得出来吗」只认对象字面量里的
     * `action: "..."`（它要区分"有写入点"与"变量里可能有"）。改成
     * `action: plan.action` 会让 ARCHIVED / UNARCHIVED / STATUS_CHANGED 三个值
     * 一起变成"没有任何代码写得出来"。载荷本身只构造一次。
     */
    const entry = {
      ...policy.auditHost(idBig),
      targetType: host,
      targetId: idBig,
      reason: input.reason ?? null,
      diffs: {
        status: { from: row.status, to },
        // 只在**真的变了**才记：`closed → archived` 保留日期，记一条
        // `from: 2026-01-01, to: 2026-01-01` 是噪声
        ...(closingDate !== row.closingDate
          ? { closing_date: { from: row.closingDate, to: closingDate } }
          : {}),
      },
      ...(readiness
        ? {
            payload: {
              missing_at_archive: readiness.missing,
              // ⚠ 单列一份：`missing_at_archive` 为空**不等于齐备** —— 附件那项没有数据源、
              //   这次没判。不把这件事写下来，「空数组 = 齐备」会被读成事实。
              unavailable_at_archive: readiness.unavailable,
            },
          }
        : {}),
    };
    if (plan.action === "ARCHIVED") {
      await logActivity(tx, actor, { ...entry, action: "ARCHIVED" });
    } else if (plan.action === "UNARCHIVED") {
      await logActivity(tx, actor, { ...entry, action: "UNARCHIVED" });
    } else {
      await logActivity(tx, actor, { ...entry, action: "STATUS_CHANGED" });
    }

    /**
     * 通知意图（预置规则 2）—— **与状态写同一事务**。分开提交会留下「状态改了但没人收到
     * 回音」的中间态，而这条链路服务的正是「报了没回音，下次就不报了」。
     * `isArchivedAfter` 是**写入后**的归档态：归档记录不再产生新通知，所以 `→ archived`
     * 这一步静默；撤销归档照常发。
     */
    await notifyStatusChanged(actor, tx, {
      host,
      hostId: idBig,
      from: row.status,
      to,
      fromName: curRow?.name ?? row.status,
      toName: target!.name,
      isArchivedAfter: plan.archiving,
    });

    // 规则 1（结案自动归档）在通知之后、同一事务内：先发再归档，本次 `→ closed` 的通知
    // 照旧发出；事项侧是空实现（见 policy 里的注释）
    await policy.afterStatusWritten(tx, { id: idBig, to, now });
  });

  return { ok: true };
}

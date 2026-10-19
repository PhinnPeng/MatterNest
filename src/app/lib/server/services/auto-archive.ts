/**
 * **状态变更分发器** —— 让「结案自动归档」这条预置规则真的会跑（预置规则 1）。
 *
 * ## 这个文件为什么存在（MATT-72 阻塞 1 的落点）
 *
 * P12 规则配置页落地时量出：9 条预置规则里规则 1 / 3 **连执行体都没有**
 * （`agent-work/probe-rule-executors.mjs`）。规则 1「结案自动归档」的语义是
 * 「状态变更为 `closed` ⇒ 自动归档」，而那条路此前一步都没接：把状态推到已结案，
 * 案件**不会**被归档，勾不勾那个开关都一样。
 *
 * ## 为什么挂在 `changeStatus` 的事务里，而不是定时扫描
 *
 * 规格给的 `trigger_type` 就是 **`status_changed`**（修订稿 §2.3 的规则 1 行：
 * `{status_code:"closed"}`），不是 `time_no_progress` —— 它是**由状态变更唤起**的，
 * 而状态变更是一次同步的业务写入（`POST /api/matters/[id]/status`）。
 * 所以它**有触发人在场**，这一点很要紧（见下"两条审计"）。
 *
 * 挂进同一个事务而不是事后补：与通知意图逐字相同的理由——分开提交会留下
 * "状态已经变了、归档还没落"的中间态，而列表的 `is_archived` 与
 * 「已结案缺材料」筛选都读那一列，中间态会让它们指错地方。
 *
 * ## ⚠ 两条审计，不是借人一条
 *
 * 这条链路上会落**两条** `mn_activity_log`：
 *
 * | 行 | `operator_id` | 谁写的 |
 * |---|---|---|
 * | `STATUS_CHANGED` | **触发人**（张三） | `changeStatus` 里既有的那次 |
 * | `ARCHIVED` | **`NULL`**（系统） | 本文件 |
 *
 * 读起来是「张三把状态改成已结案」→「系统自动归档」。**两条都准确，谁也没冒充谁。**
 *
 * 反过来若借用触发人当 `ARCHIVED` 的 operator，张三从没点过归档按钮却出现在归档行上 ——
 * 那与"用 admin 代签"是同一类问题（只是轻一点）：审计开始说谎。
 * OWASP NHI Top 10 的 NHI10:2025 把「人与自动化的动作不可区分」直接列为风险。
 *
 * ## 为什么用 `logSystemActivity` 而不是 `logActivity`
 *
 * 后者收 `Actor`（`activity.ts:14`）。系统动作没有 `Actor`，硬凑一个是让调用方伪造身份；
 * 传 `null` 进去又会让「忘了传 actor」与「系统动作」在代码上不可分。
 * 所以是**并列的另一个函数**，它拿不到 `Actor` 类型 —— 想借人都借不到。
 *
 * ## 平台决定的写侧复用（§8）
 *
 * 权限草案 §8：「规则动作 …… **必须**走与人工相同的 StaffService / 状态变更服务，
 * 以保 `*_staff` 与 `owner_id` 双写一致」。所以这里不自己拼 `update` 语句，
 * 而是调 `writeMatterStatus`（人工路径也走它）。护栏部分**不共享**：
 * 「只有经办人能改状态」对规则不适用（§8 明写规则是代理动作、不受护栏 1 约束）——
 * 那一条留在 `changeStatus` 里。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { matter, statusConfig } from "../db/schema";
import { judgeArchiveReadiness } from "./archive-readiness";
import { writeMatterStatus } from "./matter-status-write";
import { logSystemActivity } from "./activity";
import { loadRuleByCode } from "./rule-config";
import { presetRule } from "@/shared/automation/preset-rules";
import { ruleCoversHost, statusChangedHits } from "@/shared/automation/rule-gate";

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 本分发器只负责规则 1 —— 规则 3 已被产品拒绝（不实施自动建节点），见下 */
export const CLOSE_AUTO_ARCHIVE_RULE = presetRule(1);

/**
 * 规则 1 这次该不该跑。
 *
 * 三条都得成立：开关开着、触发条件被本次变更满足、作用宿主覆盖本次变更。
 * 判定本身是纯函数（`shared/automation/rule-gate.ts`），这里只是把三者串起来。
 *
 * **读不到规则行 ⇒ 不跑**（fail-closed）。理由与规则 2/5/6/7/8 逐字相同：
 * 规则表是开关的唯一落点，行缺失只可能是环境不对（`is_system` 不可删），
 * 那时回落到"照跑"会让"有人改了库"表现得像"规则还开着"。
 */
export function shouldAutoArchive(
  rule: {
    isEnabled: boolean;
    triggerType: string;
    triggerConfig: Record<string, unknown>;
    hostType: string;
  } | null,
  args: { host: "matter" | "risk_matter"; toStatusCode: string },
): boolean {
  if (!rule) return false;
  if (!rule.isEnabled) return false;
  if (!ruleCoversHost(rule.hostType, args.host)) return false;
  return statusChangedHits(rule.triggerType, rule.triggerConfig, args.toStatusCode);
}

/**
 * 状态变更之后，按规则 1 决定要不要自动归档。**在 `changeStatus` 的同一事务里调用。**
 *
 * ## 只对案件生效，事项是**显式跳过**而不是"碰巧不生效"
 *
 * 规则 1 的 `host_type` 是 `all`（两条宿主线都吃），seed 与目录一致。
 * 但事项侧这条路的落地是**另一件事**：事项的归档态由 `changeRiskStatus` 管，
 * 而"结案自动归档"在事项上的语义（`已处理 → 已归档`）产品从未裁定过。
 * 所以这里只接案件侧，事项侧**显式返回**并说明 —— 写成"忘了接"与"刻意没接"
 * 在代码上长得一样，而后者才是事实。
 *
 * ⚠ 这不是"没做完"：把一条未经裁定的自动化动作接上去，比不接危险得多
 * （它会静默地替用户归档记录）。规则 1 在页面上的开关是真的，只是它的作用面
 * 目前是案件线；事项线要不要吃它，是待裁定项。
 *
 * ## 已经归档的不重复归档
 *
 * `→ closed` 时若这条案件本来就已归档（`closed → archived` 是推荐后继，
 * 而 `archived → closed` 也是合法回退），再归档一次会写第二条 `ARCHIVED` 审计，
 * 把审计链灌成噪音。所以先查当前归档态，是 true 就直接返回。
 *
 * ## 「归档完备性」在这里重算，不复用 `changeStatus` 那份
 *
 * 两份读的是**同一个瞬时**（同一事务、同一行），但 `changeStatus` 那份只在
 * **目标态是归档语义**时才算（`archiving`），而本函数面对的是 `→ closed`
 * （目标态不是归档语义 ⇒ 那份是 `null`）。所以要自己算一遍，并且
 * **判定必须在本函数的写入之前跑**：写之后再判会读到 `is_archived` 已翻的行。
 */
export async function applyCloseAutoArchive(
  tx: Tx,
  args: { hostId: bigint; toStatusCode: string; now: string },
): Promise<{ archived: boolean; reason?: string }> {
  const rule = await loadRuleByCode(tx, CLOSE_AUTO_ARCHIVE_RULE.code);
  if (
    !shouldAutoArchive(rule, {
      host: "matter",
      toStatusCode: args.toStatusCode,
    })
  ) {
    return { archived: false, reason: rule ? "not_hit" : "rule_missing" };
  }

  const [cur] = await tx
    .select({ isArchived: matter.isArchived, closingDate: matter.closingDate })
    .from(matter)
    .where(eq(matter.id, args.hostId))
    .limit(1);
  if (!cur) return { archived: false, reason: "host_missing" };
  // 已经归档：不重复写第二条 ARCHIVED（见上）
  if (cur.isArchived) return { archived: false, reason: "already_archived" };

  /**
   * 目标状态 = `semantics='archived'` 那一行，**服务端自己查**（配置驱动），
   * 不收调用方给的 code —— 与 `batchArchiveMatters` 同一条口径：归档是"到终态"
   * 这一个动作，让调用方再传一个状态码只是多一个能填错、又只能靠 422 发现的字段。
   */
  const rows = await tx
    .select({ code: statusConfig.code, semantics: statusConfig.semantics })
    .from(statusConfig)
    .where(eq(statusConfig.hostType, "matter"));
  const target = rows.find((r) => r.semantics === "archived");
  if (!target) {
    /**
     * 查不到就抛，与 `initialStatusCode` / `batchArchiveMatters` 同一条口径：
     * 那是"seed 没跑 / 配置被删"的部署故障。兜底成某个字面量只会让一批记录
     * 落进一个库里并不认作归档的状态——界面上它们还在在办列表里，
     * 而 `is_archived` 已经翻了。
     */
    throw new Error("mn_status_config 缺少 host_type=matter 且 semantics='archived' 的启用状态行");
  }

  /**
   * 归档完备性判定：与 `changeStatus` 里那次同形，**在写之前**跑，
   * 结果随 `ARCHIVED` 落库（G4 指标"归档材料完整率"以它为唯一数据源）。
   */
  const readiness = await judgeArchiveReadiness(tx, String(args.hostId));

  await writeMatterStatus(tx, {
    id: args.hostId,
    to: target.code,
    // 归档**保留**结案日期（`resolveClosingDate` 的注释记着为什么），而这条路上
    // `→ closed` 那一步刚写过日期，所以原值穿过即可
    closingDate: cur.closingDate,
    archiving: true,
    now: args.now,
    // NULL = 无人类主体。**这正是迁移 0016 要开的那条路。**
    updatedBy: null,
  });

  await logSystemActivity(tx, {
    matterId: args.hostId,
    targetType: "matter",
    targetId: args.hostId,
    action: "ARCHIVED",
    /**
     * `reason` 是 `REASON_REQUIRED_ACTIONS` 里**恒必填**的四条之一（`audit.ts:179`）。
     * 系统动作没有"人填的原因"，但它**必须**留下"为什么会被归档" —
     * 写固定串而不是留空：留空会让这条审计变成一条查不出缘由的记录，
     * 而"原因必填"那条规则的本意正是防这个。
     */
    reason: `自动归档：规则「${CLOSE_AUTO_ARCHIVE_RULE.name}」（结案时自动归档）`,
    payload: {
      /**
       * ⚠ 这里**必须**留下"是哪条规则、由什么触发"的线索。
       * `operator_id = NULL` 只说了"没有人类主体"，不足以回答"谁干的" ——
       * 只写 NULL 而不写线索，等于把那个问题从"某个人"换成"不知道"。
       * 载荷形状对齐 `docs/PRD-phase1-enums-and-schemas.md:129`。
       */
      rule_id: String(rule?.id ?? ""),
      rule_code: CLOSE_AUTO_ARCHIVE_RULE.code,
      rule_name: CLOSE_AUTO_ARCHIVE_RULE.name,
      action_type: CLOSE_AUTO_ARCHIVE_RULE.actionType,
      triggered_by: { trigger_type: "status_changed", status_code: args.toStatusCode },
      // 与人工归档同一份判定结果（同一个函数、同一瞬时）
      missing_at_archive: readiness?.missing ?? [],
      unavailable_at_archive: readiness?.unavailable ?? [],
    },
  });

  return { archived: true };
}

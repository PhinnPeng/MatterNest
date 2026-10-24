import { and, asc, eq, sql } from "drizzle-orm";
import {
  ACTION_TYPE_LABELS,
  RULE_HOST_TYPE_LABELS,
  TRIGGER_TYPE_LABELS,
  type ActionType,
  type RuleHostType,
  type TriggerType,
} from "@/shared/enums/automation";
import { computeScopeKey } from "@/shared/automation/scope-key";
import { getDb } from "../db/client";
import { automationRule } from "../db/schema";
import { loadEnabledRules, loadRuleByCode, type RuleRow } from "./rule-config";

/**
 * 自动化规则的**读出口与启停/调参出口**（P12 / F5-7 · F5-10，2026-10-18）。
 *
 * ## 一期只有预置规则，但接口按"规则"建模
 *
 * F5-8/F5-9（新建规则）随 IQ-9 移出一期，所以这里**没有创建入口**。
 * 表结构照旧（`is_system` 上二期恢复自建时"只加不改"），本文件的读形状也照规则表来，
 * 而不是写死"就这九条"——二期加自建时这里只多一个 `is_system = false` 的分支。
 *
 * ## `is_system` 的三条边界（F5-10 原话）
 *
 * 「`is_system`：**可调参可停用，不可删不可改 trigger**」。所以：
 *   · 允许：`is_enabled`（停用/启用）、`action_config` 里的**参数**；
 *   · 禁止：删除、改 `trigger_type` / `trigger_target_type` / `host_type` / `code`。
 * 禁止的那几列**不在更新入参类型里**（见 `updateRule` 的入参），而不是"传了也忽略"——
 * 后者会让调用方以为自己改成功了。
 *
 * ## ⚠ 两处「改了也不生效」必须被显式拒绝
 *
 * 这一轮做的事就是让开关**真的生效**（`probe-rule-executors.mjs` 之前量出 7 条是装饰）。
 * 但规则 1 / 3 至今**没有执行体**（`probe-rule13-blockers.mjs` 记着两处硬阻塞）。
 * 若允许它们被启用，配置页上那个开关就是个新的装饰 —— 所以 `updateRule` 对这两条
 * **拒绝启用**，理由直说。这是本文件最重要的一条判断：
 * **宁可让页面报"暂不支持"，也不给一个假的绿灯。**
 *
 * ## 收件人参数只允许规则 2/8 改
 *
 * `action_config.receivers` 对"动作是 notify"的规则才有意义。规则 7 的动作是 `archive`、
 * `action_config` 是 `{}`（通知是它的副作用，收件人来自字面量）—— 允许它改 `receivers`
 * 会写进一个没人读的键，而用户在页面上会以为改了推送对象。
 */

/** 列表的一项：把 jsonb 原样带上（页面按 trigger/action 类型决定怎么展示） */
export type RuleListItem = {
  id: string;
  code: string;
  name: string;
  hostType: RuleHostType;
  hostTypeLabel: string;
  triggerType: TriggerType;
  triggerLabel: string;
  triggerConfig: Record<string, unknown>;
  actionType: ActionType;
  actionLabel: string;
  actionConfig: Record<string, unknown>;
  isSystem: boolean;
  isEnabled: boolean;
  priority: number;
  lastRunAt: string | null;
  /**
   * **这一条的执行体存不存在**（不是"开关有没有被读"）。
   *
   * 页面据此把没有执行体的规则的开关换成一句说明 —— 否则用户勾了它、什么也不会发生。
   *
   * ⚠ 这里**写死名单而不是现算**：现算要把"代码里有没有生产者在跑"变成运行时反射，
   * 而那种反射在本仓没有先例、也挡不住误判。名单由
   * `agent-work/probe-rule-executors.mjs` 支撑，且 `rule-admin.spec.ts` 有一条断言
   * 钉住它与 probe 的结论一致（见该文件）。执行体补上之后改这一行、跑 probe、
   * 把断言一起改 —— 三处同批。
   */
  executor: "live" | "missing";
};

/**
 * **没有执行体**的规则 code（理由见 `RuleListItem.executor` 的注）。
 *
 * ## 2026-10-19：规则 1 从这份名单移出
 *
 * 规则 1「结案自动归档」补上了执行体（`services/auto-archive.ts`，挂在
 * `changeHostStatus` 的事务里）。所以它现在**是一条约真的规则**：开关开着、状态推到
 * `closed`，案件会被自动归档，并落一条 `operator_id = NULL` 的 `ARCHIVED` 审计
 * （系统动作不冒充人，见迁移 0016 与 `docs/research-system-identity.md`）。
 *
 * ⚠ **它的作用面目前只有案件线**：`host_type` 是 `all`，但事项侧"已处理 → 已归档"
 * 的自动化语义产品从未裁定过，所以 `applyCloseAutoArchive` 对事项显式跳过
 * （那边的实现会在代码里写明是刻意不接，不是漏了）。
 *
 * ## 规则 3 为什么还在这份名单里
 *
 * 产品已明确**拒绝**它：不需要在"进入进行中"时自动生成节点
 * （且它另有实现阻塞：缺 `node_type_config.template_code` 列，且与建案预设重叠）。
 * 所以它如实标「暂不可用」，不画开关、接口拒绝启用。
 */
export const RULES_WITHOUT_EXECUTOR = ["preset_03_in_progress_create_node"] as const;

export function hasExecutor(code: string): boolean {
  return !(RULES_WITHOUT_EXECUTOR as readonly string[]).includes(code);
}

function toItem(row: RuleRow, meta: { isSystem: boolean; priority: number }): RuleListItem {
  return {
    id: String(row.id),
    code: row.code,
    name: row.name,
    hostType: row.hostType as RuleHostType,
    hostTypeLabel: RULE_HOST_TYPE_LABELS[row.hostType as RuleHostType] ?? row.hostType,
    triggerType: row.triggerType as TriggerType,
    triggerLabel: TRIGGER_TYPE_LABELS[row.triggerType as TriggerType] ?? row.triggerType,
    triggerConfig: row.triggerConfig,
    actionType: row.actionType as ActionType,
    actionLabel: ACTION_TYPE_LABELS[row.actionType as ActionType] ?? row.actionType,
    actionConfig: row.actionConfig,
    isSystem: meta.isSystem,
    isEnabled: row.isEnabled,
    priority: meta.priority,
    lastRunAt: row.lastRunAt,
    executor: hasExecutor(row.code) ? "live" : "missing",
  };
}

/**
 * 规则列表。**读不设门**（与 `/api/meta`、`/api/config/[kind]` 的 GET 同档）：
 * 认不认识"系统会自动做什么"不该有权限门槛；改才是特权。
 *
 * 排序用 `priority`（同号按 id），与分发器的执行次序一致 —— 页面上的顺序即运行期顺序。
 */
export async function listRules(): Promise<RuleListItem[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: automationRule.id,
      code: automationRule.code,
      name: automationRule.name,
      hostType: automationRule.hostType,
      triggerType: automationRule.triggerType,
      actionType: automationRule.actionType,
      triggerConfig: automationRule.triggerConfig,
      actionConfig: automationRule.actionConfig,
      isEnabled: automationRule.isEnabled,
      lastRunAt: automationRule.lastRunAt,
      isSystem: automationRule.isSystem,
      priority: automationRule.priority,
    })
    .from(automationRule)
    .where(sql`NOT ${automationRule.isDeleted}`)
    .orderBy(asc(automationRule.priority), asc(automationRule.id));
  return rows.map((r) =>
    toItem(
      {
        ...r,
        triggerConfig: (r.triggerConfig ?? {}) as Record<string, unknown>,
        actionConfig: (r.actionConfig ?? {}) as Record<string, unknown>,
      },
      { isSystem: r.isSystem, priority: r.priority },
    ),
  );
}

/** 写路径的拒绝理由（路由层按 `why` 翻译成状态码与文案） */
export type RuleWriteRejection =
  | { ok: false; why: "not_found" }
  | { ok: false; why: "no_executor"; code: string; name: string }
  | { ok: false; why: "receivers_not_applicable"; code: string; name: string }
  | { ok: false; why: "scope_conflict"; withCode: string; withName: string }
  | { ok: false; why: "invalid_receivers" };

export type RuleWriteOk = { ok: true; id: string };

/**
 * 改一条规则：**只允许** `is_enabled` 与 `action_config.receivers`。
 *
 * 入参类型里没有别的键，所以"改 trigger"在类型层就不可表达。
 */
export async function updateRule(
  code: string,
  input: { isEnabled?: boolean; receivers?: readonly string[] },
): Promise<RuleWriteOk | RuleWriteRejection> {
  const db = await getDb();
  const cur = await loadRuleByCode(db, code);
  if (!cur) return { ok: false, why: "not_found" };

  /**
   * **没有执行体的规则不许启用**。见文件头：「宁可让页面报暂不支持，
   * 也不给一个假的绿灯」。停用永远允许（把一条不跑的规则显示成停用是无害的）。
   */
  if (input.isEnabled === true && !hasExecutor(code)) {
    return { ok: false, why: "no_executor", code: cur.code, name: cur.name };
  }

  /**
   * 收件人参数只对"动作是 notify"的规则有意义。规则 7（`archive`）改它
   * 会写进一个没人读的键 —— 用户以为改了推送对象，实际什么也没变。
   */
  if (input.receivers !== undefined && cur.actionType !== "notify") {
    return { ok: false, why: "receivers_not_applicable", code: cur.code, name: cur.name };
  }

  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.isEnabled !== undefined) patch.isEnabled = input.isEnabled;

  if (input.receivers !== undefined) {
    /**
     * 空数组拒绝：`receivers: []` 会让这条通知**谁也不发**，而那与"停用"是两件事
     * （停用有专门的开关）。允许它等于给用户一个静默关掉通知的后门。
     */
    if (input.receivers.length === 0) return { ok: false, why: "invalid_receivers" };
    patch.actionConfig = { ...cur.actionConfig, receivers: [...input.receivers] };
  }

  /**
   * **触发域唯一性的预判**（§2.1 的 partial unique index `ux_mn_automation_rule_enabled_action`）。
   *
   * 只在"从停用改为启用"时才可能撞：`WHERE is_enabled` 让停用的规则不占位。
   * 撞了由 DB 报 23505，但用户看到的是"服务器错误"——所以先判，给一条能看懂的话。
   * 判据与索引逐字相同：同 `(scope_key, action_type)` 且**另一条**已启用。
   *
   * `scope_key` **现算**，不读列：改了 `trigger_config` 之后列可能落后于配置
   * （本函数不改 trigger，但二期改 trigger 时这里必须跟着算）。
   */
  if (input.isEnabled === true && !cur.isEnabled) {
    const scopeKey = computeScopeKey(
      cur.triggerType as TriggerType,
      // `trigger_target_type` 不在 RuleRow 里（读出口只带执行要用的列），这里补查一次
      await targetTypeOf(db, cur.code),
      cur.triggerConfig,
    );
    const [clash] = await db
      .select({ code: automationRule.code, name: automationRule.name })
      .from(automationRule)
      .where(
        and(
          eq(automationRule.scopeKey, scopeKey),
          eq(automationRule.actionType, cur.actionType),
          eq(automationRule.isEnabled, true),
          sql`NOT ${automationRule.isDeleted}`,
          sql`${automationRule.code} <> ${code}`,
        ),
      )
      .limit(1);
    if (clash) {
      return { ok: false, why: "scope_conflict", withCode: clash.code, withName: clash.name };
    }
  }

  await db
    .update(automationRule)
    .set(patch)
    .where(and(eq(automationRule.code, code), sql`NOT ${automationRule.isDeleted}`));
  return { ok: true, id: String(cur.id) };
}

/** `trigger_target_type` 不在 `RuleRow` 里，需要它算 `scope_key` 时补查一次（9 行表，代价可忽略） */
async function targetTypeOf(db: Awaited<ReturnType<typeof getDb>>, code: string): Promise<string> {
  const [row] = await db
    .select({ v: automationRule.triggerTargetType })
    .from(automationRule)
    .where(eq(automationRule.code, code))
    .limit(1);
  return row?.v ?? "all";
}

/**
 * 页面顶部那张"几条在跑"的读数。
 *
 * ## ⚠ 三个数不是同义词，别合并
 *
 * · `enabled` —— 库里 `is_enabled = true` 的行数；
 * · `live` —— **真的有代码在跑它们**的条数（`executor === "live"` 且已启用）；
 * · `withoutExecutor` —— 没有执行体的条数（不论启用与否）。
 *
 * 一期现状让这三个数**各不相同**：规则 3 在 seed 里就是 `is_enabled = true`
 * （§2.3 的"默认启用"列），而它没有执行体。所以页面若只报 `enabled`，
 * 会显示「8 / 9 条启用」—— 而其中一条启用了也什么都不做。
 *
 * 页面报的是 `live`（真在跑的），`enabled` 留给"库里怎么写的"这一档说明。
 * 两者混成一个数是本仓最防的那类失真：**数字看起来更漂亮，而它与行为不符**。
 */
export async function ruleSummary(): Promise<{
  total: number;
  /** 库里 `is_enabled = true` 的条数（含没有执行体的） */
  enabled: number;
  /** **真有代码在跑**的条数（启用 且 有执行体）—— 页面主读数用它 */
  live: number;
  /** 没有执行体的条数（不论启用与否） */
  withoutExecutor: number;
}> {
  const items = await listRules();
  return {
    total: items.length,
    enabled: items.filter((r) => r.isEnabled).length,
    live: items.filter((r) => r.isEnabled && r.executor === "live").length,
    withoutExecutor: items.filter((r) => r.executor === "missing").length,
  };
}

/** 供单测/排障：启用集（分发器视角）的 code 列表 */
export async function enabledRuleCodes(): Promise<string[]> {
  const db = await getDb();
  return (await loadEnabledRules(db)).map((r) => r.code);
}

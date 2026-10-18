/**
 * **读规则行**（`mn_automation_rule`）的唯一入口。
 *
 * ## 为什么需要这个文件（2026-10-18）
 *
 * F5-10 的原文是「预置规则管理（`is_system`：**可调参可停用**，不可删不可改 trigger）」。
 * 而在建 P12 配置页之前的一次机械核对（`agent-work/probe-rule-executors.mjs`）量出：
 * **9 条预置规则里，只有规则 4 / 9 的 `is_enabled` 真的生效** ——
 *
 *   · 规则 4 / 9（`stale-reminder.ts` / `archive-reminder.ts`）读规则行，开关与调参是真的；
 *   · 规则 2 / 5 / 6 / 7 / 8 走 `intentsOfOutboxRow` → `emitForHost`，收件人取自
 *     `RULE_*_NOTIFY.receivers`（**常量**），通路上零处查 `is_enabled`；
 *   · 规则 1 / 3 **连执行体都没有**（结案不触发归档、状态变更不创建节点）。
 *
 * 于是那 7 条在页面上能勾、勾了没用 —— 正是 MATT-72 自己警告的「看着像做了」。
 * 本文件是补执行体那两张票共用的**那一半**：把「按 code 读一行」这件事收在一处。
 *
 * ## 为什么是"按 code"而不是"按 id"
 *
 * `code` 是 seed 的幂等锚（§2.4 末行：规则引用 `code` 不引用 id），也是跨环境重放的
 * 唯一前提。id 只是低号段占位（8xxx）。扫描器认领自己那条规则的依据一直是 code
 * （`ARCHIVE_REMINDER_RULE_CODE` / `STALE_REMINDER_RULE_CODE`），这里沿用同一条口径。
 *
 * ## fail-closed：读不到行 ⇒ 调用方应按"不执行"处理
 *
 * 返回 `null` 而不是抛错。**规则行缺失 ≠ 规则被停用**，两者要能被调用方分开
 * （规则 4/9 的返回体里都有 `ruleFound` / `enabled` 两个字段，就是为这件事）：
 * 若行缺失时回落到代码常量，"有人删了行"与"规则被停用"会得到两种相反的结果。
 * 而删行是不可达的（`is_system` 不可删），所以缺失只可能是环境不对 —— 那更要显式。
 *
 * ## 不用缓存
 *
 * 停用要**立即生效**（F5-10 的语义），而配置页保存后同一个进程还会继续接请求。
 * 加一层进程内缓存就得再造一套失效约定，代价比一次主键查表大。9 行、走唯一索引。
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { automationRule } from "../db/schema";

/** 只需要能 `select` —— 池句柄与事务句柄都满足（事务内外都要能读） */
type Reader = Pick<Awaited<ReturnType<typeof getDb>>, "select">;

/**
 * 一条规则行的运行时视图。
 *
 * 只带**执行体需要的列**，不是整行：`trigger_config` / `action_config` 是 jsonb，
 * 这里保持 `Record<string, unknown>`（键集与取值域由服务层校验，DB 守不住 jsonb 内部），
 * 由调用方按自己的规则形状去取 —— **不在这里**做归一化，因为各条规则的参数形状本就不同
 * （规则 4 取 `days`、规则 5/6 取 `receivers`、规则 1 只关心动作类型）。
 */
export type RuleRow = {
  id: bigint;
  code: string;
  name: string;
  /** `all` / `matter` / `risk_matter` */
  hostType: string;
  triggerType: string;
  actionType: string;
  triggerConfig: Record<string, unknown>;
  actionConfig: Record<string, unknown>;
  /**
   * **开关的唯一落点。** 停用后执行体必须早退 ——
   * 这是「可停用」（F5-10）兑现的地方，也是 ^ 那份核对报告里 7 条缺失的东西。
   */
  isEnabled: boolean;
  /** 排障辅助：扫描器每次都写它（"零事件"与"没跑过"靠它分开） */
  lastRunAt: string | null;
};

/** 软删的行不返回（`is_deleted` 是审计列，规则表也有） */
const notDeleted = sql`NOT ${automationRule.isDeleted}`;

/**
 * 按 `code` 取一条规则行。取不到返回 `null`（见文件头 fail-closed 一节）。
 */
export async function loadRuleByCode(r: Reader, code: string): Promise<RuleRow | null> {
  const [row] = await r
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
    })
    .from(automationRule)
    .where(and(eq(automationRule.code, code), notDeleted))
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    triggerConfig: (row.triggerConfig ?? {}) as Record<string, unknown>,
    actionConfig: (row.actionConfig ?? {}) as Record<string, unknown>,
  };
}

/**
 * 一次取回**全部启用中**的规则行，按 `priority` 升序（同号再按 id，保证次序稳定）。
 *
 * 状态变更分发器要的正是这一份：一次业务操作可命中多条规则（§7.2 开头），
 * 而"命中哪几条"必须在**同一时刻**判定 —— 逐条去查会在规则数增长后变成 N 次往返，
 * 且各条看到的不是同一个快照。
 *
 * `priority` 是同一宿主命中多条时的执行次序（§2.3 第七列）。
 */
export async function loadEnabledRules(r: Reader): Promise<RuleRow[]> {
  const rows = await r
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
    })
    .from(automationRule)
    .where(and(eq(automationRule.isEnabled, true), notDeleted))
    .orderBy(automationRule.priority, automationRule.id);
  return rows.map((row) => ({
    ...row,
    triggerConfig: (row.triggerConfig ?? {}) as Record<string, unknown>,
    actionConfig: (row.actionConfig ?? {}) as Record<string, unknown>,
  }));
}

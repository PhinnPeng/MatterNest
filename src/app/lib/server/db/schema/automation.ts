/**
 * `mn_automation_rule`：自动化规则表（迁移 0012，MATT-43 / T5b）。
 *
 * 列口径依据 `docs/PRD-phase1-design-revision-r1.md` §2.1（表结构）+ §2.3（9 条预置规则）；
 * 取值域依据 `docs/PRD-phase1-enums-and-schemas.md` §4.1–§4.4。
 * 迁移文件与这里必须逐列一致（禁令④：迁移是唯一事实，本文件是给查询用的类型化视图）。
 *
 * ## 一期只有预置规则，但表结构照旧
 *
 * F5-8/F5-9（新建规则）随 IQ-9 移出第一期，一期**没有任何写入方**——
 * 表里的行全部来自 `db/seed/0006_automation_rules.sql`。
 * 表结构不因此缩水：二期恢复自建入口时"只加不改"，而少一列就得再写一条迁移
 * （`docs/PRD-phase1-alignment-m5.md` US-M5-1 的"无迁移债"就是这个意思）。
 *
 * ## 三个字段是给运行期读的，不是装饰
 *
 * · `is_enabled` —— 规则 9 的扫描器**每次都读它**（"规则可停用；停用后不再产生提醒"）。
 * · `trigger_config` / `action_config` —— 扫描器从库里读 `days` / `cooldown_days`，
 *   而不是从 `shared/notification/preset-rules.ts` 的常量读，这样"可调参"才是真的。
 *   常量退化成 seed 的单一取值源（两侧逐字相等由单测钉住）。
 * · `scope_key` —— 唯一索引的另一半，见下面那条 partial unique index。
 */
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import {
  ACTION_TYPES,
  RULE_HOST_TYPES,
  TRIGGER_TARGET_TYPES,
  TRIGGER_TYPES,
} from "@/shared/enums/automation";
import { auditColumns, fk, id } from "./common";
import { sqlInList, sqlRaw } from "./ddl";

export const automationRule = pgTable(
  "mn_automation_rule",
  {
    id: id(),
    /** 跨环境重放的锚（§2.4 末行：规则引用 code 不引用 id）。seed 的幂等挂在它上面 */
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    /** 规则作用于哪类宿主：`all` / `matter` / `risk_matter`（比 E08/E10 多一个 `all`） */
    hostType: varchar("host_type", { length: 16 }).notNull(),
    triggerType: varchar("trigger_type", { length: 24 }).notNull(),
    /** 触发实体（E03 的子集）：节点类触发指向节点表，其余指向宿主 */
    triggerTargetType: varchar("trigger_target_type", { length: 24 }).notNull(),
    /** 键集与取值域由服务层校验（枚举表 §4.4）；DB 守不住 jsonb 内部 */
    triggerConfig: jsonb("trigger_config").notNull().default({}),
    /** 第一期只支持根 `and` 的字段级比较（§4.2）；9 条预置规则全为 NULL */
    extraCondition: jsonb("extra_condition"),
    actionType: varchar("action_type", { length: 24 }).notNull(),
    actionConfig: jsonb("action_config").notNull().default({}),
    /**
     * 触发域摘要（`computeScopeKey()` 产出，§4.4）。**不含动作**——
     * 所以"同域不同动作"天然允许并存，而"同域同动作"由下面那条 partial unique index 挡住。
     */
    scopeKey: varchar("scope_key", { length: 32 }).notNull(),
    priority: integer("priority").notNull().default(10),
    /** 预置规则：可停用、可调参，**不可删、不可改 trigger**（§2.1 + F5-10） */
    isSystem: boolean("is_system").notNull().default(true),
    isEnabled: boolean("is_enabled").notNull().default(true),
    /** 排障与幂等辅助（§2.1）。一期扫描器不写它，留给 F5-11 的执行记录 */
    lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "string" }),
    ...auditColumns,
    /** ⚠ `created_by` 覆盖成 NOT NULL：规则的来源必须可追（§2.1 表里写的是"是"） */
    createdBy: fk("created_by").notNull(),
  },
  (t) => [
    check("ck_mn_automation_rule_host_type", sqlInList("host_type", RULE_HOST_TYPES)),
    check("ck_mn_automation_rule_trigger_type", sqlInList("trigger_type", TRIGGER_TYPES)),
    check(
      "ck_mn_automation_rule_trigger_target",
      sqlInList("trigger_target_type", TRIGGER_TARGET_TYPES),
    ),
    check("ck_mn_automation_rule_action_type", sqlInList("action_type", ACTION_TYPES)),
    check("ck_mn_automation_rule_priority", sqlRaw("priority >= 0")),
    uniqueIndex("uk_mn_automation_rule_code").on(t.code),
    /**
     * **触发域唯一性**（§2.1 原文）：
     *
     * ```sql
     * CREATE UNIQUE INDEX ux_rule_enabled_action
     *   ON automation_rule (scope_key, action_type) WHERE is_enabled;
     * ```
     *
     * `WHERE is_enabled` 不是优化：停用的规则**不占位**，否则"停用→改参→再启用"会被自己挡住。
     * 这里用 `sqlRaw` 而不是 `eq(t.isEnabled, true)`：DDL 里没有参数上下文，
     * `eq()` 会产出 `$1` 而 PG 直接拒（`ddl.ts` 的文件头记着这个坑）。
     */
    uniqueIndex("ux_mn_automation_rule_enabled_action")
      .on(t.scopeKey, t.actionType)
      .where(sqlRaw("is_enabled")),
  ],
);

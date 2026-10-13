/**
 * **9 条预置规则的唯一取值源**（修订稿 §2.3 的表，逐行落地；MATT-43 / T5b）。
 *
 * ## 为什么这份表住在 shared，而不是"直接写进 seed 的 SQL"
 *
 * seed 是数据迁移，必须能跨环境逐字重放，所以它只能是 SQL 字面量。
 * 但**字面量需要一个可被机器核对的基准**——否则"seed 里写了什么"就是唯一事实，
 * 而 `scope_key`（唯一约束的判定依据）、`action_config.receivers`（谁收通知）、
 * `host_type`（规则 3/4 的 IQ-9 收窄）这三件事都会随一次手改静默漂移。
 * 所以：本文件是基准，`db/seed/0006_automation_rules.sql` 是它的字面量投影，
 * `preset-rules.seed.spec.ts` 逐字段对拉（含 `scope_key` 由 `computeScopeKey()` 现算）。
 *
 * ## 与 `notification/preset-rules.ts` 的关系（别把两份读成两个源）
 *
 * 那份文件是**通知这一侧的视图**（`ruleNo` / `name` / `templateCode` / `receivers`），
 * 它现在从本文件**派生**——两份各写一遍 `["follower","creator"]` 正是它要防的事
 * （那段注释原本就写着"等规则表落地时这份常量退化成 seed 的单一取值源"）。
 *
 * ## 三条不是风格的选择
 *
 * 1. **规则引用 `code` 不引用 id**（§2.4 末行）：`code` 是 seed 的幂等锚，
 *    也是跨环境重放的唯一前提。id 用 8xxx 低号段（与其它 seed 同一纪律）。
 * 2. **`trigger_target_type` 对宿主级规则取 `all`**（见 `enums/automation.ts` 的注）。
 * 3. **规则 1 默认禁用**：`status_changed{status_code:"closed"}` → 自动归档是**破坏性动作**，
 *    一期不默认开（§2.3 的"默认启用"列 + master §8「规则 1 默认禁用」）。
 */
import {
  type ActionType,
  type RuleHostType,
  type TriggerTargetType,
  type TriggerType,
} from "@/shared/enums/automation";
import { computeScopeKey } from "./scope-key";

/** `action_config` 的 notify 形态（§4.3）——只有通知类规则有它，所以单列一个类型 */
export type NotifyActionConfig = {
  receivers: readonly string[];
  template_code: string;
  /** 缺省 false；`true` 时必须给 `cooldown_days ≥ 1`（§4.3 末行） */
  once_per_target?: boolean;
  cooldown_days?: number;
  custom_user_ids?: readonly string[];
};

export type PresetRule = {
  /** §2.3 表格第一列的规则序号（1–9） */
  ruleNo: number;
  /** seed 的幂等锚（`uk_mn_automation_rule_code`）。改动它等于新增一条规则，不是改这条 */
  code: string;
  /** 规则名（§2.3 第二列，逐字相同） */
  name: string;
  hostType: RuleHostType;
  triggerType: TriggerType;
  triggerTargetType: TriggerTargetType;
  /** §4.1：键按 `trigger_type` 一对一，未知键一律拒绝保存 */
  triggerConfig: Record<string, unknown>;
  actionType: ActionType;
  actionConfig: Record<string, unknown>;
  /** 同一宿主命中多条规则时的执行次序（§2.3 第七列） */
  priority: number;
  enabledByDefault: boolean;
};

/**
 * 9 条预置规则。**顺序即规则号**，`preset-rules.seed.spec.ts` 拿它逐行比对 seed。
 *
 * 唯一性域复核（§2.3 最后一列）在单测里机器化：`(scope_key, action_type)` 两两不重复，
 * 所以"9 条在当前配置下均可同时启用"这句话是被断言钉住的，不是抄来的。
 */
export const PRESET_RULES: readonly PresetRule[] = [
  {
    ruleNo: 1,
    code: "preset_01_close_auto_archive",
    name: "结案自动归档",
    hostType: "all",
    triggerType: "status_changed",
    triggerTargetType: "all",
    triggerConfig: { status_code: "closed" },
    actionType: "archive",
    actionConfig: {},
    priority: 10,
    // 破坏性动作，一期不默认开（§2.3 的"默认启用"列）
    enabledByDefault: false,
  },
  {
    ruleNo: 2,
    code: "preset_02_status_changed_notify",
    name: "状态变更通知关注人",
    hostType: "all",
    triggerType: "status_changed",
    triggerTargetType: "all",
    // 空对象 = 任意状态变更。与规则 1/3 的域不同（它们含 status_code）
    triggerConfig: {},
    actionType: "notify",
    actionConfig: {
      // `creator` 是 IQ-13-V5 的落点（上报人回音走通知中心，不入关注列表）
      receivers: ["follower", "creator"],
      template_code: "status_changed",
    },
    priority: 20,
    enabledByDefault: true,
  },
  {
    ruleNo: 3,
    code: "preset_03_in_progress_create_node",
    name: "进入进行中创建节点",
    // IQ-9/Q37：事项无预设节点，收窄为仅案件
    hostType: "matter",
    triggerType: "status_changed",
    triggerTargetType: "matter",
    triggerConfig: { status_code: "in_progress" },
    actionType: "create_node",
    actionConfig: {
      template_code: "matter_in_progress",
      offset_days_from: "status_changed_at",
      offset_days: 0,
    },
    priority: 10,
    enabledByDefault: true,
  },
  {
    ruleNo: 4,
    code: "preset_04_stale_30d_notify",
    name: "长期未更新提醒",
    // IQ-9/Q37：观察型事项 30 天一催是噪音，案件的静默才是危险信号
    hostType: "matter",
    triggerType: "time_no_progress",
    triggerTargetType: "matter",
    // 比较基准是 `last_progress_at`（§6.4），"无更新"的判定内置在动作实现里（§2.5）
    triggerConfig: { days: 30 },
    actionType: "notify",
    actionConfig: {
      receivers: ["owner"],
      template_code: "stale_30d",
      // §2.3 末段：`once_per_target + cooldown_days` 是必填项，否则 cron 重扫造成提醒风暴
      once_per_target: true,
      cooldown_days: 30,
    },
    priority: 10,
    enabledByDefault: true,
  },
  {
    ruleNo: 5,
    code: "preset_05_node_before_start_notify",
    name: "节点开始提醒",
    hostType: "all",
    triggerType: "node_before_start",
    // 节点类触发：扫描器在动作实现内扫两张节点表，不为规则引入跨宿主统一节点视图（§2.3 末段）
    triggerTargetType: "all",
    triggerConfig: { days: 3 },
    actionType: "notify",
    actionConfig: {
      // 不含 `creator`：上报人收到"你的事项有个节点到期"没有可执行动作（G3 反例）
      receivers: ["owner", "follower"],
      template_code: "node_start",
    },
    priority: 10,
    enabledByDefault: true,
  },
  {
    ruleNo: 6,
    code: "preset_06_node_before_end_notify",
    name: "节点截止提醒",
    hostType: "all",
    triggerType: "node_before_end",
    triggerTargetType: "all",
    // §4.1：`node_before_end` 仅对 `time_type=range` 且 `end_time` 非空的节点有效
    triggerConfig: { days: 3 },
    actionType: "notify",
    actionConfig: {
      receivers: ["owner", "follower"],
      template_code: "node_end",
    },
    priority: 20,
    enabledByDefault: true,
  },
  {
    ruleNo: 7,
    code: "preset_07_risk_converted_archive",
    name: "转案件后归档",
    hostType: "risk_matter",
    // §2.3 末段：不再依赖"已转案件"状态，改由 `risk_converted` 领域事件触发
    triggerType: "event_occurred",
    triggerTargetType: "risk_matter",
    triggerConfig: { event: "risk_converted" },
    actionType: "archive",
    actionConfig: {},
    priority: 10,
    enabledByDefault: true,
  },
  {
    ruleNo: 8,
    code: "preset_08_comment_added_notify",
    name: "新评论通知关注人",
    hostType: "all",
    triggerType: "event_occurred",
    triggerTargetType: "all",
    // 与规则 7 同触发类型但 `event` 不同 ⇒ 不同域
    triggerConfig: { event: "comment_added" },
    actionType: "notify",
    actionConfig: {
      receivers: ["follower", "creator"],
      template_code: "comment_new",
    },
    priority: 20,
    enabledByDefault: true,
  },
  {
    ruleNo: 9,
    code: "preset_09_archive_incomplete_notify",
    name: "结案后材料不全提醒",
    // 仅案件：事项没有材料完整要求（F2-26④ / IQ-16）
    hostType: "matter",
    triggerType: "time_no_progress",
    triggerTargetType: "matter",
    /**
     * `status_code` 是 IQ-16 给 `time_no_progress` 加的那个**可选**参数（枚举表 §4.1 末段）。
     * 它与规则 4 的 `{days:30}` 一起构成两个不同的触发域 ⇒ 两条规则可同启用。
     * 双档是刻意接受的：closed 案件 14 天先收"补材料"、30 天再收"无进展"——
     * 语义不同（归档驱动 vs 停滞驱动）。
     */
    triggerConfig: { days: 14, status_code: "closed" },
    actionType: "notify",
    actionConfig: {
      // 经办人（= 负责人），**不是关注人**：关注人是被动 star 进来的，推给他们是噪音
      receivers: ["owner"],
      template_code: "archive_incomplete",
      once_per_target: true,
      cooldown_days: 14,
    },
    priority: 10,
    enabledByDefault: true,
  },
];

/** 按规则号取一条。取不到就抛——规则表是静态的，缺行是编程错误，不是运行时状况 */
export function presetRule(ruleNo: number): PresetRule {
  const found = PRESET_RULES.find((r) => r.ruleNo === ruleNo);
  if (!found) throw new Error(`预置规则表里没有第 ${ruleNo} 条`);
  return found;
}

/** 规则的触发域摘要（`computeScopeKey()` 现算，不手写：手写的值会与归一化函数漂移） */
export function scopeKeyOf(rule: PresetRule): string {
  return computeScopeKey(rule.triggerType, rule.triggerTargetType, rule.triggerConfig);
}

/** 通知类规则的 `action_config` 视图（`action_type !== "notify"` 时抛） */
export function notifyConfigOf(rule: PresetRule): NotifyActionConfig {
  if (rule.actionType !== "notify") throw new Error(`规则 ${rule.ruleNo} 的动作不是 notify`);
  return rule.actionConfig as NotifyActionConfig;
}

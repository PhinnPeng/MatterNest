/**
 * 预置规则里**通知这一侧**的收件人口径（修订稿 §2.3 规则表，1–9 条）。
 *
 * ## 这份文件现在是**派生视图**，不是第二份取值源
 *
 * 它的初版（MATT-41 / T4）是"规则表还没建"时的临时落点，文件头当时就写明了退场条件：
 * 「等规则表落地时，`action_config.receivers` 从库里读，这份常量退化成 seed 的
 * **单一取值源**」。规则表随 MATT-43 的迁移 0012 落地，而**取值源搬到了
 * `shared/automation/preset-rules.ts`**（9 条规则的完整定义，含 seed 的逐字投影）。
 *
 * 所以这里不再手写 `["follower","creator"]`：那是两份各写一遍，正是本文件要防的事。
 * 留下这一层是因为**消费方读的是"通知这一侧"而不是整条规则**——
 * `services/notifications.ts` 要的是 `receivers`，`scanDueNodes` 要的是
 * "节点提醒那条规则是谁"，它们不该各自去 `action_config` 里掏 jsonb。
 *
 * ## `creator` 这条线到底改了什么（别把它读成"顺手多推一个人"）
 *
 * IQ-8 的初裁是"创建者自动入列关注人"，IQ-13-V5 推翻了它：
 * **关注保持"主动 star 才算"的语义**，上报人**不入关注列表**（不写 `mn_user_watch` 行），
 * 回音改走通知中心。于是"上报人能不能看到下文"与"他关注了什么"被拆成两件事——
 * 前者由本文件的 `receivers` 负责，后者永远只由用户自己点 ⭐ 决定。
 *
 * 规则 5/6（节点开始/截止）**不含 `creator`**：它们是经办人的作业提醒，
 * 而上报人收到"你的事项有个节点 3 天后到期"没有可执行的动作，只会变成噪声（G3 反例）。
 * 规则 9（结案材料不全）**只给 `owner`**：关注人是被动 star 进来的，推给他们是噪音。
 */
import { notifyConfigOf, presetRule } from "@/shared/automation/preset-rules";
import type { NotifyReceiver } from "@/shared/enums/automation";

/** 规则在 §2.3 表里的编号。写成字段是为了排障时能直接把通知对回规则行 */
export type PresetNotifyRule = {
  /** 规则序号（§2.3 表格第一列） */
  ruleNo: number;
  /** 规则名（§2.3 表格第二列，逐字相同） */
  name: string;
  /** `action_config.template_code` */
  templateCode: string;
  /** `action_config.receivers` —— **顺序即 seed 里的字面量顺序**，别重排 */
  receivers: readonly NotifyReceiver[];
};

/** 从规则目录里取"通知这一侧"的视图。取值只有一处，所以不存在两份漂移的可能 */
function notifyView(ruleNo: number): PresetNotifyRule {
  const rule = presetRule(ruleNo);
  const config = notifyConfigOf(rule);
  return {
    ruleNo: rule.ruleNo,
    name: rule.name,
    templateCode: config.template_code,
    receivers: config.receivers as readonly NotifyReceiver[],
  };
}

/**
 * 状态变更通知关注人（规则 2）。
 *
 * `trigger_config` 是**空对象**（任意状态变更），与规则 1 的 `{status_code:"closed"}` 不同域——
 * 这是"归档也通知"曾经成立的地方，而 M4 的"什么时候不用"把它裁掉了：
 * **归档记录不再产生新通知**（`docs/PRD-phase1-alignment-m4.md`）。那条闸门在服务层，
 * 不在收件人表里——收件人表只回答"推给谁"，不回答"推不推"。
 */
export const RULE_STATUS_CHANGED_NOTIFY: PresetNotifyRule = notifyView(2);

/**
 * 新评论通知关注人（规则 8）。
 *
 * 与规则 7 同触发类型（`event_occurred`）但 `event` 不同，所以不同域、可同时启用。
 * 这条是"件件有回音"的**主回路**：Q14 把核查/反馈落到评论之后，
 * 上报人看到的第一条回音通常就是这里发出的。
 */
export const RULE_COMMENT_ADDED_NOTIFY: PresetNotifyRule = notifyView(8);

/** 节点开始提醒（规则 5）。收件人**不含 creator**，理由见文件头 */
export const RULE_NODE_START_NOTIFY: PresetNotifyRule = notifyView(5);

/** 节点截止提醒（规则 6）。同上 */
export const RULE_NODE_END_NOTIFY: PresetNotifyRule = notifyView(6);

/**
 * 转案件（`risk_converted` 领域事件）的通知口径。
 *
 * ⚠ **这一条必须写字面量，不能像上面四条那样从规则目录派生。**
 *
 * 起因是一次真实的全局故障：本文件一度写成 `notifyView(7)`，而规则 7
 * （`preset_07_risk_converted_archive`）的 `actionType` 是 **`archive`**、`actionConfig` 是 **`{}`**
 * —— 于是 `notifyView` 里的 `notifyConfigOf` 当场抛「规则 7 的动作不是 notify」。
 * 它是**模块加载期**的抛错，而 `services/notifications.ts` 被 `matters.ts`/`risks.ts` import
 * ⇒ **通知、评论、状态变更三条链路一起 500**（实测 `GET /api/notifications` → 500）。
 *
 * 根因不是"写错了行号"，而是**这条规则的形状与其它四条不同**：
 * 规则 2/5/6/8 本身就是"通知规则"（动作就是 notify），所以它们的通知口径能从
 * `action_config` 派生；而**规则 7 是"归档规则"，通知是它的副作用**
 * （§2.4 既裁：「转案件归档」无独立模板，复用 `case_archived`）。
 * 一个 archive 规则没有"通知这一侧"可派生——它的 `actionConfig` 里本来就没有那些键。
 *
 * 所以：**派生只对"动作就是 notify"的规则成立**。这一条按 §2.4 的字面量写。
 * 若日后真要把它也收进目录，得先给规则目录加一个"通知副作用"的落点，
 * 而不是从 `actionConfig` 里抠。
 */
export const RULE_RISK_CONVERTED_NOTIFY: PresetNotifyRule = {
  ruleNo: 7,
  name: "转案件后归档",
  // §2.4 既裁：「转案件归档」无独立模板，复用 `case_archived`
  templateCode: "case_archived",
  receivers: ["owner", "follower", "creator"],
};

/**
 * 结案后材料不全提醒（规则 9，MATT-43 / IQ-16）。
 *
 * 它是 `archive_incomplete` 这个事件类型的**唯一生产者**（T4 交付时 E29 的 8 个值里
 * `mention`/`stale_30d`/`archive_incomplete` 三个还没有生产者，本条补掉第三个；
 * `stale_30d` 由 MATT-61 补掉，至此 E29 只剩 `mention` 一档仍在 MATT-58 上）。
 * 收件人**只有经办人**：补材料的动作只有他能做，而关注人看到只会去问经办人。
 */
export const RULE_ARCHIVE_INCOMPLETE_NOTIFY: PresetNotifyRule = notifyView(9);

/**
 * 长期未更新提醒（规则 4）。
 *
 * **MATT-61 已给它接上生产者**（`services/stale-reminder.ts` + `shared/notification/stale-30d.ts`），
 * 所以从本票起 `stale_30d` 不再是"声明了但没有写入方"的事件类型。
 *
 * ⚠ **收件人是 `owner`，不是 `owner + follower`**：MATT-61 票面的括注里写的是
 * "owner + follower"，而规则目录与 seed（`db/seed/0006_automation_rules.sql:55`）
 * **一致地写着 `["owner"]`** —— 目录是唯一取值源且由 `preset-rules.seed.spec.ts` 机器对拉，
 * 所以以目录为准。差别是真实的推进行为：关注人收不到"30 天没进展"这条。
 * 若产品口径要改成含 follower，该改的是目录（连带 seed 与那份对拉单测），不是扫描器。
 */
export const RULE_STALE_30D_NOTIFY: PresetNotifyRule = notifyView(4);

/** 全部通知类预置规则，按规则号排。单测拿它做覆盖性断言 */
export const PRESET_NOTIFY_RULES: readonly PresetNotifyRule[] = [
  RULE_STATUS_CHANGED_NOTIFY,
  RULE_STALE_30D_NOTIFY,
  RULE_NODE_START_NOTIFY,
  RULE_NODE_END_NOTIFY,
  RULE_RISK_CONVERTED_NOTIFY,
  RULE_COMMENT_ADDED_NOTIFY,
  RULE_ARCHIVE_INCOMPLETE_NOTIFY,
];

/**
 * 上报人回音的两个触发点（IQ-13-V5 的落点，写成常量是为了让断言能引用它而不是抄字符串）。
 *
 * `status_changed` 的「已登记 → 进行中」首条即覆盖上报人的"件件有回音"体验
 * （`docs/PRD-phase1-g-targets-b5-draft.md` 措辞设计说明第 3 条）。
 */
export const CREATOR_ECHO_RULES: readonly PresetNotifyRule[] = [
  RULE_STATUS_CHANGED_NOTIFY,
  RULE_COMMENT_ADDED_NOTIFY,
];

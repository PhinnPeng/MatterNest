/**
 * 预置规则里**通知这一侧**的收件人口径（修订稿 §2.3 规则表，1–9 条）。
 *
 * ## 为什么这份表住在 shared 而不是某张库里
 *
 * 规则表（`mn_automation_rule`）第一期**还没建**：F5-7/F5-10 的规则列表与启停页属 M5 的另一条流。
 * 而"上报人回音"这条兑现机制（IQ-13-V5）不能等它——业务同事报了风险看不到下文，
 * 下次就不报了，这是登记率归零的真正原因。
 *
 * 所以这里落的是**规则 2/8 的收件人取值本身**，也就是 T0 把 `creator` 加进 E04 值域之后
 * 一直没接上的那根线。等规则表落地时，`action_config.receivers` 从库里读，
 * 这份常量退化成 seed 的**单一取值源**（`rule.receivers` 与它逐字相等由单测钉住），
 * 而不是被删掉——两份各写一遍 `["follower","creator"]` 正是它要防的事。
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
 */
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

/**
 * 状态变更通知关注人（规则 2）。
 *
 * `trigger_config` 是**空对象**（任意状态变更），与规则 1 的 `{status_code:"closed"}` 不同域——
 * 这是"归档也通知"曾经成立的地方，而 M4 的"什么时候不用"把它裁掉了：
 * **归档记录不再产生新通知**（`docs/PRD-phase1-alignment-m4.md`）。那条闸门在服务层，
 * 不在收件人表里——收件人表只回答"推给谁"，不回答"推不推"。
 */
export const RULE_STATUS_CHANGED_NOTIFY: PresetNotifyRule = {
  ruleNo: 2,
  name: "状态变更通知关注人",
  templateCode: "status_changed",
  receivers: ["follower", "creator"],
};

/**
 * 新评论通知关注人（规则 8）。
 *
 * 与规则 7 同触发类型（`event_occurred`）但 `event` 不同，所以不同域、可同时启用。
 * 这条是"件件有回音"的**主回路**：Q14 把核查/反馈落到评论之后，
 * 上报人看到的第一条回音通常就是这里发出的。
 */
export const RULE_COMMENT_ADDED_NOTIFY: PresetNotifyRule = {
  ruleNo: 8,
  name: "新评论通知关注人",
  templateCode: "comment_new",
  receivers: ["follower", "creator"],
};

/** 节点开始提醒（规则 5）。收件人**不含 creator**，理由见文件头 */
export const RULE_NODE_START_NOTIFY: PresetNotifyRule = {
  ruleNo: 5,
  name: "节点开始提醒",
  templateCode: "node_start",
  receivers: ["owner", "follower"],
};

/** 节点截止提醒（规则 6）。同上 */
export const RULE_NODE_END_NOTIFY: PresetNotifyRule = {
  ruleNo: 6,
  name: "节点截止提醒",
  templateCode: "node_end",
  receivers: ["owner", "follower"],
};

/** 转案件（`risk_converted` 领域事件）的通知口径 */
export const RULE_RISK_CONVERTED_NOTIFY: PresetNotifyRule = {
  ruleNo: 7,
  name: "转案件后归档",
  // §2.4 既裁：「转案件归档」无独立模板，复用 `case_archived`
  templateCode: "case_archived",
  receivers: ["owner", "follower", "creator"],
};

/** 全部通知类预置规则，按规则号排。单测拿它做覆盖性断言 */
export const PRESET_NOTIFY_RULES: readonly PresetNotifyRule[] = [
  RULE_STATUS_CHANGED_NOTIFY,
  RULE_COMMENT_ADDED_NOTIFY,
  RULE_NODE_START_NOTIFY,
  RULE_NODE_END_NOTIFY,
  RULE_RISK_CONVERTED_NOTIFY,
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

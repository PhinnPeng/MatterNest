/**
 * 提醒、通知与 outbox（枚举表 §2 的 E23–E25，§2 补登的 E29–E32）。
 * 权威源：`docs/PRD-phase1-enums-and-schemas.md`；取值语义在 `docs/PRD-phase1-design-revision-r1.md` §7.2。
 *
 * 本文件最容易出事的一条：**E23（提醒任务态）与 E31（投递态）不能合并**。
 * 两个表里都有 `pending`/`sent`/`failed`，看起来像同一套，但：
 *   · 提醒层有 `cancelled` = 用户主动撤销；
 *   · 投递层有 `void` = 收件人不可见而静默丢弃（权限草案 §8），用户看不见、也无从撤销。
 * 合成一套的后果是"撤销的提醒"与"因权限没投递"在排障时无法区分，而后者是安全事件线索。
 */

import { DOMAIN_EVENT_TYPE_LABELS, type DomainEventType } from "./automation";

/** E23 `custom_reminder.status`（取代原 `is_sent boolean`，它承载不了 `repeat_type`） */
export const REMINDER_STATUSES = ["pending", "sent", "cancelled", "failed"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];
export const REMINDER_STATUS_LABELS: Record<ReminderStatus, string> = {
  pending: "待提醒",
  sent: "已发送",
  cancelled: "已取消",
  failed: "发送失败",
};
export const DEFAULT_REMINDER_STATUS: ReminderStatus = "pending";

/** E24 `custom_reminder.repeat_type`：有值时 `next_remind_time` 由发送成功后按此推进 */
export const REPEAT_TYPES = ["none", "daily", "weekly", "monthly", "yearly"] as const;
export type RepeatType = (typeof REPEAT_TYPES)[number];
export const REPEAT_TYPE_LABELS: Record<RepeatType, string> = {
  none: "不重复",
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
};
export const DEFAULT_REPEAT_TYPE: RepeatType = "none";

/**
 * E25 `notify_channel`：第一期只有两个。
 * 企微/钉钉**留扩展位但不进 CHECK**（枚举表 E25）——进了 CHECK 就等于对外承诺一期能发。
 */
export const NOTIFY_CHANNELS = ["in_app", "email"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];
export const NOTIFY_CHANNEL_LABELS: Record<NotifyChannel, string> = {
  in_app: "站内",
  email: "邮件",
};
export const DEFAULT_NOTIFY_CHANNEL: NotifyChannel = "in_app";
/** 明确"知道有、但不做"的那两个，防止有人以为漏写了 */
export const RESERVED_NOTIFY_CHANNELS = ["wecom", "dingtalk"] as const;

/** E29 `notification_event.event_type`（7 值；`expense_added` 已于 2026-09-26 裁定删除） */
export const NOTIFICATION_EVENT_TYPES = [
  "status_changed",
  "node_due_start",
  "node_due_end",
  "stale_30d",
  "mention",
  "new_comment",
  "risk_converted",
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export const NOTIFICATION_EVENT_TYPE_LABELS: Record<NotificationEventType, string> = {
  status_changed: "状态变更",
  node_due_start: "节点开始提醒",
  node_due_end: "节点截止提醒",
  stale_30d: "30 天无更新",
  mention: "被 @提及",
  new_comment: "新评论",
  risk_converted: "事项转案件",
};
/** 已作废值登记：历史数据与旧文档里仍会出现，禁止再当新事件写入 */
export const RETIRED_NOTIFICATION_EVENT_TYPES = ["expense_added"] as const;

/** E30 `notification_event.source_type`：去重与排障按它分流 */
export const NOTIFICATION_SOURCE_TYPES = ["node_remind", "custom_reminder", "auto_rule"] as const;
export type NotificationSourceType = (typeof NOTIFICATION_SOURCE_TYPES)[number];
export const NOTIFICATION_SOURCE_TYPE_LABELS: Record<NotificationSourceType, string> = {
  node_remind: "节点提醒扫描",
  custom_reminder: "自定义提醒",
  auto_rule: "自动化规则",
};

/** E31 `notification_delivery.status`：注意 `void` 与 E23 的 `cancelled` 不是一回事（见文件头） */
export const DELIVERY_STATUSES = ["pending", "sent", "failed", "void"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "待投递",
  sent: "已投递",
  failed: "投递失败",
  void: "静默丢弃（收件人不可见）",
};
export const DEFAULT_DELIVERY_STATUS: DeliveryStatus = "pending";

/**
 * E32 `event_outbox.event_type`：只承载"提交后派发"的领域事件，与 E33 **同值域**。
 * 同值域就不写两份 —— 定义住在 `./automation`（E33 是它的原生位置），这里只做再导出。
 * 两份数组的必然后果是"加了 outbox 事件忘了 trigger 事件"，而那正好让规则 7/8 静默失配。
 */
export { DOMAIN_EVENT_TYPES as OUTBOX_EVENT_TYPES } from "./automation";
/** 类型别名而不是再导出：值域与 E33 同源，命名保留本表口径 */
export type OutboxEventType = DomainEventType;
export const OUTBOX_EVENT_TYPE_LABELS = DOMAIN_EVENT_TYPE_LABELS;

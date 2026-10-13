# 通知分三层：领域事件 / 通知事件 / 投递行；加渠道不产生事件

通知这条链上有三样东西，**不是同一层的三个东西**：领域事件（E32 `DOMAIN_EVENT_TYPES`，2 值）说「业务里发生了一件事」，通知事件（E29 `NOTIFICATION_EVENT_TYPES`，8 值）说「这件事该告诉谁」，而「谁、走哪条渠道、发没发成」全部落在 `mn_notification_delivery` 的行上。裁定：**加渠道不产生通知事件**，渠道不是通知事件的订阅者，而是投递行最后一跳的**执行端**。

## 为什么是这个形状（而不是别的）

**证据已经在表结构里，不必重新论证。**

- `dedupe_key` 在 `notification_event` 上、**不在** `delivery` 上（`schema/notifications.ts:86`）⇒ 事件一次发生，投递 N 次。
- 唯一键是 `(eventId, userId, channel)` 三元组（`:159`）⇒ 同一事件对同一人**每渠道一行**。
- 一期唯一的消费者（`listNotifications`，`notifications.ts:1173-1187`）是 `.from(notificationDelivery).innerJoin(notificationEvent, …)` ⇒ **主表是投递行**，事件只是被 join 来取 payload 渲染正文。
- 收件人解析与可见性判定在**写事件之前**就跑完了（`emitForHost` → `resolveRecipients` + `canSeeHost`，`:406`）⇒ 渠道拿到的是**已展开的收件人清单**，不必自己查。

**另一条同源的裁定：时间型与状态型通知保持轮询，不事件化。** 8 个通知事件里只有 2 个（`risk_converted`、`comment_added`）走 outbox，是真·领域事件；`node_due_start`/`node_due_end` 是**时间触发**（"还有 3 天"不是发生了，是某一天为真），`stale_30d`/`archive_incomplete` 是**状态谓词**（"30 天没更新"是对当前状态的判断）。把这两类事件化要么徒增机器（要额外记「上次判为否的那天」再在翻转时发），要么根本做不到——检测时间跳变本身就要时钟驱动扫描。「领域事件驱动」是**其中一件事该用的形状，不是全局方针。**

## Consequences

- ⚠ **一期没有投递器，「投递 = 入库」这个等式成立**：`insertNotificationEvent`（`:309-403`）对每个收件人直接写 `status='sent'`、`attempt=0`。**接真渠道的第一步不是加渠道，是补一个投递器**——把 delivery 行从 `pending` 推到 `sent`/`failed` 并写 `next_retry_at`，因为邮件的「投递」发生在应用之外，`sent` 必须在真的发出之后才能打。
- ⚠ **重试机制是空壳**：`DELIVERY_STATUSES = ["pending","sent","failed","void"]`（`notify.ts:118`）与 `next_retry_at`/`attempt`/`error` 三列全在，但**`pending` 与 `failed` 零生产者**。别把「表里有列」读成「重试已实现」。
- ⚠ **`wecom`/`dingtalk` 只预留到 TypeScript 层**：`RESERVED_NOTIFY_CHANNELS`（`notify.ts:49`）看着像云之家已留好门，但 CHECK 约束用的是 `NOTIFY_CHANNELS = ["in_app","email"]`（`schema/notifications.ts:157`）⇒ **现在往库里写 `wecom` 会被拒**。接渠道还要一条改 CHECK 的迁移。
- `recipient_count` 记的是**这条消息总共发给了几个人**，不是人次（`:398-401`）。一个事件对 10 人 × 2 渠道 = 20 次尝试，成败各不相同，所以重试次数只能挂在 delivery 行上——挂到事件上就丢了。
- **渠道不得重做收件人解析、可见性判定、不可见降级占位、正文渲染**——这些在 `insertNotificationEvent` / `intentsOfOutboxRow` 里已经有一套。`notifications.ts:578` 那句注释挡的就是这个：「另开一条直发路径会让 @ 提及绕开 `dedupe_key` 唯一键与至少一次重放」。
- **领域服务要响应业务反应，订阅领域事件（E32），不是通知事件。** 混层的后果是接渠道时开始考虑「邮件要不要也走一遍领域服务」，那条路走下去就是渠道逻辑渗进业务逻辑。⚠ 现状有个洞：**E32 只有 2 个值**（`automation.ts:129`），`status_changed` 不在其中，所以今天**没有任何可供领域服务订阅的「状态变更」领域事件**——想订阅的人只能去订阅通知事件，那正是混层的起点。
- `status_changed` 仍在**业务事务内**直接写通知（`notifyStatusChanged`，`:487`），不过 outbox。代价与取舍单列，不在本 ADR 范围。

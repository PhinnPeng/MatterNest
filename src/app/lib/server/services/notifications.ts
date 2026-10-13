import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count as dcount,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { nextId } from "@/shared/ids/snowflake";
import {
  NOTIFICATION_EVENT_TYPE_LABELS,
  PHASE1_NOTIFY_CHANNEL,
  type NotificationEventType,
  type NotificationSourceType,
} from "@/shared/enums/notify";
import { CUSTOM_RECEIVER_KEY, type NotifyReceiver } from "@/shared/enums/automation";
import { immediateDedupeKey, scheduledDedupeKey } from "@/shared/notification/dedupe";
import { parseMentionIds } from "@/shared/notification/mention";
import {
  INVISIBLE_NOTIFICATION_TITLE,
  renderNotification,
  type TemplateRow,
} from "@/shared/notification/template";
import {
  RULE_COMMENT_ADDED_NOTIFY,
  RULE_NODE_END_NOTIFY,
  RULE_NODE_START_NOTIFY,
  RULE_RISK_CONVERTED_NOTIFY,
  RULE_STATUS_CHANGED_NOTIFY,
} from "@/shared/notification/preset-rules";
import {
  SCAN_WINDOW_MAX_DAYS,
  SCANNABLE_NODE_STATUSES,
  pickDueReminders,
} from "@/shared/notification/scan";
import { businessDateKey, businessDayStartIso } from "@/shared/time/zh-cn";
import { getDb } from "../db/client";
import {
  appUser,
  appUserRole,
  comment,
  eventOutbox,
  matter,
  matterNode,
  matterStaff,
  notificationDelivery,
  notificationEvent,
  notificationTemplate,
  riskMatter,
  riskMatterNode,
  riskMatterStaff,
  role,
} from "../db/schema";
import { HOSTS, scopedWhere, visibility, type HostKind } from "../scope/visibility";
import type { Actor } from "../auth/auth";
import type { DataScope } from "@/shared/enums";

/**
 * 通知管线（MATT-41 / T4）：outbox 生产与消费、聚合去重、收件人解析、通知中心读写、节点到期扫描。
 *
 * ## 四个决定，都不是风格
 *
 * 1. **投递只走 outbox，不直发。** 业务事务里只做两件事：把"发生了什么"落成 outbox 行
 *    （`comment_added` / `risk_converted`，E32 的两个值），或把"该通知谁"落成
 *    `mn_notification_event` + `mn_notification_delivery`（状态变更——它的触发是同步的，
 *    而 E32 的值域被"与 E33 同值域"锁死，加不进 `status_changed`）。
 *    两条路都不在事务里做"投递"这个动作本身。
 * 2. **去重靠 `dedupe_key` 唯一键，不靠应用层判重**（§7.2 合并规则 4）。outbox 的投递语义是
 *    **至少一次**，重放同一行是正常路径——`ON CONFLICT (dedupe_key) DO NOTHING` 是它成立的唯一前提。
 * 3. **正文读取时渲染，不落快照**（权限草案 §7.1）。`title`/`body` 两列恒 NULL，
 *    文案每次读取从 `template + payload` 现算。
 * 4. **归档记录不产生新通知**（`docs/PRD-phase1-alignment-m4.md`「什么时候不用」）。
 *    判定统一按"宿主**写入后**是否已归档"：`→ archived` 那一步是静默的，
 *    撤销归档之后的通知照常发（那时它已经不是归档记录了）。
 *
 * ## 一期没有调度器，消费靠"表 + 轮询"
 *
 * 单副本部署、不引 Redis（技术栈裁定）。所以 `pumpNotifications()` 由通知中心的读请求触发：
 * 先抽干待投递的 outbox，再跑一遍节点到期扫描。两件事都**幂等**——
 * 前者靠 `dedupe_key`，后者靠"同目标同业务日"的 scheduled key，
 * 所以"每次读都跑一遍"不会产生第二条通知，只是白跑几次索引扫描（两张节点表各一次）。
 */

type Db = Awaited<ReturnType<typeof getDb>>;
/** 事务句柄：从回调参数上取（与 services/nodes.ts、services/parties.ts 同一取法） */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** 只读句柄：事务内外都能用（`tx` 与 `db` 在这两个用途上结构相同） */
type Reader = Tx | Db;

/** outbox 消费的批量上限。够大以免积压，够小以免一次读请求跑几十秒 */
export const OUTBOX_BATCH = 50;
/** 单次扫描每张节点表的行数上限。窗口已经把范围压到"最近会到期的那批" */
export const SCAN_BATCH = 500;

/* ────────────────────────────────────────────────────────────────────────────
 * 一、宿主读取与收件人解析
 * ──────────────────────────────────────────────────────────────────────────── */

/** 通知要用到的宿主事实。`code` 进模板的 `{code}`，`name` 进 `{name}` */
export type NotifyHostFacts = {
  code: string;
  name: string;
  ownerId: bigint | null;
  createdBy: bigint | null;
  isArchived: boolean;
};

export async function loadHostFacts(
  r: Reader,
  host: HostKind,
  hostId: bigint,
): Promise<NotifyHostFacts | null> {
  if (host === "matter") {
    const [row] = await r
      .select({
        code: matter.internalCode,
        name: matter.name,
        ownerId: matter.ownerId,
        createdBy: matter.createdBy,
        isArchived: matter.isArchived,
      })
      .from(matter)
      .where(eq(matter.id, hostId))
      .limit(1);
    return row ?? null;
  }
  const [row] = await r
    .select({
      code: riskMatter.code,
      name: riskMatter.name,
      ownerId: riskMatter.ownerId,
      createdBy: riskMatter.createdBy,
      isArchived: riskMatter.isArchived,
    })
    .from(riskMatter)
    .where(eq(riskMatter.id, hostId))
    .limit(1);
  return row ?? null;
}

/**
 * 收件人解析（§4.3 `action_config.receivers` 的落地）。
 *
 * `creator` 这一档就是 IQ-13-V5 的接线点：**上报人的回音走这里，不走关注列表**。
 * 它读的是宿主行的 `created_by`（创建人），而不是 `mn_user_watch` 里的任何一行——
 * 后者是"主动 star 才算"的语义，混进被动行会把它污染掉（M4 US-1 原话）。
 *
 * 返回**去重到 user 级**的 id：一人多角色（既是 owner 又是 follower）只收一条
 * （§7.2 合并规则 2：命中角色重叠 → 收件人集合去重到 user 级）。
 */
export async function resolveRecipients(
  r: Reader,
  host: HostKind,
  hostId: bigint,
  facts: NotifyHostFacts,
  receivers: readonly NotifyReceiver[],
  customUserIds: readonly string[] = [],
): Promise<bigint[]> {
  const out = new Set<string>();
  const wanted = new Set(receivers);

  if (wanted.has("owner") && facts.ownerId !== null) out.add(String(facts.ownerId));
  // ⚠ 上报人回音的落点。`created_by` 可空（历史行/系统写入），空则这一档无人可发
  if (wanted.has("creator") && facts.createdBy !== null) out.add(String(facts.createdBy));

  const staffRoles: string[] = [];
  if (wanted.has("co_owner")) staffRoles.push("co_owner");
  if (wanted.has("follower")) staffRoles.push("follower");
  if (staffRoles.length > 0) {
    const staff = host === "matter" ? matterStaff : riskMatterStaff;
    const rows = await r
      .select({ userId: staff.userId })
      .from(staff)
      .where(and(eq(staff.hostId, hostId), inArray(staff.staffRole, staffRoles)));
    for (const row of rows) out.add(String(row.userId));
  }

  if (wanted.has("custom")) for (const id of customUserIds) out.add(String(id));
  return [...out].map(BigInt);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 二、投递可见性（权限草案 §8：不可见者静默剔除）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 收件人的范围事实（一次查完，避免每个收件人各查一遍角色） */
async function recipientScopes(
  r: Reader,
  userIds: readonly bigint[],
): Promise<Map<string, { dataScope: DataScope; isAdmin: boolean }>> {
  const map = new Map<string, { dataScope: DataScope; isAdmin: boolean }>();
  if (userIds.length === 0) return map;
  const rows = await r
    .select({
      userId: appUser.id,
      isAdmin: appUser.isAdmin,
      dataScope: role.dataScope,
    })
    .from(appUser)
    .leftJoin(appUserRole, eq(appUserRole.userId, appUser.id))
    .leftJoin(role, eq(role.id, appUserRole.roleId))
    .where(inArray(appUser.id, [...userIds]));
  for (const row of rows) {
    const key = String(row.userId);
    const prev = map.get(key);
    // 多角色取最宽并集：与 `readActor` 的口径一致（权限草案 §2）。
    // 这里刻意**不复用** widestDataScope 的排序表，而是用"已知 all 就锁定"的短路——
    // 见下面 `widen`，两处都不许退化成"取最后一个角色"。
    const scope = (row.dataScope ?? "owned") as DataScope;
    map.set(key, {
      dataScope: prev ? widen(prev.dataScope, scope) : scope,
      isAdmin: (prev?.isAdmin ?? false) || row.isAdmin,
    });
  }
  return map;
}

/** 范围并集：`all` > `participating` > `owned`。未知值按 `owned`（与 `visibility()` 同一条兜底） */
function widen(a: DataScope, b: DataScope): DataScope {
  const rank: Record<string, number> = { owned: 0, participating: 1, all: 2 };
  const ra = rank[a] ?? 0;
  const rb = rank[b] ?? 0;
  return ra >= rb ? a : b;
}

/**
 * 某个收件人能不能看见这条宿主。
 *
 * **可见性只有一个出口**：这里调的是 `scope/visibility.ts` 的 `visibility()`，
 * 不自己拼范围条件（禁令：不写 `owner_id = …`）。查不到角色的人按"看不见"处理——
 * 默认拒绝（权限草案 §1 元规则 1）。
 */
async function canSeeHost(
  r: Reader,
  host: HostKind,
  hostId: bigint,
  userId: bigint,
  scope: { dataScope: DataScope; isAdmin: boolean } | undefined,
): Promise<boolean> {
  const t = HOSTS[host].table;
  const vis = visibility(
    host,
    scope?.dataScope ?? "owned",
    String(userId),
    scope?.isAdmin ?? false,
  );
  const [row] = await r
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, hostId), sql`NOT ${t.isDeleted}`, vis))
    .limit(1);
  return Boolean(row);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 三、事件 + 投递的写入（唯一入口）
 * ──────────────────────────────────────────────────────────────────────────── */

export type NotificationIntent = {
  eventType: NotificationEventType;
  sourceType: NotificationSourceType;
  sourceRuleId?: bigint | null;
  host: HostKind;
  hostId: bigint;
  /** 指向的业务对象。宿主本身用 `matter`/`risk_matter`，节点提醒用 `*_node` */
  targetType: string;
  targetId: bigint;
  batchId: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  recipients: readonly bigint[];
  windowStart?: string | null;
  windowEnd?: string | null;
  /**
   * 收件人**此刻看不到宿主**时怎么处置（MATT-58 / T4b 加的，只有 `mention` 用它）。
   *
   * · 缺省 / `false`：写 `status='void'` 静默剔除，行不进收件箱。
   *   依据 `docs/PRD-phase1-permission-design-draft.md:233`（§8）：
   *   「`notify` 的收件人解析后逐个校验可见性，不可见者静默剔除（不发"无权查看"的空通知）」。
   * · `true`：照常投递（`sent`），由通知中心的**读取时**可见性判定把它渲染成
   *   「无权查看的记录」占位（§7.1:192）——行在、标题被替换、摘要字段一个不发。
   *
   * **为什么 `mention` 走后者**：§8 那条按字面只圈了 `notify` **动作**的收件人，
   * 而设计稿 `design-revision-r1.md:156` 明写 `mention`「**不经规则引擎**，由评论服务直接发事件」——
   * 它不落在 §8 的字面范围里。而 §7.1 给占位的理由（「不隐藏整行——隐藏会被当成数据丢失
   * 而去追问，占位能自助解释」）恰好就是 @ 提及的场景：被点名的同事需要知道
   * 「有人找我了，但我现在看不到这条记录」，才能去要权限。
   * 若这里也静默剔除，@ 一个非参与人就会**什么都不发生**——正是本票要挡的失败形态。
   */
  invisibleAsPlaceholder?: boolean;
};

export type InsertEventResult = { eventId: bigint | null; delivered: number; merged: boolean };

/**
 * 落一条通知事件 + 它的投递行。**这是全项目唯一一处写 `mn_notification_event` 的地方。**
 *
 * `merge_count` 按 §7.2 的字面口径记：**被本事件吸收掉的原始条数**（0 = 没发生聚合）。
 * 所以"一次转案件生成 2 个案件"落出来的是 `merge_count=1`——一条事件吸收了另一条。
 * 不去记"本事件由几条合成"：那会把"聚合到底生效没有"变成一个需要减法的判断。
 */
export async function insertNotificationEvent(
  tx: Tx,
  intent: NotificationIntent,
): Promise<InsertEventResult> {
  const eventId = BigInt(nextId());
  const inserted = await tx
    .insert(notificationEvent)
    .values({
      id: eventId,
      dedupeKey: intent.dedupeKey,
      eventBatchId: intent.batchId,
      eventType: intent.eventType,
      sourceType: intent.sourceType,
      sourceRuleId: intent.sourceRuleId ?? null,
      targetType: intent.targetType,
      targetId: intent.targetId,
      hostId: intent.hostId,
      // title/body 恒 NULL：§7.1 裁定不落渲染快照，正文读取时现算（见 schema 文件头）
      payload: intent.payload,
      windowStart: intent.windowStart ?? null,
      windowEnd: intent.windowEnd ?? null,
      recipientCount: 0,
      mergeCount: 0,
    })
    .onConflictDoNothing({ target: notificationEvent.dedupeKey })
    .returning({ id: notificationEvent.id });

  if (inserted.length === 0) {
    // 已经被吸收：这是"同批多条聚合为一条"的**唯一证据来源**，别把它当成无事发生
    await tx
      .update(notificationEvent)
      .set({ mergeCount: sql`${notificationEvent.mergeCount} + 1` })
      .where(eq(notificationEvent.dedupeKey, intent.dedupeKey));
    return { eventId: null, delivered: 0, merged: true };
  }

  const scopes = await recipientScopes(tx, intent.recipients);
  let delivered = 0;
  for (const userId of intent.recipients) {
    const visible = await canSeeHost(
      tx,
      intent.host,
      intent.hostId,
      userId,
      scopes.get(String(userId)),
    );
    /**
     * `placeholder` = "看不见，但这一条仍要投递，由读取侧降级成占位"。
     * 它只可能由 `invisibleAsPlaceholder` 打开（见 `NotificationIntent` 的注释）。
     * `delivered` 按**真正投出去的行**计（`sent`），不按"看得见的行"计——
     * §7.2 说 `recipient_count` 是"这条消息发给了几个人"，占位行也是发出去的。
     */
    const placeholder = !visible && intent.invisibleAsPlaceholder === true;
    const sent = visible || placeholder;
    if (sent) delivered++;
    await tx
      .insert(notificationDelivery)
      .values({
        id: BigInt(nextId()),
        eventId,
        userId,
        channel: PHASE1_NOTIFY_CHANNEL,
        // 站内渠道的"投递"就是这一行出现在收件箱里，所以可见即 `sent`
        status: sent ? "sent" : "void",
        attempt: 0,
        sentAt: sent ? new Date().toISOString() : null,
        // `void` 的原因留在这里而不是丢掉：权限草案 §8 说"静默剔除"是**对用户静默**，
        // 而枚举表 E31 的注记把这类行点名为"安全事件线索"——线索要能被查到。
        //
        // 占位行（`sent` 但收件人当时看不见）也留一条痕迹：读取侧渲染时
        // "投递时就不看见"与"投递后失权"长得一模一样，而排障要能分开这两件事。
        error: visible
          ? null
          : placeholder
            ? "recipient_cannot_see_host_placeholder"
            : "recipient_cannot_see_host",
        isRead: false,
        readAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoNothing({
        target: [
          notificationDelivery.eventId,
          notificationDelivery.userId,
          notificationDelivery.channel,
        ],
      });
  }
  await tx
    .update(notificationEvent)
    .set({ recipientCount: delivered })
    .where(eq(notificationEvent.id, eventId));
  return { eventId, delivered, merged: false };
}

/** 解析收件人 + 落事件，一步到位。业务侧只关心"这件事该通知谁" */
async function emitForHost(
  tx: Tx,
  args: {
    host: HostKind;
    hostId: bigint;
    facts: NotifyHostFacts;
    eventType: NotificationEventType;
    sourceType: NotificationSourceType;
    receivers: readonly NotifyReceiver[];
    /**
     * 显式收件人（配 `receivers` 含 `custom`）。@提及走这一档：
     * 被 @ 的人**不是**任何角色档位解析出来的，而是正文里点了名的那几个。
     */
    customUserIds?: readonly string[];
    /**
     * 解析完角色档位后**再减掉**的人（§7.2 合并规则 1）。
     *
     * 与 `customUserIds` 同一个层次：作用在"这次解析出来的**具体人**"上，而不是档位上
     * ——档位是规则的输入（规则 8 就是 `["follower","creator"]`），被减的是同批里
     * 已经收过更具体那条（`mention`）的人。
     */
    excludeUserIds?: readonly string[];
    targetType?: string;
    targetId?: bigint;
    batchId: string;
    payload: Record<string, unknown>;
    windowStart?: string | null;
    windowEnd?: string | null;
    invisibleAsPlaceholder?: boolean;
  },
): Promise<InsertEventResult> {
  const excluded = new Set((args.excludeUserIds ?? []).map(String));
  const recipients = (
    await resolveRecipients(
      tx,
      args.host,
      args.hostId,
      args.facts,
      args.receivers,
      args.customUserIds ?? [],
    )
  ).filter((id) => !excluded.has(String(id)));
  // 减完为空 ⇒ 不落事件。这一条正是"被 @ 的关注人不会再收一条广播"的收口：
  // 若全批的 follower ∪ creator 都被 @ 了，这条广播就没有收件人，留一条空事件毫无意义
  if (recipients.length === 0) return { eventId: null, delivered: 0, merged: false };
  const targetId = args.targetId ?? args.hostId;
  return insertNotificationEvent(tx, {
    eventType: args.eventType,
    sourceType: args.sourceType,
    host: args.host,
    hostId: args.hostId,
    targetType: args.targetType ?? args.host,
    targetId,
    batchId: args.batchId,
    dedupeKey: immediateDedupeKey({
      eventType: args.eventType,
      targetId,
      batchId: args.batchId,
      recipients,
    }),
    payload: args.payload,
    recipients,
    windowStart: args.windowStart ?? null,
    windowEnd: args.windowEnd ?? null,
    invisibleAsPlaceholder: args.invisibleAsPlaceholder,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 四、生产点（都在业务事务里，见文件头第 1 条）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 状态变更的通知意图（预置规则 2，收件人 `["follower","creator"]`）。
 *
 * **在业务写同一事务里调用**。事后再补会丢：状态已经变了、事务已经提交，
 * 而"该通知谁"要在同一时刻读 `*_staff` 与 `created_by` 才准。
 *
 * `isArchivedAfter` 是**写入后**的归档态：`→ archived` 这一步静默
 * （M4「什么时候不用」：归档记录不再产生新通知），撤销归档之后照常发。
 */
export async function notifyStatusChanged(
  actor: Actor,
  tx: Tx,
  args: {
    host: HostKind;
    hostId: bigint;
    from: string;
    to: string;
    /**
     * 状态**显示名**（`mn_status_config.name`），不是 code。
     *
     * 通知是给人读的：`{from} → {to}` 渲染成 `已登记 → 进行中`，
     * 而 code（`pending`/`in_progress`）是配置页与规则引用的写法。
     * IQ-5/6 专门把显示名改成"已登记/了结/已结案"就是为了去掉流程暗示——
     * 通知文案里退回 code 等于把那次改名在用户可见处抹掉。
     */
    fromName: string;
    toName: string;
    isArchivedAfter: boolean;
  },
): Promise<InsertEventResult> {
  if (args.isArchivedAfter) return { eventId: null, delivered: 0, merged: false };
  const facts = await loadHostFacts(tx, args.host, args.hostId);
  if (!facts) return { eventId: null, delivered: 0, merged: false };
  return emitForHost(tx, {
    host: args.host,
    hostId: args.hostId,
    facts,
    eventType: "status_changed",
    sourceType: "auto_rule",
    receivers: RULE_STATUS_CHANGED_NOTIFY.receivers,
    batchId: randomUUID(),
    payload: {
      code: facts.code,
      name: facts.name,
      from: args.fromName || args.from,
      to: args.toName || args.to,
      actor: actor.displayName,
    },
  });
}

/**
 * 评论正文里的 @提及 → 收件人 id（MATT-58 / T4b）。
 *
 * **全项目唯一一处把"评论里的 `@`"接到通知线上"**：候选人是全体**在职且已开通**的账号，
 * 不是宿主的参与人。理由有两条，缺一条这个功能就废：
 *
 * · AC 要求"被 @ 的人看不到宿主时走不可见降级占位"——若候选人只在参与人里挑，
 *   "看不到宿主"这一档**根本产生不出来**，那条 AC 就成了空转；
 * · 实际用法是"@ 一个还没进来的同事帮我看下"，而 §4.1 的共现规则要**创建之后**
 *   才让他成为参与人。先 @ 后授权是这个功能的正常时序，不是边角。
 *
 * 花名册无保密价值（IQ-14 同一条理由：十人企业，"防枚举"在此为空转顾虑）。
 * 过滤 `is_enabled` 与 `activation_status='active'`：离职/未开通的账号登不进来看不到通知，
 * 把他们解析成收件人只会留下一堆永远不读的投递行。
 *
 * 解析本身是纯函数（`shared/notification/mention.ts`），这里只负责取候选人。
 */
export async function resolveMentionIds(r: Reader, body: string): Promise<string[]> {
  const rows = await r
    .select({ id: appUser.id, displayName: appUser.displayName })
    .from(appUser)
    .where(
      and(
        eq(appUser.isEnabled, true),
        eq(appUser.activationStatus, "active"),
        sql`NOT ${appUser.isDeleted}`,
      ),
    );
  return parseMentionIds(
    body,
    rows.map((x) => ({ id: String(x.id), displayName: x.displayName })),
  );
}

/**
 * 新评论的通知意图 —— **只写 outbox，不在这里发**。
 *
 * 为什么评论走 outbox 而状态变更不走：评论对应 E32/E33 的 `comment_added` 领域事件
 * （规则 8 的触发条件就是它），而状态变更对应的是 `status_changed` **触发器**，
 * 不在 E32 的值域里——E32 与 E33 被"同值域、单实现"锁死，往里加值等于同时改两张表的口径。
 *
 * 归档宿主直接不写：归档记录不再产生新通知（M4）。
 * ⚠ **归档后仍可新增评论**（基线 1.7 明文），只是不发通知——所以这里返回 false 而不是抛。
 *
 * ## 一行 outbox 承载两个事件（MATT-58）
 *
 * `mention` 与 `new_comment` **共用这一行**，消费侧再展开成两条意图：
 * 设计稿 `design-revision-r1.md:156` 说 `mention`「不经规则引擎，由评论服务直接发事件」，
 * 而"直接发事件"在本仓的兑现方式就是**写 outbox**（T4 已裁定"E32 允许处走 outbox"）。
 * 另开一条直发路径会让 @ 提及绕开 `dedupe_key` 唯一键与至少一次重放——
 * 那正是 T4 花力气统一掉的东西。
 */
export async function enqueueCommentIntent(
  actor: Actor,
  tx: Tx,
  args: {
    host: HostKind;
    hostId: bigint;
    commentId: bigint;
    quoted: string;
    /**
     * 正文里 @ 到的人（`resolveMentionIds` 的结果）。
     *
     * **必填，不给默认值**：漏传会让 `mention` 静默不生效——而"@ 了人但通知没发出去"
     * 正是本票要挡的失败形态，界面一切正常、没人会发现。写成可选参数就等于
     * 把这个失败形态留在类型系统里等下一次调用点踩。
     */
    mentionIds: readonly string[];
  },
): Promise<boolean> {
  const facts = await loadHostFacts(tx, args.host, args.hostId);
  if (!facts || facts.isArchived) return false;
  await tx.insert(eventOutbox).values({
    id: BigInt(nextId()),
    eventType: "comment_added",
    // batch_id 是**一次业务操作**的批次号；一条评论就是一次操作。
    // 它同时是通知侧的 `event_batch_id`，透传后让"同批多条"能聚合（§7.2）
    batchId: randomUUID(),
    payload: {
      host_type: args.host,
      host_id: String(args.hostId),
      comment_id: String(args.commentId),
      author_id: actor.userId,
      author_name: actor.displayName,
      quoted: args.quoted,
      // 被 @ 的人随行落进 payload，而不是让消费侧回头再解析一遍正文：
      // 消费是**至少一次**的，重放时若候选人名单已经变了（有人停用/改名），
      // 二次解析会得到不同的收件人集合 ⇒ 不同的 dedupe_key ⇒ 第二条通知。
      // 事件发生那一刻的收件人是事实，事实进 payload。
      mention_ids: [...args.mentionIds],
    },
  });
  return true;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 五、消费侧：抽干 outbox
 * ──────────────────────────────────────────────────────────────────────────── */

export type OutboxRow = {
  id: bigint;
  eventType: string;
  batchId: string;
  payload: Record<string, unknown>;
};

/** 一条 outbox 行展开出的**一种**通知意图（`payloads` 里的每条各落一个事件） */
export type OutboxIntent = {
  host: HostKind;
  hostId: bigint;
  eventType: NotificationEventType;
  /** 角色档位收件人。`mention` 用 `["custom"]` + `customUserIds` */
  receivers: readonly NotifyReceiver[];
  /** 显式收件人（@提及：正文里点了名的那几个）。见 `emitForHost` 的 `customUserIds` */
  customUserIds?: readonly string[];
  /**
   * 从角色档位解析出来的收件人里**再减掉**这些人（user id 字符串）。
   *
   * 只有 `new_comment` 用它，值是同一批里被 @ 的人：§7.2 合并规则 1 在「关注人/创建人
   * 同时被 @」这一档上的落地——那个人收更具体的 `mention` 那一条，不再重复收广播。
   *
   * ⚠ 它是**减法**，不是收件人档位：规则 8 的档位始终是 `["follower","creator"]`
   * （规则本身没变），被减掉的是"这次解析出来的那几个人"。写成往 `receivers` 里删档位
   * 会变成改规则 8；写成让消费侧比对两条事件的收件人再跳过投递，则要把去重从
   * `dedupe_key` 搬到事务里的跨事件比对——近邻就有唯一键能表达这件事，不必。
   */
  excludeUserIds?: readonly string[];
  /**
   * 收件人看不到宿主时是否降级成占位而不是静默剔除。
   * 只有 `mention` 为 true，理由见 `NotificationIntent.invisibleAsPlaceholder`。
   */
  invisibleAsPlaceholder?: boolean;
  payloads: Record<string, unknown>[];
};

/**
 * 把一条 outbox 行展开成 N 条**通知意图**。
 *
 * ## `comment_added` 一行 → 两种事件（MATT-58）
 *
 * `new_comment`（规则 8：关注人 ∪ 创建人）与 `mention`（被 @ 的那几个人）是**两件事**：
 * 前者是广播，后者是点名。它们的 `dedupe_key` 因为 `event_type` 不同而天然分开，
 * 所以共用一行 outbox、共用同一个 `batch_id` 不会互相吸收。
 *
 * **但同一个人可以同时落在两个集合里**（既关注这条记录、又被 @）。§7.2 的「问题」
 * 那句点名的正是这一档：「同一用户可同时是负责人+关注人+**被 @**；……原设计会产生
 * 成倍重复推送」，而它下面两条合并规则都对着这一档写：
 *
 * · 规则 1「同一 `event_batch_id` 内，同一收件人只出 1 条事件」——条件只有
 *   **批次 + 收件人**，`event_type` 不在条件里（括号里的"归档+通知+节点"也是三种 type）。
 *   评论与提及共用一行 outbox ⇒ 同一个 `event_batch_id` ⇒ 条件成立。
 * · 规则 2「命中角色重叠（owner ∩ follower ∩ **mention**）→ 收件人集合去重到 user 级」
 *   ——括号里直接把 `mention` 列进了重叠集合。
 *
 * 所以 `new_comment` 的收件人要**减掉被 @ 的人**（`excludeUserIds`）：他收 `mention`
 * 那一条，它更具体（点了名，且带 `{quoted}`）。反过来，**没被 @ 的关注人/创建人照常收
 * `new_comment`**——规则 8 的档位一个字没动，减掉的只是"同一个人"在同一批次里的第二份。
 *
 * ## `risk_converted` 是这里唯一一处"一行 → 多个 payload"
 *
 * §7.2 合并规则 1 的原话是「同一 `event_batch_id` 内，同一收件人只出 1 条事件
 * （转案件不再分别发"归档+通知+节点"三条）」。一次转换生成 N 个案件时，
 * 若每个案件各发一条，用户会收到 N 条同源通知然后开始屏蔽通知（G3 反例）。
 * 所以这里**故意**为每个案件各生成一条意图：它们的 `dedupe_key` 因为共享 `event_batch_id`
 * 与同一个 `target_id`（事项）而完全相同，第二条起被 `ON CONFLICT` 吸收进同一条事件。
 * 这正是"聚合"这个词在本票里的可验证形态——`merge_count` 会如实记下吸收了几条。
 */
export function intentsOfOutboxRow(row: OutboxRow): OutboxIntent[] {
  const p = row.payload;
  const host = String(p["host_type"] ?? "risk_matter") === "matter" ? "matter" : "risk_matter";
  if (row.eventType === "comment_added") {
    const hostId = BigInt(String(p["host_id"]));
    const payload = {
      name: "",
      code: "",
      actor: String(p["author_name"] ?? ""),
      // `{quoted}` 的真实来源：评论正文的截断片段（`quoteOf`），随 outbox payload 一起走。
      // 它只出现在**可见**的那条通知里——收件人看不见宿主时读取侧把 body 抹成 null
      // （权限草案 §7.1「摘要字段一律不发」），所以摘要不会从这个口子漏出去。
      quoted: String(p["quoted"] ?? ""),
    };
    const mentionIds = Array.isArray(p["mention_ids"])
      ? (p["mention_ids"] as unknown[]).map(String).filter((x) => x.length > 0)
      : [];
    const intents: OutboxIntent[] = [
      {
        host,
        hostId,
        eventType: "new_comment",
        receivers: RULE_COMMENT_ADDED_NOTIFY.receivers,
        // §7.2 合并规则 1：被 @ 的人在**本批**里只收 `mention` 那一条，不重复收这条广播。
        // 没被 @ 的关注人/创建人不受影响（减法只减 mention_ids 里那几个人）
        excludeUserIds: mentionIds,
        payloads: [payload],
      },
    ];
    // 没有 @ 就没有 mention 意图：不要落一条收件人为空的空事件
    // （`emitForHost` 也会挡住，但"不产生"比"产生了再被挡"少一次误读机会）
    if (mentionIds.length > 0) {
      intents.push({
        host,
        hostId,
        eventType: "mention",
        // `custom` 是 E04 里"指定人员"那一档，@提及正是它的第一个真实调用方
        receivers: [CUSTOM_RECEIVER_KEY],
        customUserIds: mentionIds,
        invisibleAsPlaceholder: true,
        payloads: [payload],
      });
    }
    return intents;
  }
  if (row.eventType === "risk_converted") {
    const hostId = BigInt(String(p["risk_matter_id"]));
    const caseIds = Array.isArray(p["case_ids"]) ? (p["case_ids"] as unknown[]).map(String) : [""];
    return [
      {
        host: "risk_matter",
        hostId,
        eventType: "risk_converted",
        receivers: RULE_RISK_CONVERTED_NOTIFY.receivers,
        payloads: caseIds.map((caseId) => ({
          name: "",
          code: "",
          actor: String(p["actor_name"] ?? ""),
          case_id: caseId,
        })),
      },
    ];
  }
  // 未知事件名不该走到这里（E32 的 CHECK 已经把它挡在库外）；返回空数组而不是抛，
  // 让一条坏行不至于把整批消费卡死
  return [];
}

/**
 * 抽干待投递的 outbox。**至少一次**：只扫 `published_at IS NULL`，成功才打时间戳。
 *
 * 重放是正常路径（消费者崩溃、并发消费），所以去重必须在**数据库唯一键**上——
 * 这也是"投递走 outbox 不直发"这句话的兑现方式：业务事务只管把意图写下来，
 * 真正生成通知的动作发生在这里，而它可重入。
 *
 * 每条 outbox 行**各用一个事务**：一条坏行不该把整批回滚，
 * 而"部分成功"在至少一次语义下是安全的（下次重扫未投递的那几条）。
 */
export async function consumeOutbox(limit = OUTBOX_BATCH): Promise<{
  scanned: number;
  published: number;
  failed: number;
  events: number;
  merged: number;
}> {
  const db = await getDb();
  const pending = await db
    .select({
      id: eventOutbox.id,
      eventType: eventOutbox.eventType,
      batchId: eventOutbox.batchId,
      payload: eventOutbox.payload,
    })
    .from(eventOutbox)
    .where(isNull(eventOutbox.publishedAt))
    .orderBy(asc(eventOutbox.id))
    .limit(limit);

  let published = 0;
  let failed = 0;
  let events = 0;
  let merged = 0;

  for (const row of pending) {
    try {
      const r = await db.transaction(async (tx) => {
        const expanded = intentsOfOutboxRow({
          id: row.id,
          eventType: row.eventType,
          batchId: row.batchId,
          payload: (row.payload ?? {}) as Record<string, unknown>,
        });
        let made = 0;
        let absorbed = 0;
        if (expanded.length > 0) {
          // 宿主事实按 (host, hostId) 取一次就够：一条 outbox 行的所有意图指向同一个宿主
          const first = expanded[0]!;
          const facts = await loadHostFacts(tx, first.host, first.hostId);
          // 宿主没了或已归档 ⇒ 静默丢弃（归档记录不再产生新通知）
          if (facts && !facts.isArchived) {
            for (const spec of expanded) {
              for (const payload of spec.payloads) {
                const res = await emitForHost(tx, {
                  host: spec.host,
                  hostId: spec.hostId,
                  facts,
                  eventType: spec.eventType,
                  sourceType: "auto_rule",
                  receivers: spec.receivers,
                  customUserIds: spec.customUserIds,
                  excludeUserIds: spec.excludeUserIds,
                  batchId: row.batchId,
                  invisibleAsPlaceholder: spec.invisibleAsPlaceholder,
                  // 模板变量里的 code/name 从**宿主事实**取，不从 outbox payload 取：
                  // payload 是事件发生那一刻的快照，而标题里的编号/名称应当反映读取时的记录
                  payload: { ...payload, code: facts.code, name: facts.name },
                });
                if (res.merged) absorbed++;
                else if (res.eventId !== null) made++;
              }
            }
          }
        }
        await tx
          .update(eventOutbox)
          .set({
            publishedAt: new Date().toISOString(),
            attempts: sql`${eventOutbox.attempts} + 1`,
          })
          .where(eq(eventOutbox.id, row.id));
        return { made, absorbed };
      });
      published++;
      events += r.made;
      merged += r.absorbed;
    } catch (e) {
      failed++;
      await db
        .update(eventOutbox)
        .set({
          attempts: sql`${eventOutbox.attempts} + 1`,
          lastError: String((e as Error)?.message ?? e).slice(0, 500),
        })
        .where(eq(eventOutbox.id, row.id));
    }
  }
  return { scanned: pending.length, published, failed, events, merged };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 六、节点到期扫描（只走带 is_time_confirmed 的 partial index 那一路）
 * ──────────────────────────────────────────────────────────────────────────── */

type ScanNodeRow = {
  id: bigint;
  hostId: bigint;
  name: string;
  timeType: string;
  deadlineTime: string | null;
  remindDays: number[];
  status: string;
  isTimeConfirmed: boolean;
};

/**
 * 到期扫描。**取数路径与 `ix_node_scan` 的谓词逐字相同**：
 *
 * ```sql
 * ix_node_scan (status, deadline_time) WHERE is_time_confirmed AND status IN ('not_started','in_progress')
 * ```
 *
 * 所以这里的 WHERE 必须同时给出 `is_time_confirmed`、`status IN (...)` 与 `deadline_time` 的窗口
 * ——少任何一个都会退化成全表扫（前两个还顺带改变业务语义：把"判决 待定"的节点也拉进来发提醒）。
 * 窗口的上界取 `SCAN_WINDOW_MAX_DAYS`，它是"让索引第二列可用"的手段，
 * 真正的判定是 `pickDueReminders` 里的等值比较。
 *
 * 两条 SQL 各扫自己表（§7.2 合并规则 6：不为规则引入跨宿主统一节点视图），结果并集后进同一管道。
 */
export async function scanDueNodes(now: Date = new Date()): Promise<{
  scanned: number;
  events: number;
  merged: number;
}> {
  const db = await getDb();
  const nowIso = now.toISOString();
  const dateKey = businessDateKey(now);
  const windowStart = businessDayStartIso(now);
  const windowEnd = new Date(
    Date.parse(windowStart) + (SCAN_WINDOW_MAX_DAYS + 1) * 86_400_000,
  ).toISOString();

  const scanHost = async (host: HostKind): Promise<ScanNodeRow[]> => {
    const t = host === "matter" ? matterNode : riskMatterNode;
    return db
      .select({
        id: t.id,
        hostId: t.hostId,
        name: t.name,
        timeType: t.timeType,
        deadlineTime: t.deadlineTime,
        remindDays: t.remindDays,
        status: t.status,
        isTimeConfirmed: t.isTimeConfirmed,
      })
      .from(t)
      .where(
        and(
          eq(t.isTimeConfirmed, true),
          inArray(t.status, [...SCANNABLE_NODE_STATUSES]),
          isNotNull(t.deadlineTime),
          sql`NOT ${t.isDeleted}`,
          sql`${t.deadlineTime} >= ${windowStart}`,
          sql`${t.deadlineTime} < ${windowEnd}`,
        ),
      )
      .limit(SCAN_BATCH);
  };

  const [matterNodes, riskNodes] = await Promise.all([scanHost("matter"), scanHost("risk_matter")]);
  let events = 0;
  let merged = 0;

  for (const [host, nodes] of [
    ["matter", matterNodes],
    ["risk_matter", riskNodes],
  ] as const) {
    if (nodes.length === 0) continue;
    const factsByHost = new Map<string, NotifyHostFacts | null>();
    for (const node of nodes) {
      const key = String(node.hostId);
      if (!factsByHost.has(key)) factsByHost.set(key, await loadHostFacts(db, host, node.hostId));
    }
    for (const node of nodes) {
      const due = pickDueReminders(
        {
          timeType: node.timeType,
          deadlineTime: node.deadlineTime,
          remindDays: node.remindDays,
          isTimeConfirmed: node.isTimeConfirmed,
          status: node.status,
        },
        nowIso,
      );
      if (due.length === 0) continue;
      const facts = factsByHost.get(String(node.hostId));
      // 归档记录不再产生新通知（M4「什么时候不用」）
      if (!facts || facts.isArchived) continue;

      for (const d of due) {
        const rule = d.eventType === "node_due_end" ? RULE_NODE_END_NOTIFY : RULE_NODE_START_NOTIFY;
        const res = await db.transaction(async (tx) => {
          // 节点提醒的 owner 优先取**节点自己的** owner（§6.1 节点可单独指派），空则回落宿主 owner
          const nodeOwner = await nodeOwnerOf(tx, host, node.id);
          const recipients = await resolveRecipients(
            tx,
            host,
            node.hostId,
            {
              ...facts,
              ownerId: nodeOwner ?? facts.ownerId,
            },
            rule.receivers,
          );
          if (recipients.length === 0) return { eventId: null as bigint | null, merged: false };
          const dedupeKey = scheduledDedupeKey({
            eventType: d.eventType,
            targetId: node.id,
            dateKey,
          });
          return insertNotificationEvent(tx, {
            eventType: d.eventType,
            sourceType: "node_remind",
            host,
            hostId: node.hostId,
            targetType: `${host}_node`,
            targetId: node.id,
            /**
             * ⚠ `event_batch_id` 是 **uuid 列**，不能拿 `dedupe_key` 顶替——
             * 初版就是这么写的，PG 直接 `invalid input syntax for type uuid`，
             * 而它只在"扫描真的命中一个节点"时才炸（探针里才现形：库那一侧捞得到行、
             * 接口 500、事件表空）。
             *
             * 定时类没有"一次业务操作"这个批次，所以给一个新的 uuid：
             * 它的聚合语义由 `dedupe_key` 的**业务日**承担（同一天重扫得到同一个 key），
             * `event_batch_id` 在这里只用于排障分组。
             */
            batchId: randomUUID(),
            dedupeKey,
            payload: {
              code: facts.code,
              name: facts.name,
              node: node.name,
              days: d.daysLeft,
              // ISO 瞬时进 payload，展示串在读取时按 Asia/Shanghai 现算（见 shared/notification/template.ts）
              deadline_time: node.deadlineTime,
            },
            recipients,
            windowStart,
            windowEnd,
          });
        });
        if (res.merged) merged++;
        else if (res.eventId !== null) events++;
      }
    }
  }
  return { scanned: matterNodes.length + riskNodes.length, events, merged };
}

async function nodeOwnerOf(r: Reader, host: HostKind, nodeId: bigint): Promise<bigint | null> {
  const t = host === "matter" ? matterNode : riskMatterNode;
  const [row] = await r.select({ ownerId: t.ownerId }).from(t).where(eq(t.id, nodeId)).limit(1);
  return row?.ownerId ?? null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 七、轮询入口
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 一次"轮询"：抽干 outbox + 跑一遍节点到期扫描。
 *
 * 一期没有调度器（单副本、不引 Redis），所以由通知中心的读请求触发。
 * 幂等由 `dedupe_key` 保证，所以重复触发只是白跑几次索引扫描。
 * 系统动作没有 `actor`：规则以 `operator = SYSTEM` 执行（权限草案 §8），
 * 而本函数不写审计、不读用户范围，所以拿不到 actor 也不影响正确性。
 */
export async function pumpNotifications(): Promise<{
  outbox: Awaited<ReturnType<typeof consumeOutbox>>;
  scan: Awaited<ReturnType<typeof scanDueNodes>>;
}> {
  const outbox = await consumeOutbox();
  const scan = await scanDueNodes();
  return { outbox, scan };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 八、读取侧：通知中心
 * ──────────────────────────────────────────────────────────────────────────── */

/** 模板按 `event_type` 索引。一次读请求只查一次（8 行） */
async function loadTemplates(r: Reader): Promise<Map<string, TemplateRow>> {
  const rows = await r
    .select({
      eventType: notificationTemplate.eventType,
      titleTpl: notificationTemplate.titleTpl,
      bodyTpl: notificationTemplate.bodyTpl,
    })
    .from(notificationTemplate)
    .where(
      and(
        eq(notificationTemplate.isEnabled, true),
        eq(notificationTemplate.channel, PHASE1_NOTIFY_CHANNEL),
        sql`NOT ${notificationTemplate.isDeleted}`,
      ),
    );
  return new Map(rows.map((t) => [t.eventType, { titleTpl: t.titleTpl, bodyTpl: t.bodyTpl }]));
}

/**
 * `target_type` → 宿主种类。
 *
 * 事件表的宿主是多态的（§7.2 的 `host_id` 不是外键），所以可见性判定要先知道
 * "这条通知属于哪条宿主线"。取值只有宿主与节点两种形态（E03 里 `app_user` 等
 * 对通知没有意义），前缀判定因此是完备的；写成函数而不是内联三元，
 * 是为了让"以后真出现了第三种前缀"有一个改一处的落点。
 */
export function hostKindOfTarget(targetType: string): HostKind {
  return targetType.startsWith("risk_matter") ? "risk_matter" : "matter";
}

/** 一批宿主里，当前 actor 看得见哪些。走 `scopedWhere`（可见性唯一出口） */
async function visibleHostIds(
  r: Reader,
  actor: Actor,
  host: HostKind,
  ids: readonly bigint[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const t = HOSTS[host].table;
  const rows = await r
    .select({ id: t.id })
    .from(t)
    .where(scopedWhere(host, actor, inArray(t.id, [...new Set(ids.map(String))].map(BigInt))));
  return new Set(rows.map((x) => String(x.id)));
}

/**
 * 宿主可见性的 SQL 形态，供**未读计数**使用。
 *
 * 为什么不复用 `visibleHostIds`：未读计数要的是"全部未读里可见的有几条"，
 * 把全部未读行拉回来再过滤等于把分页问题换个地方发生。这里用 EXISTS 让库自己算。
 *
 * ⚠ 跨表列引用一律写**裸限定名**（`mn_matter.id`、`mn_notification_event.host_id`）：
 * drizzle 的 `sql` 模板在 select 列表上下文会把本表列渲染成无限定名
 * （`${x.id}` → `"id"`），本轮已因此出过三次静默缺陷。这里虽然在 WHERE 上下文，
 * 但同一个坑不值得赌第二次。
 */
function visibleHostExists(host: HostKind, actor: Actor): SQL {
  const table = host === "matter" ? "mn_matter" : "mn_risk_matter";
  return sql`exists (select 1 from ${sql.raw(table)} where ${sql.raw(`${table}.id`)} = ${sql.raw("mn_notification_event.host_id")} and ${scopedWhere(host, actor)})`;
}

/** 通知中心的一行（服务端渲染完给接口，前端不重算） */
export type NotificationItem = {
  id: string;
  eventType: string;
  eventTypeLabel: string;
  isRead: boolean;
  readAt: string | null;
  /** ISO 瞬时；界面要显示时过 `formatBusinessTime`（Asia/Shanghai） */
  createdAt: string;
  /** 宿主可见性。false = 降级占位行（权限草案 §7.1） */
  visible: boolean;
  /** 不可见时是「无权查看的记录」，且 `body` 为 null、`hostId` 为 null */
  title: string;
  body: string | null;
  hostKind: HostKind | null;
  hostId: string | null;
  targetType: string | null;
};

export type NotificationPage = {
  items: NotificationItem[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * 通知中心列表。
 *
 * 四条口径都来自权限草案 §7.1：
 *   · **跨宿主倒序**：按事件 `created_at` 倒序，两条宿主线混在一条时间轴上；
 *   · **不可见降级占位**：保留行、标题换成「无权查看的记录」、摘要字段一律不发——
 *     不隐藏整行，因为隐藏会被当成数据丢失而去追问，占位能自助解释；
 *   · **读取时实时鉴权渲染**：可见性每读一次判一次，正文也从模板现算（不落快照）；
 *   · `void` 行**不出现**：那是"投递时就发现收件人不可见"的静默剔除（§8），
 *     与"投递后失权"的占位是两件事。
 */
export async function listNotifications(
  actor: Actor,
  q: { page: number; pageSize: number; unreadOnly?: boolean },
): Promise<NotificationPage> {
  const db = await getDb();
  const uid = BigInt(actor.userId);
  const where = and(
    eq(notificationDelivery.userId, uid),
    ne(notificationDelivery.status, "void"),
    q.unreadOnly ? eq(notificationDelivery.isRead, false) : undefined,
  );

  const [totals] = await db
    .select({ n: dcount() })
    .from(notificationDelivery)
    .innerJoin(notificationEvent, eq(notificationEvent.id, notificationDelivery.eventId))
    .where(where);

  const rows = await db
    .select({
      id: notificationDelivery.id,
      isRead: notificationDelivery.isRead,
      readAt: notificationDelivery.readAt,
      createdAt: notificationEvent.createdAt,
      eventType: notificationEvent.eventType,
      targetType: notificationEvent.targetType,
      hostId: notificationEvent.hostId,
      payload: notificationEvent.payload,
    })
    .from(notificationDelivery)
    .innerJoin(notificationEvent, eq(notificationEvent.id, notificationDelivery.eventId))
    .where(where)
    // 跨宿主倒序：主键是事件时间，次键是投递行 id（同秒内稳定，翻页不会漏行/重行）
    .orderBy(desc(notificationEvent.createdAt), desc(notificationDelivery.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  const byHost: Record<HostKind, bigint[]> = { matter: [], risk_matter: [] };
  for (const r of rows) byHost[hostKindOfTarget(r.targetType)].push(r.hostId);
  const [visibleMatter, visibleRisk] = await Promise.all([
    visibleHostIds(db, actor, "matter", byHost.matter),
    visibleHostIds(db, actor, "risk_matter", byHost.risk_matter),
  ]);
  const templates = await loadTemplates(db);

  const items = rows.map((r): NotificationItem => {
    const hostKind = hostKindOfTarget(r.targetType);
    const visible = (hostKind === "matter" ? visibleMatter : visibleRisk).has(String(r.hostId));
    const eventTypeLabel =
      NOTIFICATION_EVENT_TYPE_LABELS[r.eventType as NotificationEventType] ?? r.eventType;
    if (!visible) {
      return {
        id: String(r.id),
        eventType: r.eventType,
        eventTypeLabel,
        isRead: r.isRead,
        readAt: r.readAt,
        createdAt: r.createdAt,
        visible: false,
        title: INVISIBLE_NOTIFICATION_TITLE,
        body: null,
        hostKind: null,
        hostId: null,
        targetType: null,
      };
    }
    const rendered = renderNotification(
      templates.get(r.eventType),
      (r.payload ?? {}) as Record<string, unknown>,
    );
    return {
      id: String(r.id),
      eventType: r.eventType,
      eventTypeLabel,
      isRead: r.isRead,
      readAt: r.readAt,
      createdAt: r.createdAt,
      visible: true,
      // 模板缺席时给一句能读的降级文案：抛会把整个通知中心变成 500，
      // 而"某个 event_type 没有模板"只该让那一条说不出来
      title: rendered?.title ?? eventTypeLabel,
      body: rendered?.body ?? null,
      hostKind,
      hostId: String(r.hostId),
      targetType: r.targetType,
    };
  });

  return { items, total: Number(totals?.n ?? 0), page: q.page, pageSize: q.pageSize };
}

/**
 * 未读计数（4.6「未读更新：3」）。
 *
 * **按可见行计，不按总数**（权限草案 §7.1 原话）。所以这里不是
 * "`count(*) where not is_read`"——那会把失权之后仍留在收件箱里的行算进去，
 * 而徽标上的数字正是用户判断"要不要点进去"的依据。
 */
export async function countUnread(actor: Actor): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: dcount() })
    .from(notificationDelivery)
    .innerJoin(notificationEvent, eq(notificationEvent.id, notificationDelivery.eventId))
    .where(
      and(
        eq(notificationDelivery.userId, BigInt(actor.userId)),
        ne(notificationDelivery.status, "void"),
        eq(notificationDelivery.isRead, false),
        or(
          and(
            sql`${notificationEvent.targetType} like 'matter%'`,
            visibleHostExists("matter", actor),
          ),
          and(
            sql`${notificationEvent.targetType} like 'risk_matter%'`,
            visibleHostExists("risk_matter", actor),
          ),
        ),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * 标记已读。
 *
 * `all` 只清自己的行（`user_id` 恒在条件里）：已读是"我对这条通知"的状态，
 * 而"清空别人的未读"这种事不该有任何入口。
 * `void` 行不进范围——它根本不在收件箱里。
 */
export async function markNotificationsRead(
  actor: Actor,
  input: { ids?: readonly string[]; all?: boolean },
): Promise<{ updated: number }> {
  const db = await getDb();
  const uid = BigInt(actor.userId);
  const scope = and(eq(notificationDelivery.userId, uid), ne(notificationDelivery.status, "void"));
  const target =
    input.all === true
      ? and(scope, eq(notificationDelivery.isRead, false))
      : and(scope, inArray(notificationDelivery.id, (input.ids ?? []).map(BigInt)));
  const now = new Date().toISOString();
  const rows = await db
    .update(notificationDelivery)
    .set({ isRead: true, readAt: now, updatedAt: now })
    .where(target)
    .returning({ id: notificationDelivery.id });
  return { updated: rows.length };
}

/** 通知中心页面要用的"最新一条评论摘录"上限：B5 的 `{quoted}` 不该把整条评论塞进通知 */
export const QUOTE_MAX_LENGTH = 60;

/** 截断评论摘录。写在这里而不是调用点：三处调用点各截一次必然有一处忘了截 */
export function quoteOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_MAX_LENGTH ? `${flat.slice(0, QUOTE_MAX_LENGTH)}…` : flat;
}

/** 供测试与排障：把一条评论的目标解析成宿主（评论表是多态的，只有这张表保留多态） */
export async function commentHostOf(
  r: Reader,
  commentId: bigint,
): Promise<{ host: HostKind; hostId: bigint } | null> {
  const [row] = await r
    .select({ targetType: comment.targetType, targetId: comment.targetId })
    .from(comment)
    .where(eq(comment.id, commentId))
    .limit(1);
  if (!row) return null;
  if (row.targetType !== "matter" && row.targetType !== "risk_matter") return null;
  return { host: row.targetType, hostId: row.targetId };
}

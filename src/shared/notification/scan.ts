/**
 * 节点到期扫描的**选点逻辑**（修订稿 §6.1 + §8.2 的 `ix_node_scan`）。
 *
 * ## "只走带 `is_time_confirmed` 的 partial index 那一路"是什么意思
 *
 * §8.2 给两张节点表各定了一个 partial index：
 *
 * ```sql
 * ix_node_scan (status, deadline_time) WHERE is_time_confirmed AND status IN ('not_started','in_progress')
 * ```
 *
 * 于是扫描器只有一条合法路径：**过滤条件与索引谓词逐字相同**。
 * 三种走偏的方式都会静默发生，而且都不会报错：
 *   1. 用 `start_time` / `end_time` 而不是生成列 `deadline_time` 去比时间窗
 *      ——索引的第二个键是 `deadline_time`，比别的列等于放弃它，退化成全表扫；
 *   2. 少写 `is_time_confirmed` —— 把"判决时间待定"的节点也拉进来发提醒
 *      （4.2 原型里的「判决 待定」正是这一档），用户收到一条自己没法执行的提醒；
 *   3. 少写 `status IN (...)` —— 已取消/已完成节点照样提醒。
 *
 * 这个文件负责把 1/2/3 的**判定**写成可单测的纯函数；SQL 那一侧的窗口过滤在
 * `services/notifications.ts` 的 `scanDueNodes`，两边靠同一组常量对齐。
 *
 * ## 为什么按 `deadline_time` 分档而不是按"开始/截止"两张表扫两遍
 *
 * `deadline_time = COALESCE(end_time, start_time)`（生成列，§6.1）。
 * 时间段节点（`range`）的期限是结束时间，时间点节点（`point`）的期限就是那一个时刻——
 * 一个键足以表达两者，而拆成两个键就得建两个索引、扫两遍。
 * 分档只影响**文案与事件类型**（`node_due_end` / `node_due_start`），不影响取数路径。
 */
import { businessDaysBetween } from "@/shared/time/zh-cn";
import { NODE_STATUSES } from "@/shared/enums/business";

/** 参与扫描的两个节点状态。与 `ix_node_scan` 的谓词**逐字相同**，改一处就要改两处 */
export const SCANNABLE_NODE_STATUSES = ["not_started", "in_progress"] as const;

/**
 * 扫描窗口的上界：`remind_days` 的合法上界。
 *
 * `remind_days` 是整数数组（默认 `{7,3,1}`），值域没有 DB CHECK。
 * 取 365 当窗口宽度：窗口是用来**让索引的第二列可用**的，不是业务规则本身
 * ——业务规则是下面那条 `daysLeft === remindDay` 的等值判定。
 * 窗口开得太小会漏（有人配了 `remind_days=[30]`），开得太大等于没有窗口。
 */
export const SCAN_WINDOW_MAX_DAYS = 365;

export type ScannableNode = {
  timeType: string;
  /** `COALESCE(end_time, start_time)`，ISO 瞬时 */
  deadlineTime: string | null;
  remindDays: readonly number[];
  isTimeConfirmed: boolean;
  status: string;
  isDeleted?: boolean;
};

export type DueReminder = {
  /** E29：`range` 节点给 `node_due_end`，`point` 节点给 `node_due_start` */
  eventType: "node_due_start" | "node_due_end";
  /** 命中的提前天数，进模板的 `{days}` */
  daysLeft: number;
};

/**
 * 一个节点在本次扫描里该发哪几条提醒。
 *
 * `remindDays` 里重复的值只出一条（`{7,3,1,3}` 是手滑，不该变成两条通知）。
 * 一条都不命中就返回空数组——扫描器对绝大多数节点都是这个结果。
 */
export function pickDueReminders(node: ScannableNode, now: string | Date): DueReminder[] {
  // ①②③ 三道闸门就是 partial index 的谓词，顺序也照它写（先最便宜的那个）
  if (!node.isTimeConfirmed) return [];
  if (!(SCANNABLE_NODE_STATUSES as readonly string[]).includes(node.status)) return [];
  if (node.isDeleted) return [];
  if (!node.deadlineTime) return [];

  const daysLeft = businessDaysBetween(now, node.deadlineTime);
  // 窗口外直接退出：这条判定在 SQL 侧已经做过一次，这里是第二道（纯函数要能独立成立）
  if (daysLeft < 0 || daysLeft > SCAN_WINDOW_MAX_DAYS) return [];

  const eventType = node.timeType === "range" ? "node_due_end" : "node_due_start";
  const hit = [...new Set(node.remindDays)].filter((d) => d === daysLeft).sort((a, b) => a - b);
  return hit.map((days) => ({ eventType, daysLeft: days }));
}

/** 节点状态值域来自 E21；这里再导一次只为让测试能断言"闸门 ② 用的是同一份值域" */
export const SCANNABLE_STATUSES_SOURCE = NODE_STATUSES;

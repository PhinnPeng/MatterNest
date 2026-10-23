/**
 * 节点到期扫描的**选点逻辑**（修订稿 §6.1 + §8.2 的 `ix_node_scan`）。
 *
 * ## "只走带 `is_time_confirmed` 的 partial index 那一路"是什么意思
 *
 * §8.2 给两张节点表各定了一个 partial index：
 *
 * ```sql
 * ix_node_scan (status, deadline_time) WHERE is_time_confirmed AND status = 'in_progress'
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
import { businessDateKey, businessDaysBetween } from "@/shared/time/zh-cn";
import { NODE_STATUSES } from "@/shared/enums/business";

/** 参与扫描的两个节点状态。与 `ix_node_scan` 的谓词**逐字相同**，改一处就要改两处 */
export const SCANNABLE_NODE_STATUSES = ["in_progress"] as const;

/**
 * 扫描窗口的上界：`remind_days` 的合法上界。
 *
 * `remind_days` 是整数数组（默认 `{7,3,1}`），值域没有 DB CHECK。
 * 取 365 当窗口宽度：窗口是用来**让索引的第二列可用**的，不是业务规则本身
 * ——业务规则是下面 `pickDueReminders` 里的区间判定（`SCAN_CATCHUP_DAYS`）。
 * 窗口开得太小会漏（有人配了 `remind_days=[30]`），开得太大等于没有窗口。
 */
export const SCAN_WINDOW_MAX_DAYS = 365;

/**
 * 补发窗口的宽度 K：**产品裁定 = 3 天**（不是技术决定，别凭手感调这个数）。
 *
 * 节点提醒原来是**等值判定**（`d === daysLeft`）：必须**恰好**在 `daysLeft === d`
 * 那一天跑到扫描，否则那一档永久丢失——定时器还没上线、停机、或者压根没人打开
 * 通知页（扫描挂在读请求上）都会让那一天缺席。裁定改成区间判定，
 * 把窗口**朝 `daysLeft` 更小的一侧**扩 K 天：
 *
 *     d - K < daysLeft <= d          // K = 3 ⇒ daysLeft ∈ {d, d-1, d-2}
 *
 * ⚠ **方向不能反过来**（写成 `[d, d+K)` 是错的）。三条：
 *   1. `daysLeft` 是**随日子递减**的（`businessDaysBetween(now, deadline)`，
 *      `daysLeft < 0` = 已过期 ⇒ 不算）。停机跨过那一档后恢复时 `daysLeft`
 *      **已经小于 d**，`[d, d+K)` 那一侧根本不含这些值 ⇒ 一个也补不回来，等于没修；
 *   2. 验收判据要的是「**跨过档位当天补跑**，仍能命中」——只有下界这一侧满足；
 *   3. 同族先例：`docs/research-portable-scheduler.md` §5.1 把替代写法点成
 *      **下界**（`d >= daysLeft`），规则 9 的 `judgeArchiveReminder`
 *      （`services/archive-reminder.ts`）也是下界——**同形而不同参数**：
 *      那边下界无上界（"14 天以后都还发"），这边用 K 封顶（否则"还有 7 天"
 *      会在只剩 3 天时还往外发）。
 *
 * 代价是**晚发**：最迟在还剩 `d-K+1` 天时发出「还有 d 天」的提醒。
 */
export const SCAN_CATCHUP_DAYS = 3;

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
  /**
   * **命中的档位值**（`remind_days` 里的那个数），进模板的 `{days}`。
   *
   * ⚠ 补发时它是**里程碑标签**（"还有 7 天"），不是此刻精确的剩余天数——
   * 最迟可能差 `SCAN_CATCHUP_DAYS - 1` 天。要不要在补发时改成精确值，
   * 是**产品裁定**（改文案口径，不是改判定），本票不动。
   */
  daysLeft: number;
};

/**
 * 一个节点在本次扫描里该发哪几条提醒。
 *
 * **区间判定**（不是 `d === daysLeft` 的等值判定）：
 *
 *     d - SCAN_CATCHUP_DAYS < daysLeft <= d
 *
 * 所以档位当天没跑到、之后 K 天内补跑都还命中；`daysLeft <= d-K` 就不再补
 * （否则"还有 7 天"会在只剩 3 天时还往外发）。窗口与去重键是一件事的两面：
 * 改了这里的窗，就必须同时看 `scanDueDateKey`——区间化之后同一档位会在
 * `d, d-1, d-2` 三天都命中，键还按扫描日算就会连发三条。
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
  // 区间判定：窗口朝 daysLeft 更小的一侧扩 K 天（补发，见 SCAN_CATCHUP_DAYS）
  const hit = [...new Set(node.remindDays)]
    .filter((d) => d - SCAN_CATCHUP_DAYS < daysLeft && daysLeft <= d)
    .sort((a, b) => a - b);
  return hit.map((days) => ({ eventType, daysLeft: days }));
}

/**
 * 定时类去重键的 `dateKey`：**同节点 + 同档位 + 同截止业务日 ⇒ 同一个 key**。
 *
 * ## 为什么不是扫描日
 *
 * 原来这一处传的是 `businessDateKey(now)`（**扫描日**）。区间判定上线后，
 * 同一档位会在 `d, d-1, d-2` 三天都命中，三天三个 key ⇒ 同一条
 * 「还有 3 天」连发三条。换成"截止日 + 档位"这个**档位稳定**的键，
 * 补发窗口内多天只发一条。
 *
 * ## 语义变化（对账用）
 *
 * 原来「同节点同**扫描日**一条」→ 现在「同节点同**档位**一条」。
 * 同一扫描日若同时命中两个档位（长停机后 `daysLeft` 恰好落在两个窗的**交叠区**，
 * 例如 K=3、`remind_days=[7,3,1]`、`daysLeft=1` 时 3 与 1 都命中）会出两条 ——
 * 那是**两条不同的里程碑**，是想要的，不是连发。
 *
 * 截止日改了 ⇒ 新 key ⇒ 改期会重新提醒（想要的）。
 *
 * ⚠ 这个函数与 `pickDueReminders` 的窗口必须**一起动**：它们是"窗口 = 档位"
 * 与"键 = 档位"两件事的两面。`shared/notification/dedupe.ts` 的函数构造不参与
 * 这件事——那边只吃 `dateKey` 这个字符串，不关心它是什么口径。
 */
export function scanDueDateKey(deadlineTime: string | Date, remindDay: number): string {
  return `${businessDateKey(deadlineTime)}#${remindDay}`;
}

/** 节点状态值域来自 E21；这里再导一次只为让测试能断言"闸门 ② 用的是同一份值域" */
export const SCANNABLE_STATUSES_SOURCE = NODE_STATUSES;

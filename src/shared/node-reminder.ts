/**
 * 节点提醒的**初始档位**（2026-10-23 用户裁定）。
 *
 * ## 规则
 *
 * 新增一个节点时，如果它的时间已经落在最大提醒窗口（默认 7 天）之内，那么
 * **更早的几档视为"已经触发过"**，只保留最近的一档（即 `n = 1` 那一天）。
 * 理由不是省通知，而是：`7 天前` 这个时刻对一条今天才建的节点来说根本没有发生过，
 * 建完立刻收到"还有 7 天""还有 3 天"两条，读起来像系统在补发历史。
 *
 * 超过窗口的节点照常吃「全档」（7 / 3 / 1）。
 *
 * ## 为什么不是"按剩余天数只留未来的档"
 *
 * 那会得到一条连续斜坡（due=5 天时留下 3 与 1 两档）。用户给的规则是**只触发 n=1**，
 * 所以这里直接收成一档：临近期限的节点，只需要"明天到期"这一声。
 */

/** 默认提醒档位（天）。A9 之后由服务端常量给出，配置列若在则以配置为准 */
export const NODE_REMIND_DEFAULT = [7, 3, 1] as const;

/** 一类节点的可选档位（来自 `node_type_config.default_remind_days`） */
export type RemindDays = readonly number[];

/**
 * 新增/改期时该给这条节点挂哪几档。
 *
 * `deadline` 为空（还没填时间）→ 原样保留档位，等时间填上时再按这条规则收一次。
 */
export function initialRemindDays(
  deadline: string | null,
  now: Date = new Date(),
  defaults: RemindDays = NODE_REMIND_DEFAULT,
): number[] {
  const tiers = defaults.filter((d) => Number.isFinite(d) && d > 0);
  if (!deadline) return tiers.length ? [...tiers] : [...NODE_REMIND_DEFAULT];
  if (tiers.length === 0) return [];

  const remainingDays = (new Date(deadline).getTime() - now.getTime()) / 86_400_000;
  const window = Math.max(...tiers);
  if (remainingDays > window) return [...tiers];

  // 窗口内 / 已过期：只留最近的一档（默认即 1 天）。配置里没有 1 就用最小的那一档，
  // 而不是硬塞一个没人配过的阈值。
  return [Math.min(...tiers)];
}

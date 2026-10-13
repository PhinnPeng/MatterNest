/**
 * 全项目**唯一**的中文日期口径出口（禁令⑧：日期库全项目只允许一个）。
 *
 * 为什么只剩 pattern 而没有 locale 对象：换到 antd 之后日期库必须是 **dayjs**
 * （antd 的 `DatePicker`/`ConfigProvider` 只认 dayjs），而 dayjs 的语言靠 `dayjs.locale("zh-cn")`
 * 全局设，不需要把 locale 对象当 prop 传——上一版在 date-fns 那边必须传 `locale`，
 * 还因此产生过"`Locale` 含函数，不能在 Server Component 里当 prop 传"的硬约束。
 * **两处 provider 之外的地方都不许出现日期库**：格式串只有这一份。
 *
 * ⚠ **pattern 字面量必须重写，不是照抄**：date-fns 认 `yyyy`/`dd`，
 * dayjs 只认 `YYYY`/`DD`——直接照抄会输出 `yyyy年9月0日`（实测撞到的就是这条，
 * 而且是**测试**先撞到的：断言钉的是产出串 `2026年9月27日`，换库时它替我们把雷踩了出来）。
 * 口径保持与 date-fns 时期完全一致（`2026年9月27日`），
 * 因为 `zh-cn.spec.ts` 钉的就是产出串；换库不该改口径。
 */

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

/**
 * 时区插件只在**这一个文件**里注册（禁令⑦：日期库只有 dayjs）。
 *
 * 为什么必须有它：数据库会话被钉死 UTC（`db/client.ts` 的启动断言、`db:check` C4），
 * 所以 `new Date(iso).toLocaleString()` 与 `dayjs(iso).format(...)` 出来的都是 **UTC 墙上时间**，
 * 而通知文案里的时间是给上海办公室的人看的——差 8 小时，且**不会报错**。
 * 这不是"显示不精确"，是"开庭提醒写着昨天"。
 *
 * 为什么用 `.tz()` 而不是手动 `+8`：中国无夏令时，手加 8 小时今天恰好对，
 * 但它把"业务时区"这件事写成了算术，换个时区就得全仓找 `+ 8`。
 */
dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * 业务时区。**唯一一处**把 UTC 瞬时转成"人看的墙上时间"的地方。
 *
 * 编号发号器（`mn_code_seq.day_key`）用的是同一个时区，那边的注释解释了
 * 为什么不能用 `current_date`：上海 0–8 点立案会归到前一天。同一条理由在这里也成立。
 */
export const BUSINESS_TIMEZONE = "Asia/Shanghai";

/** 列表/详情里的日期展示口径：`2026年9月27日` */
export const DATE_DISPLAY_PATTERN = "YYYY年M月D日";

/** 表格等紧凑场景：`2026-09-27`（与 ISO 一致，便于排序与肉眼比对） */
export const DATE_COMPACT_PATTERN = "YYYY-MM-DD";

/** 期限倒计时文案（修订稿 §12.2：刚性期限不容时区偏差，计算走 UTC，展示走业务时区） */
export const DEADLINE_COUNTDOWN_PATTERN = "YYYY年M月D日 HH:mm";

/** 通知文案与通知中心里的时间口径：`2026-10-15 06:30`（不带秒，省宽度也少一处噪声） */
export const NOTIFY_TIME_PATTERN = "YYYY-MM-DD HH:mm";

/**
 * 瞬时 → 业务时区墙上时间。**通知文案里的每一个时间都必须过这里**。
 *
 * 空值回 `—` 而不是空串：`node_start` 的正文是「计划 {time}」，
 * 空串会渲染成"计划 。"——读起来像文案坏了，而 `—` 明确说"这个值没有"。
 */
export function formatBusinessTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const d = dayjs(value);
  return d.isValid() ? d.tz(BUSINESS_TIMEZONE).format(NOTIFY_TIME_PATTERN) : "—";
}

/**
 * 业务日（`YYYY-MM-DD`，Asia/Shanghai）。
 *
 * 定时类通知的 `dedupe_key` 用它（§7.2「同一节点同一天的多条提前提醒 → 合并为 1 条」），
 * 所以它必须是**上海日**而不是 UTC 日：否则上海时间 0–8 点之间的那一批扫描
 * 会归到前一天，而前一天的 key 已经被用过 ⇒ 那一批提醒被静默吞掉。
 */
export function businessDateKey(value: string | Date): string {
  return dayjs(value).tz(BUSINESS_TIMEZONE).format("YYYY-MM-DD");
}

/** 两个瞬时相差几个**业务日**（按上海日历天算，不看钟点） */
export function businessDaysBetween(from: string | Date, to: string | Date): number {
  return dayjs(businessDateKey(to)).diff(dayjs(businessDateKey(from)), "day");
}

/**
 * 某个瞬时所在**业务日的起点**（上海 00:00），返回 ISO 瞬时。
 *
 * 到期扫描的窗口下界用它。为什么不直接拿 `now`：扫描的判定粒度是"日历天"
 * （`pickDueReminders` 比的是业务日差），窗口若从 `now` 起算，
 * 上海时间当天 00:00–现在 之间到期的节点会被排除在窗口外——而它们恰好是"今天到期"的那批。
 */
export function businessDayStartIso(value: string | Date): string {
  return dayjs.tz(businessDateKey(value), BUSINESS_TIMEZONE).toISOString();
}

/**
 * ⚠ 这里**不提供**星期 pattern。
 * 实测 dayjs 核心不认 `EEE`（要 weekday 得装 AdvancedFormat 插件），
 * `format("EEE")` 会原样吐出字符串 `"EEE"`——留着就是一颗"看着能用其实输出乱码"的雷。
 * 星期文案交给 antd 的 Calendar / DatePicker 自己渲染（它们内部已经处理）。
 */

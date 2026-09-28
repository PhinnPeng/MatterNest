import dayjs from "dayjs";

import {
  DATE_COMPACT_PATTERN,
  DATE_DISPLAY_PATTERN,
  DEADLINE_COUNTDOWN_PATTERN,
} from "@/shared/time/zh-cn";

/**
 * 展示层格式化。**只在客户端组件里用**，服务端不格式化——
 * 两边各格式一份，列表与详情就会出现"同一条记录两个日期写法"。
 *
 * 日期库换成了 dayjs：这不是风格选择，是**约束**——antd 的 `DatePicker`/`ConfigProvider`
 * 只认 dayjs。仓库里同时留 date-fns 与 dayjs 会让"月份显示成 September"这类事故无法归因，
 * 所以 `date-fns` 已随本次迁移从依赖里移除（守卫：`zod-rules.spec.ts` 同级的 `format.spec.ts`
 * 断言产出串，见下）。pattern 一律引 `@/shared/time/zh-cn`，不在这里重复字面量。
 */

export function dateTime(value: string | null | undefined): string {
  return value ? dayjs(value).format(DEADLINE_COUNTDOWN_PATTERN) : "—";
}

/** 相对时间：列表里"3 天前"比"2026年9月24日 14:02"更适合扫读 */
export function fromNow(value: string | null | undefined): string {
  if (!value) return "—";
  const diffMin = Math.round((Date.now() - dayjs(value).valueOf()) / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hr = Math.round(diffMin / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 31) return `${day} 天前`;
  return dayjs(value).format(DATE_DISPLAY_PATTERN);
}

/**
 * 日历日期（`date` 列，无时刻）。
 *
 * ⚠ 刻意不经过 `dayjs(...)`：驱动回来的是 `'YYYY-MM-DD'` 字符串，
 * 交给 Date/dayjs 解析会按本地时区解释，在负时区上会**漂一天**。
 * 立案日与发现日属于"纸面上的那天"，不是某个瞬间——这条与修订稿 §12.2 同源。
 */
export function calDate(value: string | null | undefined): string {
  if (!value) return "—";
  const [y, m, d] = value.slice(0, 10).split("-");
  if (!y || !m || !d) return value;
  return `${y}年${Number(m)}月${Number(d)}日`;
}

/** 表单 `<input type=date>` / antd DatePicker 的回填值（同样是纯日期串） */
export const isoDate = (value: string | null | undefined): string =>
  value ? value.slice(0, 10) : "";

/** 标的额：`numeric(18,2)` 从驱动回来的就是字符串，绝不 Number() 参与运算（修订稿 §12.2） */
export function money(value: string | null | undefined): string {
  if (!value) return "—";
  const [int, frac] = value.split(".");
  const grouped = (int ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}${frac ? `.${frac}` : ""}`;
}

/** 紧凑金额：工作台卡片与合计行用，表格里仍给完整值 */
export function moneyCompact(value: string | number | null | undefined): string {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_0000_0000) return `${(n / 1_0000_0000).toFixed(2)} 亿`;
  if (n >= 1_0000) return `${(n / 1_0000).toFixed(1)} 万`;
  return String(n);
}

export const DATE_COMPACT = DATE_COMPACT_PATTERN;

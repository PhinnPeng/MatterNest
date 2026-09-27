import { format } from "date-fns";
import {
  DATE_COMPACT_PATTERN,
  DATE_DISPLAY_PATTERN,
  DEADLINE_COUNTDOWN_PATTERN,
} from "@/shared/time/zh-cn";

/**
 * 展示层格式化。**只在客户端组件里用**，服务端不格式化 —— 一旦两边各格式一份，
 * 列表与详情就会出现"同一条记录两个日期写法"。
 *
 * 时间戳一律是 DB 的 `timestamptz`（ISO 串），到期倒计时用完整日期时间；
 * 日历日期（立案日/发现日）是 `date` 列，不带时刻，所以单独一个 pattern。
 * pattern 常量来自 `@/shared/time/zh-cn`，不在这里重复字面量。
 */

export function dateTime(value: string | null | undefined): string {
  return value ? format(new Date(value), DEADLINE_COUNTDOWN_PATTERN) : "—";
}

/** 相对时间：列表里"3 天前"比"2026年9月24日 14:02"更适合扫读 */
export function fromNow(value: string | null | undefined): string {
  if (!value) return "—";
  const diffMs = Date.now() - new Date(value).getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 31) return `${day} 天前`;
  return format(new Date(value), DATE_DISPLAY_PATTERN);
}

export function calDate(value: string | null | undefined): string {
  // `date` 列回来的是 'YYYY-MM-DD'（无时区）。直接 format(new Date(...)) 会按 UTC 解析、
  // 在东八区显示成同一天，但在负时区会漂一天 —— 所以这里按字符串截，不经过 Date。
  if (!value) return "—";
  const [y, m, d] = value.slice(0, 10).split("-");
  if (!y || !m || !d) return value;
  return `${y}年${Number(m)}月${Number(d)}日`;
}

export const isoDate = (value: string | null | undefined): string =>
  value ? value.slice(0, 10) : "";

/** 标的额：`numeric(18,2)` 从驱动回来的就是字符串，绝不 Number() 参与运算（修订稿 §12.2） */
export function money(value: string | null | undefined): string {
  if (!value) return "—";
  const [int, frac] = value.split(".");
  const grouped = (int ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}${frac ? `.${frac}` : ""}`;
}

/**  compact 金额：工作台卡片上用，表格里仍用完整值 */
export function moneyCompact(value: string | number | null | undefined): string {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_0000_0000) return `${(n / 1_0000_0000).toFixed(2)} 亿`;
  if (n >= 1_0000) return `${(n / 1_0000).toFixed(1)} 万`;
  return String(n);
}

export const DATE_COMPACT = DATE_COMPACT_PATTERN;

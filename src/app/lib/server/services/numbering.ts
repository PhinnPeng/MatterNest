import { sql } from "drizzle-orm";
import { getDb } from "../db/client";

/**
 * 编号格式（2026-10-23 用户裁定）。
 *
 *   案件：`A` + `YYYYMMDD` + 4 位顺序号 → `A202610210001`
 *   事项：保持不变 → `FX-20260922-001`
 *
 * 三条不变量照旧：
 *   1. **日界按上海业务日**：`day_key = date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')::date`。
 *      禁止 `current_date` / `now()::date` —— 会话已钉 UTC（`db:check` C4），那两者在上海 0–8 点
 *      会把立案算到**前一天**，`db:check` C6 用同一个跨零点时刻实测差一天。
 *   2. **单语句原子取号**：`INSERT … ON CONFLICT DO UPDATE … RETURNING`，不"先查后写"，
 *      否则并发下两个案件拿同一个号（§12.3 的原始论证）。
 *   3. 序号溢出后**原样加宽**而不是报错（`A202610150001` 之后到 `A2026101510000`）；
 *      号可跳不可复。
 *
 * ## 为什么补零在 TS 里而不是 SQL
 *
 * PG 的 `lpad(str, len, fill)` 在 **str 比 len 长时是「截断」而不是「补齐」**：
 *   `lpad('10000', 4, '0') = '1000'` —— 于是万位以上全塌回千位段，直接撞唯一索引。
 * 这条坑在 `AJ-` 时代已经踩过一次（见 `agent-work/smoke-numbering.mjs` 的三组判据）。
 * 现在 SQL 只返回 `day_key` 与 `serial` 数字，补零交给 `String.prototype.padStart`
 * （只补不截），把"格式"和"取号"彻底分开。
 */
export const CODE_FORMAT = {
  matter: { prefix: "A", separator: "", serialWidth: 4 },
  riskMatter: { prefix: "FX", separator: "-", serialWidth: 3 },
} as const;

export type CodeHost = keyof typeof CODE_FORMAT;

/** 纯函数：给定宿主、业务日与序号，拼出编号。溢出时原样加宽，永不截断。 */
export function formatCode(host: CodeHost, dayKey: string, serial: number): string {
  const f = CODE_FORMAT[host];
  const serialText = String(serial).padStart(f.serialWidth, "0");
  return `${f.prefix}${f.separator}${dayKey}${f.separator}${serialText}`;
}

export async function nextCode(host: CodeHost): Promise<{ code: string; dayKey: string }> {
  const db = await getDb();
  const f = CODE_FORMAT[host];
  const rows = await db.execute<{ day_key: string; serial: number }>(sql`
    with step as (
      insert into mn_code_seq as s (day_key, prefix, value)
      values (
        date_trunc('day', now() at time zone 'Asia/Shanghai')::date,
        ${f.prefix},
        1
      )
      on conflict (day_key, prefix)
      -- 冲突时先 +1 再返回：首行占 0001，之后依次递增，不重号也不回退
      do update set value = s.value + 1
      returning s.day_key as day_key, s.value as value
    )
    select
      to_char(day_key, 'YYYYMMDD') as day_key,
      value as serial
    from step
  `);
  const row = rows[0];
  if (!row) throw new Error("取号失败：mn_code_seq 未返回行");
  return { code: formatCode(host, row.day_key, Number(row.serial)), dayKey: row.day_key };
}

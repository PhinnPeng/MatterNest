import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { CODE_PREFIX } from "../db/schema";

/**
 * 编号生成：`FX/AJ-YYYYMMDD-XXX`（修订稿 §12.3、基线 1.1/1.2）。
 *
 * 三条都不是细节：
 *   1. **日界按上海业务日**：`day_key = date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')::date`。
 *      禁止 `current_date` / `now()::date` —— 会话已钉 UTC（`db:check` C4），那两者在上海 0–8 点
 *      会把立案算到**前一天**，`db:check` C6 用同一个跨零点时刻实测差一天。
 *   2. **单语句原子取号**：`INSERT … ON CONFLICT DO UPDATE … RETURNING`，不"先查后写"，
 *      否则并发下两个案件拿同一个号（§12.3 的原始论证）。
 *   3. 溢出 999 后**扩成 4 位**而不是报错（`AJ-20261015-1000`）；号可跳不可复。
 */
export async function nextCode(
  prefix: keyof typeof CODE_PREFIX,
): Promise<{ code: string; dayKey: string }> {
  const db = await getDb();
  const p = CODE_PREFIX[prefix];
  const rows = await db.execute<{ code: string; day_key: string }>(sql`
    with step as (
      insert into mn_code_seq as s (day_key, prefix, value)
      values (
        date_trunc('day', now() at time zone 'Asia/Shanghai')::date,
        ${p},
        1
      )
      on conflict (day_key, prefix)
      -- 冲突时先 +1 再返回：首行占 001，之后依次递增，不重号也不回退
      do update set value = s.value + 1
      returning s.day_key as day_key, s.value as value
    )
    select
      to_char(day_key, 'YYYYMMDD') as day_key,
      ${p} || '-' || to_char(day_key, 'YYYYMMDD') || '-' ||
      -- ⚠ 这里**不能**用 PG 的 lpad(value::text, 3, '0')。
      --
      -- PG 的 lpad(str, len, fill) 在 **str 比 len 长时是「截断」而不是「补齐」**：
      --   lpad('999',3,'0')  = '999'   ← 正常
      --   lpad('1000',3,'0') = '100'   ← 截断，不是 '1000'
      --   lpad('1074',3,'0') = '107'   ← 于是 1000–1999 全塌进 100–199 这 100 个号段
      -- 后果不是"号难看"，是**撞号**：uk_mn_matter_internal_code 是裸唯一索引，
      -- 同一事务里两条 mn_matter 拿到同一个号 ⇒ 整笔回滚 ⇒ POST /api/matters 随机 500。
      -- 它还会让转案件（一次取 N 个号）在 N≥2 时**确定性失败**。
      --
      -- 这条契约（上面第 3 条：溢出 999 后扩成 4 位）原先只写在注释里、实现是反的，
      -- 而它在计数器 <1000 时**完全看不出来** —— 本仓的 AJ 计数器今天过千才显形，
      -- 那一刻起建案开始随机 500，排查时症状（唯一索引冲突）离根因（一个字符串函数语义）很远。
      -- 门禁见 numbering.spec.ts（含 999/1000/1074 三个边界）与 revred-numbering.mjs。
      case when value < 1000 then lpad(value::text, 3, '0') else value::text end as code
    from step
  `);
  const row = rows[0];
  if (!row) throw new Error("取号失败：mn_code_seq 未返回行");
  return { code: row.code, dayKey: row.day_key };
}

/** 展示用：把 `AJ-20260927-001` 拆成前缀与号段，UI 的编号条据此分行渲染 */
export function splitCode(code: string): { prefix: string; day: string; serial: string } {
  const [prefix = "", rest = ""] = code.split("-");
  const [day = "", serial = ""] = rest.split("-");
  return { prefix, day, serial };
}

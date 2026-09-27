import { sql, type SQL } from "drizzle-orm";

/**
 * DDL 侧的字面量拼装工具。
 *
 * 为什么需要它：**DDL 里没有参数上下文**。`sql\`x IN (${v})\`` 会把值编成 `$1`，
 * 于是 `CREATE TABLE … CHECK` / `CREATE INDEX … WHERE` 直接被 PG 拒
 * （`there is no parameter $1`）。2026-09-27 在 `drizzle-orm@0.45.3` 上用 `eq()` 写
 * partial index 的 `.where()` 时实测复现 —— 那正是禁令② 的成因，见
 * `docs/research-nextjs-stack.md` §8。
 *
 * 所以枚举值域要进 DDL 只能拼字面量。这里用 `sql.raw()` 并**强制取值只含 `[a-z0-9_]`**：
 * 值来源是 `src/shared/enums` 的受控常量，不是用户输入；加白名单是为了万一将来有人
 * 把动态值传进来时当场抛错，而不是产出一条注入型 DDL。
 */
export function sqlInList(column: string, values: readonly (string | number)[]): SQL {
  const list = values.map((v) => {
    const s = String(v);
    if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`值含非法字符，拒绝拼进 DDL：${s}`);
    return `'${s}'`;
  });
  if (list.length === 0) throw new Error(`${column} 的值域为空，拒绝产出 CHECK`);
  return sql.raw(`${column} IN (${list.join(",")})`);
}

/** 布尔列的"恰好一个为真"式约束，写成字面量 */
export function sqlRaw(expression: string): SQL {
  return sql.raw(expression);
}

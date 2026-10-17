/**
 * 合法：id 的处理全部交给 `http.ts:pathId()`。
 *
 * 这条 fixture 同时证明规则**没有过宽**，两条白名单都在这里：
 *   · `pathId()` 之后拿到的就是 `bigint`，不必再写形态正则；
 *   · **body 里的 id 数组**用 19 位上界是合法的 —— `shared/schema/batch.ts` 的注释
 *     写了理由（body 的 id 走不到 `pathId()`，但同一个上界必须跟着，否则 40 位 id
 *     会以 PG `value out of range` 变成 500）。那种形状被 selector 放过。
 */
import { pathId } from "@/app/lib/server/http";

declare const z: {
  string(): { regex(re: RegExp, msg?: string): unknown };
  array(item: unknown): { min(n: number): { max(n: number): unknown } };
};

export function parsePath(raw: string | undefined) {
  const pid = pathId(raw);
  if (!pid.ok) return pid.res;
  return pid.id;
}

/** body 侧的 id 数组：19 位上界在这里是**对的**（与 `pathId` 同一个上界） */
export const idsField = z
  .array(z.string().regex(/^\d{1,19}$/, "记录必须是数字字符串"))
  .min(1)
  .max(200);

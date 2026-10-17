/**
 * 合法：404 出口走唯一源 `http.ts:notFound()`。
 *
 * 这条 fixture 同时证明规则**没有过宽**：
 *   · `fail(403, …)` 与 `fail(422, …)` 照旧可以手写（规则只收 404 这一格，
 *     因为只有它背负"不可见与不存在同形"的语义）；
 *   · `json(data, 201)` 这类正常出口不受影响。
 */
import { fail, json, notFound } from "@/app/lib/server/http";

declare function loadThing(id: string): Promise<{ ok: boolean } | null>;

export async function getOne(id: string) {
  const row = await loadThing(id);
  if (!row) return notFound();
  return json(row);
}

export function updateOne(archived: boolean, unchanged: boolean) {
  if (archived) return fail(403, "archived", "这条记录已归档。归档是只读终态。");
  if (unchanged) return fail(422, "unchanged", "没有要改的内容。");
  return json({ ok: true });
}

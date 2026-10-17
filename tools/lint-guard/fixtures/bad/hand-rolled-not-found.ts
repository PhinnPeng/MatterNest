/**
 * 故意写坏：404 出口不走 `http.ts:notFound()`，自己拼一份。
 * check.mjs 会以 `src/app/api/` 下的虚拟路径喂给仓库 config，
 * 断言下面**两处** `fail(404, …)` 都被拦。
 *
 * 为什么这是个真问题（不是洁癖）：`api-route-conventions.md` 规则 3 把出口限定在
 * 那几个 helper 上，而「不可见与不存在**同形同措辞**」是权限模型的骨架 ——
 * 手写一份就多一份"找不到"的措辞，两句迟早分叉，而两条路都返回 404、都不报错。
 *
 * ⚠ 这个 fixture 里**不许出现**色值字面量、也不许出现 19 位 id 正则：
 * check.mjs 是按 ruleId（`no-restricted-syntax`）过滤计数的，
 * 混进别的 selector 的命中会让 `expectHits` 对不上。
 */
declare function fail(status: number, error: string, message: string): unknown;

export function getOne(visible: boolean) {
  if (!visible) return fail(404, "not_found", "找不到这条记录。"); // 1/2
  return { ok: true };
}

export function getOther(visible: boolean) {
  if (!visible) {
    return fail(404, "not_found", "没有找到这条记录，或你没有访问它的权限"); // 2/2 第二份措辞
  }
  return { ok: true };
}

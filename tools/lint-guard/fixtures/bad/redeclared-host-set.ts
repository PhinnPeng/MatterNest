/**
 * 故意写坏：宿主集合被抄成了第二份字面量。
 * check.mjs 会以 `src/app/api/` 下的虚拟路径喂给仓库 config，断言下面**两处**都被拦。
 *
 * 为什么这是个真问题：宿主集合的单一源是 `HOST_TYPES`（`shared/enums/targets.ts`）。
 * 抄第二份的失败形态是"某天新增宿主时改一处漏一处"，而两边都编译得过、单测也绿 ——
 * 2026-10-18 实测清掉两处（`services/selectable-users.ts`、`services/reports.ts`）。
 *
 * ⚠ 两处刻意写成**两种顺序**：只写一条 selector（`elements.0="matter"`）会漏掉倒序那种，
 * 而 `expectHits: 2` 正是为了暴露"只拦下一半"。
 *
 * ⚠ 不许出现色值字面量、`fail(404, …)`、19 位 id 正则：计数按 ruleId 过滤。
 */
export const hosts = ["matter", "risk_matter"] as const; // 1/2 正序

export function eachHost(fn: (h: string) => void) {
  for (const h of ["risk_matter", "matter"] as const) fn(h); // 2/2 倒序（同一份集合）
}

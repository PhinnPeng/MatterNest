/**
 * 数据范围的"宽度"与并集口径（权限草案 §1/§2）。
 *
 * 为什么单独一个文件而不塞进 `targets.ts`：并集规则会在 ScopeResolver、UI 的按钮可见性、
 * 契约矩阵三处被用到。塞在枚举总表里容易被人复制一份 `if (scope === 'all')`，
 * 那就变成两处口径实现 —— 一处放宽、一处忘了放宽，是权限模型最安静的出错方式。
 */
import type { DataScope } from "./targets";

/** 宽度只在这里定义一次 */
export const DATA_SCOPE_WIDTH: Record<DataScope, number> = {
  all: 3,
  participating: 2,
  owned: 1,
};

/**
 * 多角色取最宽并集（§2 注：既要管系统又要能撤销归档的人给两个角色，不新增第 6 个角色）。
 *
 * **空数组按最小权限的 `owned` 兜底**，不是放行：账号没绑角色是配置事故，
 * 让它看到全公司等于把配置错误升级成数据泄露。
 */
export function widestDataScope(scopes: readonly DataScope[]): DataScope {
  if (scopes.length === 0) return "owned";
  return scopes.reduce((a, b) => (DATA_SCOPE_WIDTH[b] > DATA_SCOPE_WIDTH[a] ? b : a));
}

/** UI 判定用：`have >= need`。范围是包含关系（L1 ⊃ L2 ⊃ L3），所以可以比大小 */
export function scopeCovers(have: DataScope, need: DataScope): boolean {
  return DATA_SCOPE_WIDTH[have] >= DATA_SCOPE_WIDTH[need];
}

/**
 * 状态偏离判定（修订稿 §3.3 第 3 条）—— 放 `shared/schema` 的理由和 `list-query.ts` 一样：
 * 前端要在提交前把「变更原因」输入框亮出来，后端要在服务层守住。两边各写一遍必然漂，
 * 而漂了的失败形态是"前端弹了框、后端说不用填"或反之，只有真点一次才发现。
 *
 * 三条口径都直接抄 §3.3，不是发挥：
 *   1. `fromNextCodes` **空 = 不限制** —— 配置驱动的状态集里，运营没填推荐后继就是不想约束，
 *      这时要原因会把正常操作全变成"必须解释"。
 *   2. 但**跳进归档态恒要原因**，不受上一条影响：归档是只读 + 列表默认隐藏的入口，
 *      而唯一出口是 `can_unarchive`（§3.3 第 4 条），是一次几乎不可逆的动作。
 *   3. `from === to` 不在这里判：服务层已经先返回 `unchanged`，这里给个 `false` 让单测好写。
 *
 * `toSemantics` 收 `string` 而不是 `StatusSemantics`：`mn_status_config.semantics` 是
 * `varchar + CHECK`（§8.3 明定不用 PG enum 类型），服务层查出来就是 `string`。
 * 这里只等值比较，写成枚举反而要在边界上撒断言 —— 那是把"值域由 DB CHECK 守"伪装成 TS 守。
 */
export function needsChangeReason(input: {
  from: string;
  /** 允许 `null` 元素：`text[]` 里理论上能塞进 NULL，调用方不必先过滤一遍 */
  fromNextCodes: readonly (string | null)[];
  to: string;
  toSemantics: string;
}): boolean {
  if (input.toSemantics === "archived") return true;
  if (input.from === input.to) return false;
  return input.fromNextCodes.length > 0 && !input.fromNextCodes.includes(input.to);
}

/**
 * 评论框里「这次 `@` 是不是在选人」的判定（`components/mention-input.tsx` 的纯函数部分）。
 *
 * 抽成独立模块只为一件事：**退出条件是这块唯一的易错处**，而它们没有一条靠肉眼能验。
 * 组件只在 DOM 上读 `value` + `selectionStart`，判定本身不碰 React —— 于是可以直接单测。
 *
 * 三条退出条件都与写入口径对齐（`shared/notification/mention.ts`）：
 *
 * · **邮箱不弹**：左邻是 ASCII 字母数字/邮箱符号时，`@` 只是地址的一部分。评论里贴邮箱是常事；
 * · **空白/换行结束一次提及**：与 rc-mentions 的 `split` 同义，也避免"整段话被当成一个查询串"；
 * · **又一个 `@` 作废上一个**：用户重打时，候选必须换到新的那个 `@` 上。
 */

/** 一次提及的触发点：`@` 的下标 + `@` 与光标之间的查询串 */
export type MentionTrigger = { start: number; query: string };

/** 邮箱/账号里可能紧挨 `@` 的字符（只挡 ASCII：中文句子里"请看@张三"是正常写法） */
const EMAIL_LEFT = /[A-Za-z0-9._%+-]/;
/** 查询串里出现这些就说明这次提及已经写完 */
const ENDS_MEASURE = /[\s@]/;

/**
 * 从 `caret` 往回找这次提及；不是提及就返回 `null`。
 *
 * `caret` 允许越界（浏览器在 `selectionStart` 上给的是 0..length），越界时按 `value` 长度处理。
 */
export function mentionTriggerAt(value: string, caret: number): MentionTrigger | null {
  const end = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, end);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;

  const prev = before[at - 1];
  if (prev && EMAIL_LEFT.test(prev)) return null;

  const query = before.slice(at + 1);
  if (ENDS_MEASURE.test(query)) return null;
  return { start: at, query };
}

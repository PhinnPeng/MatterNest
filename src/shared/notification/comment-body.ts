/**
 * 评论正文的**可渲染分段**（MATT-68 / T4b2：@提及的读取侧）。
 *
 * ## 为什么分段在服务端算，而不是前端拿到正文自己找
 *
 * `mention_ids` 是**事件发生那一刻**的事实（评论服务写的，也是通知的依据）。
 * 前端若为了高亮而重跑一遍"`@` + 名字"的匹配，会在两种情况下画出与通知**不一致**的高亮：
 *
 * · 正文被编辑过（`editRiskComment` **不重算** `mention_ids`）——
 *   编辑里新加的 `@某人` 从没发过通知，重解析却会把它高亮成"提及"；
 * · 同事改过名字——按现在的名字重解析会算出另一批人。
 *
 * 所以：**谁被点名只看 `mention_ids`**（服务端按它在库里取人），本模块只回答"这两个事实
 * 在正文里落在哪一段"。位置由 `parseMentionSpans` 给（与写入口径同一个匹配器）。
 *
 * ## 三种状态，两种画法
 *
 * | 名册里此刻的状态 | `status` | 画法 |
 * |---|---|---|
 * | 在职（`is_enabled` 且 `activation_status='active'` 且未软删） | `active` | 正常高亮 |
 * | 停用 / 未开通 / 已软删（行还在，名字还取得出来） | `inactive` | **仍然高亮**，但降级配色 + 说明 |
 * | 行不存在（一期用户只软删，理论上到不了） | —— | 不产生提及段：没有名字可定位，正文原样 |
 *
 * 停用为什么**不回退成纯文本**：那条评论的历史事实就是"当时点名了他"，而且通知当时确实发出去了。
 * 抹成普通文字等于让读者以为正文里的 `@张三` 是随手打的符号；而"停用"是**账号**状态，
 * 不是"这个人没被点名过"。降级配色 + 一句说明同时保住了这两件事。
 */

import { parseMentionSpans } from "./mention";

/** 被点名的人此刻的名册状态。`active=false` 涵盖停用、未开通与软删 */
export type MentionUser = {
  id: string;
  displayName: string;
  active: boolean;
};

/**
 * 一个提及段的状态。
 *
 * 只有两档：`inactive` 已经把"停用/未开通/已软删"收成一档 —— 对读者来说它们是同一件事
 * （这个人现在不在花名册上），而分成三档只会在界面上多出三种没人要求的灰度。
 */
export type MentionStatus = "active" | "inactive";

/** 正文的一段：纯文本，或一处提及 */
export type CommentPart =
  | { kind: "text"; text: string }
  | {
      kind: "mention";
      /** 正文里那个字面的名字（不是名册里的现名） */
      name: string;
      /** 命中的人；同名同事不止一个 */
      ids: string[];
      status: MentionStatus;
    };

/**
 * 把一条评论的正文切成可渲染分段。
 *
 * `mentioned` 必须是**从这条评论的 `mention_ids` 解出来的那几个人**（顺序无所谓，本函数按正文顺序排）。
 * 传全花名册进来的话，正文里任何一个与同事重名的 `@词` 都会被高亮 —— 那正是"重解析"，
 * 而它与通知不是同一批人。
 */
export function buildCommentParts(body: string, mentioned: readonly MentionUser[]): CommentPart[] {
  if (!body) return [];

  const spans = parseMentionSpans(
    body,
    mentioned.map((u) => ({ id: u.id, displayName: u.displayName })),
  );
  if (spans.length === 0) return [{ kind: "text", text: body }];

  const byId = new Map(mentioned.map((u) => [u.id, u] as const));
  const parts: CommentPart[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) parts.push({ kind: "text", text: body.slice(cursor, span.start) });
    parts.push({
      kind: "mention",
      name: span.name,
      ids: span.ids,
      /**
       * 同名同事里**只要有一个已停用就画降级态**：读者看到的是一个名字，
       * 分不出"哪一个"已停用；画成正常高亮会让"这个人还在"成为假事实。
       */
      status: span.ids.every((id) => byId.get(id)?.active === true) ? "active" : "inactive",
    });
    cursor = span.end;
  }
  if (cursor < body.length) parts.push({ kind: "text", text: body.slice(cursor) });
  return parts;
}

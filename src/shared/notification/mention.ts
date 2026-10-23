/**
 * 评论正文里的 **@提及** 解析（MATT-58 / T4b）。
 *
 * ## 为什么不发明一套提及语法
 *
 * 先读现有实现，再决定形态。三条事实决定了这里只能是"**`@` + 显示名**"：
 *
 * 1. **库里已经有落点**：`mn_comment.mention_ids`（`bigint[]`，基线迁移 0000）
 *    的列注就是「@提及的 user id 数组，通知链路将来靠它展开」——
 *    存储形态不是本票要发明的，是本票要**兑现**的。
 * 2. **前端能产出的只有纯文本**：评论输入是 antd `Input.TextArea`
 *    （`matter-detail.tsx` 的 `LogTab`、`risk-detail.tsx` 的 `CommentList`），
 *    富文本编辑器（BlockNote，ADR-0002）只用在别处且是**纯默认配置**、没有 mention 插件。
 *    也就是说用户在输入框里能敲出来的 `@`，就是字面的 `@张三`。
 * 3. **设计稿把归属写死了**：`docs/PRD-phase1-design-revision-r1.md:156`
 *    「`mention`（@提及）**不经规则引擎，由评论服务直接发事件**」——
 *    所以解析发生在评论服务，不挂在 `event_occurred` 规则上。
 *
 * 换成结构化提及（BlockNote 的 mention 节点 + 选人菜单）会同时动前端编辑器配置、
 * markdown 往返与 DTO 三处，且 ADR-0002 明写编辑器保持默认配置。那是另一张票。
 *
 * 之后补了一个**只产文本**的选人面（`components/mention-input.tsx`，2026-10-22）：
 * 按 `@` 弹出候选、选中后把 `@显示名 ` 插进光标处。它不改变这里的匹配口径 ——
 * 落库的仍然是那串字面文本，`mention_ids` 仍然由本文件的匹配器解析。
 *
 * ## 匹配规则（只有一条，但它是错的常客）
 *
 * **长名优先**：候选里有「张三」与「张三丰」时，`@张三丰` 必须命中后者。
 * 按长度降序试，命中即定；命中后**跳过整个名字**再继续扫，
 * 所以 `@张三@李四` 两个人都在，而名字内部不会二次匹配。
 *
 * 刻意**不要求**词边界：中文没有空格，要求边界等于让 `@张三，请看一下` 失配——
 * 而那是这个功能最常见的写法。误报的代价也低：只有**真存在一个同名同事**时才会命中。
 */

/** 候选人的最小形状。只需要"能被人打出来的那个名字"与 id */
export type MentionCandidate = {
  id: string;
  displayName: string;
};

/** 提及前缀。写出来是为了让"改语法"只有一处落点 */
export const MENTION_PREFIX = "@";

/**
 * 正文里**一处**提及：`@` 的下标 + 命中的字面名字 + 这个字面名字命中的全部同事。
 *
 * `ids` 是数组而不是单值：同名同事（`display_name` 无唯一约束）会同时命中，见 `parseMentionIds`。
 */
export type MentionSpan = {
  /** `@` 的下标 */
  start: number;
  /** 名字结束的下标（`end = start + @ 的长度 + name.length`） */
  end: number;
  /** 正文里那个字面的名字（**不是**候选人现在的 `display_name`）；原样切出来，供渲染方按需高亮 */
  name: string;
  /** 命中的人。同名时不止一个，顺序同 `parseMentionIds` 的口径 */
  ids: string[];
};

/**
 * 从评论正文里解析被 @ 到的人**及其在正文里的位置**（MATT-68 / T4b2 的读取侧要它）。
 *
 * 为什么位置也要：渲染侧要把 `@张三` 画成可辨认的样子，就必须知道它在正文里是哪一段。
 * 这件事只能由**同一个匹配器**做 —— 另写一套定位（哪怕是"再跑一遍正则"）会在
 * "长名优先"、"命中后跳过整个名字"、"不要求词边界"这三条上与前缀解析分叉，
 * 于是通知发给了 A、界面高亮的却是 B。所以本文件只有**一个**走位循环，
 * `parseMentionIds` 是它的一层投影（见下）。
 *
 * ⚠ 位置是**这一刻**按候选人算出来的：同一条评论换一套候选人会得到不同的位置
 * （`@张三丰` 在只认识「张三」的人眼里是命中「张三」）。调用方必须与写入口径给同一批候选人。
 */
export function parseMentionSpans(
  body: string,
  candidates: readonly MentionCandidate[],
): MentionSpan[] {
  if (!body || candidates.length === 0) return [];

  // 长名优先。同长度的候选在同一个位置只可能是同一个串，所以长度降序已经够定序；
  // 再加 `id` 作为次序键只是为了**结果稳定**（同名时返回顺序不随输入顺序漂移）
  const ordered = candidates
    .filter((c) => c.displayName.length > 0)
    .slice()
    .sort(
      (a, b) =>
        b.displayName.length - a.displayName.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const spans: MentionSpan[] = [];
  let i = 0;
  while (i < body.length) {
    const at = body.indexOf(MENTION_PREFIX, i);
    if (at < 0) break;

    let matchedLength = 0;
    for (const c of ordered) {
      // 已按长度降序：剩下的都不比已命中的长，不可能再赢
      if (c.displayName.length <= matchedLength) break;
      if (body.startsWith(c.displayName, at + MENTION_PREFIX.length)) {
        matchedLength = c.displayName.length;
      }
    }
    if (matchedLength === 0) {
      // 这个 `@` 后面不是任何同事的名字（邮箱、`@所有人`、随手打的符号）——跳过它继续找
      i = at + MENTION_PREFIX.length;
      continue;
    }

    const name = body.slice(at + MENTION_PREFIX.length, at + MENTION_PREFIX.length + matchedLength);
    spans.push({
      start: at,
      end: at + MENTION_PREFIX.length + matchedLength,
      name,
      ids: ordered.filter((c) => c.displayName === name).map((c) => c.id),
    });
    i = at + MENTION_PREFIX.length + matchedLength;
  }
  return spans;
}

/**
 * 从评论正文里解析被 @ 到的人。
 *
 * 返回**按出现顺序**排好的 user id（同一人在一条评论里 @ 两次只算一次）。
 * 顺序有意义：`mention_ids` 落库后是排障时的第一手证据，
 * 排序会让"谁先被点名"这件事在库里看不出来。
 *
 * 同名同事（`display_name` 没有唯一约束，只有 `username` 有）**全部命中**而不是任选一个：
 * 本票要挡的失败形态正是"@ 了人但通知没发出去"这种静默，宁可多喊一个同事，
 * 也不要让点名落空。这是 10 人组织里可接受的代价（IQ-14 同一条理由：花名册无保密价值）。
 *
 * 实现是 `parseMentionSpans` 的**投影**（同一次走位，去掉位置、按首次出现去重）——
 * 不在这里另写一遍匹配：两份匹配器迟早会在"长名优先"这类细节上分叉，
 * 而分叉的后果是"通知发给谁"与"界面高亮谁"不再一致（T4b2 正是为此而开）。
 */
export function parseMentionIds(body: string, candidates: readonly MentionCandidate[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const span of parseMentionSpans(body, candidates)) {
    for (const id of span.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

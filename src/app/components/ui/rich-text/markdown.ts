/**
 * 富文本 ↔ markdown 的存取口径（MATT-57 / ADR-0002）。
 *
 * 存储一律走 **markdown**：写入 `blocksToMarkdownLossy`、读取 `tryParseMarkdownToBlocks`。
 * 选 markdown 而不是 JSON 的理由（ADR §Consequences）：列表的 `ILIKE` 搜索直接可用，
 * 不需要额外的纯文本投影列。
 *
 * ## 为什么这里要处理空段落（UnionDesk 踩过的坑）
 *
 * `blocksToMarkdownLossy` 会丢掉**空段落**；段落内硬换行若落成单个 `\n`，
 * react-markdown 默认当软换行渲染成空格 ⇒ 预览把两行并成一行。
 * 所以导出前给空段落塞一个 NBSP，往返才不丢结构。
 * 与 `remark-breaks`（只读渲染侧）配套：一个保证不丢，一个保证软换行不被折成空格。
 */

type InlineContent = { type: string; text?: string; styles?: Record<string, unknown> };
type Block = {
  type: string;
  content?: InlineContent[] | unknown;
  children?: Block[];
  [key: string]: unknown;
};

/**
 * NBSP（U+00A0）。用 `fromCharCode` 造，不写字面量：
 * 裸 NBSP 会撞 eslint 的 `no-irregular-whitespace`（肉眼看不出的空白不该以裸字面量进代码），
 * 而转义写法在多次工具往返里极易被二次转义成字面反斜杠——fromCharCode 无此歧义。
 */
const NBSP = String.fromCharCode(0xa0);

function isEmptyParagraph(block: Block): boolean {
  if (block.type !== "paragraph") return false;
  const content = block.content;
  if (!Array.isArray(content) || content.length === 0) return true;
  return content.every((item) => {
    if (typeof item !== "object" || item === null || !("type" in item)) return false;
    if ((item as InlineContent).type !== "text") return false;
    const text = (item as InlineContent).text ?? "";
    // String.trim() 的 WhiteSpace 集**含 NBSP**，所以 trim 后为空即"纯空白段落"
    return text.trim().length === 0;
  });
}

/** 导出前：空段落写入 NBSP，避免 markdown 往返时被吃掉（含一层子块） */
export function preserveEmptyParagraphs<T extends Block>(blocks: T[]): T[] {
  return blocks.map((block) => {
    const nextChildren = Array.isArray(block.children)
      ? preserveEmptyParagraphs(block.children as T[])
      : block.children;
    if (isEmptyParagraph(block)) {
      return {
        ...block,
        content: [{ type: "text", text: NBSP, styles: {} }],
        children: nextChildren,
      };
    }
    if (nextChildren !== block.children) return { ...block, children: nextChildren };
    return block;
  });
}

/**
 * 迁移兼容（票面「既有行按整段当一个段落解析」）：
 * 纯文本里没有 markdown 结构，`tryParseMarkdownToBlocks` 会把它当**一个段落**——
 * 正是我们要的，不做富文本反推。所以读取路径对"历史纯文本行"与"新存的 markdown"
 * 用同一个解析器即可，无需分支。这里只留一句判据说明，不写代码。
 */

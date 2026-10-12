import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import { INK } from "@/app/theme/brand";

/**
 * 只读渲染：markdown → DOM（MATT-57 / ADR-0002）。
 *
 * · 走 `react-markdown` **默认转义**，不开 raw HTML 通道（`skipHtml` 之外不引
 *   `rehype-raw`）——存进来的 markdown 来自 BlockNote 的 lossy 导出，本就不该有 HTML；
 *   万一有人手填 `<script>`，默认转义让它变成字面文本。
 * · `remark-breaks` 让软换行（段内单个 `\n`）渲染成 `<br>`，不被折叠成空格
 *   ——这是 UnionDesk 在 `description-template-markdown.ts` 踩过的坑，配套
 *   `markdown.ts` 的"空段落塞 NBSP"一起保证往返不丢结构。
 * · 这是**服务端可渲染**的组件（不碰 window），所以详情页的描述块能随 SSR 出骨架。
 *
 * 样式刻意薄：只给行高/颜色/间距与列表缩进，块级外观交给内容本身。
 * 富文本编辑态内的控件是 Mantine 外观（ADR 的既定代价），但**只读**态不该带那套。
 */
export function RichTextView({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div className={className} style={{ fontSize: 13.5, lineHeight: 1.72, color: INK.secondary }}>
      <Markdown
        remarkPlugins={[remarkBreaks]}
        components={{
          // 收紧默认 UA 样式，让它贴合本仓的密度（不引 typography 插件，那是又一依赖）
          p: (props) => <p style={{ margin: "0 0 8px" }} {...props} />,
          ul: (props) => <ul style={{ margin: "0 0 8px", paddingLeft: 20 }} {...props} />,
          ol: (props) => <ol style={{ margin: "0 0 8px", paddingLeft: 20 }} {...props} />,
          li: (props) => <li style={{ margin: 0 }} {...props} />,
          h1: (props) => (
            <div style={{ fontSize: 16, fontWeight: 600, margin: "6px 0" }} {...props} />
          ),
          h2: (props) => (
            <div style={{ fontSize: 15, fontWeight: 600, margin: "6px 0" }} {...props} />
          ),
          h3: (props) => (
            <div style={{ fontSize: 14, fontWeight: 600, margin: "6px 0" }} {...props} />
          ),
          blockquote: (props) => (
            <blockquote
              style={{
                margin: "0 0 8px",
                paddingLeft: 10,
                borderLeft: `2px solid ${INK.rail}`,
                color: INK.muted,
              }}
              {...props}
            />
          ),
          code: (props) => (
            <code
              style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.92em" }}
              {...props}
            />
          ),
          a: (props) => <a style={{ color: "inherit" }} {...props} />,
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}

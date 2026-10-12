"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

import { useEffect, useRef } from "react";
import { zh } from "@blocknote/core/locales";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { preserveEmptyParagraphs } from "./markdown";

/**
 * 富文本编辑器（MATT-57 / ADR-0002）——BlockNote + Mantine 皮肤，纯默认配置。
 *
 * ## 为什么这个文件是禁令⑦ 的唯一例外
 *
 * `@blocknote/*` 与它要求的 `@mantine/*` 皮肤**只允许出现在这个目录内**
 * （`components/ui/rich-text/`）。`@mantine/*` 不得用于任何其他控件，编辑器之外一律 antd。
 * 理由与代价见 `docs/adr/0002-rich-text-blocknote.md`：与同级项目 UnionDesk 同栈，
 * 换一次跨项目一致性，代价是编辑态内控件外观是 Mantine 的（不是缺陷，别"顺手统一"）。
 *
 * ## 用法照抄 UnionDesk 的 `description-template-editor.tsx`
 *
 * · `useCreateBlockNote({ dictionary: zh })` + `<BlockNoteView theme onChange />`，
 *   **不定制斜杠菜单、不做常驻顶部工具条**（默认 UI：`/` 唤块菜单 + 选中浮格式条）。
 * · 存储走 markdown：写入前 `preserveEmptyParagraphs` 再 `blocksToMarkdownLossy`
 *   （空段落塞 NBSP，防往返丢失），读取 `tryParseMarkdownToBlocks`。
 *
 * ## 受控边界（为什么 initialMarkdown 只在挂载时读一次）
 *
 * BlockNote 自己持有文档状态。若每次 `value` 变化都重新 parse 灌回去，光标会跳、
 * 输入会被打断。所以这里是**挂载时载入一次**、之后只 `onChange` 往外发——
 * 与 antd `Form.Item` 的受控模型对接时，`value` 只作初值，不作回流。
 * 换一条记录编辑靠外层给这个组件换 `key` 触发重挂载（UnionDesk 同款手法）。
 */
export function RichTextEditor({
  initialMarkdown,
  onChange,
}: {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
}) {
  const editor = useCreateBlockNote({ dictionary: zh });
  const loadedRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialRef = useRef(initialMarkdown);

  const emit = () => {
    const markdown = editor.blocksToMarkdownLossy(
      preserveEmptyParagraphs(editor.document) as never,
    );
    onChangeRef.current(markdown);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      loadedRef.current = false;
      const blocks = await editor.tryParseMarkdownToBlocks(initialRef.current || "");
      if (cancelled) return;
      editor.replaceBlocks(editor.document, blocks);
      loadedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
    // 只在挂载时载入一次；换记录靠外层换 key 重挂载（见文件头注）
  }, [editor]);

  return (
    <BlockNoteView
      editor={editor}
      theme="light"
      onChange={() => {
        // 载入完成前 BlockNote 会因 replaceBlocks 触发 onChange，那次不该往外发
        if (!loadedRef.current) return;
        emit();
      }}
    />
  );
}

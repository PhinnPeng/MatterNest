"use client";

import { RichTextEditorLazy } from "./client";

/**
 * antd `Form.Item` 的受控字段壳（MATT-57）——把编辑器接进表单校验单一来源。
 *
 * Form.Item 会把 `value` / `onChange` 注进直接子节点：
 *   · `value`（markdown 字符串）只作**挂载初值**——编辑器内部忽略后续回流，
 *     否则每次 onChange 都重新 parse 灌回去，ProseMirror 光标会跳；
 *   · `onChange` 收到的是 markdown 字符串，正是 `riskCreateSchema.description`
 *     要的形状，rules 照走（Zod → zod-rules，不另发明一套校验）。
 *
 * 重置草稿态不靠这里写逻辑：外层 Modal 用 `destroyOnHidden`，重开整棵子树重挂。
 */
export function RichTextFormField({
  value = "",
  onChange,
}: {
  value?: string;
  onChange?: (markdown: string) => void;
}) {
  return (
    <RichTextEditorLazy
      initialMarkdown={typeof value === "string" ? value : ""}
      onChange={(md) => onChange?.(md)}
    />
  );
}

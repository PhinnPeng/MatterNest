/**
 * 富文本编辑器对外出口（MATT-57 / 禁令⑦ 白名单的唯一入口）。
 *
 * 全仓**只有这个目录**允许 import `@blocknote/*` 与 `@mantine/*`。业务侧一律从这里取：
 *   · 只读渲染 → `RichTextView`（服务端可渲染，详情页静态 import）
 *   · 编辑态 → `RichTextEditorLazy`（`next/dynamic` + `ssr:false`，只在浏览器拉 BlockNote）
 * 直接从 `RichTextEditor.tsx` 静态 import 会把整个编辑器打进首屏 bundle 且 SSR 会炸——
 * 所以对外只暴露这两个，编辑器本体不从这里直出。
 */
export { RichTextView } from "./RichTextView";
export { RichTextEditorLazy } from "./client";
export { RichTextFormField } from "./FormField";

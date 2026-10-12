"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "antd";

/**
 * 编辑器的客户端动态入口（MATT-57）。
 *
 * BlockNote 依赖浏览器 API（ProseMirror / selection / window），不能 SSR。
 * 按这个版本 Next 的懒加载约定（`node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`
 * 的「With no SSR」节）：`next/dynamic` + `ssr:false`，且 `import()` 路径必须字面量写在
 * `dynamic()` 里、`dynamic()` 必须在模块顶层——所以这里单独成文件，
 * 让 `RichTextEditor.tsx`（含 `@blocknote`/`@mantine` 顶层 import）只在浏览器被拉进来。
 *
 * 只读渲染（`RichTextView`）**不需要**这层——react-markdown 服务端可渲染，
 * 详情页直接静态 import 它，描述能随 SSR 出骨架。
 */
export const RichTextEditorLazy = dynamic(
  () => import("./RichTextEditor").then((m) => m.RichTextEditor),
  {
    ssr: false,
    loading: () => <Skeleton active paragraph={{ rows: 3 }} />,
  },
);

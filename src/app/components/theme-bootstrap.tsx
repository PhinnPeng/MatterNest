"use client";

import { useServerInsertedHTML } from "next/navigation";

import { appearanceBootstrapScript } from "@/app/theme/appearance";

/**
 * 首帧脚本的注入点：读 `localStorage`，有已存深色偏好就给 `<html>` 打 `dark`。
 *
 * ## 为什么不用 `next/script` 的 `beforeInteractive`
 *
 * 文档说"always injected inside the `head`"，但**内联**脚本在本版本走的是
 * `self.__next_s` 队列（`<script>(self.__next_s=self.__next_s||[]).push([0,{children:…}])</script>`），
 * 真正的 `<script>` 元素由客户端运行时创建 —— 那已经在 Next 的 bundle 启动之后，
 * 第一帧早就画完了，白闪照旧。实测：那段注册脚本出现在 `<body>` 里，`<head>` 里没有。
 *
 * ## 为什么是 `useServerInsertedHTML`
 *
 * 它是这条路径上**本仓已经在用**的机制：`AntdRegistry` 靠它把 antd 的样式塞进
 * `</head>` 之前（实测位置一致），所以"插进 head 且早于首帧"这件事在同一个应用里
 * 已经被证明。它只在服务端渲染时执行一次，而客户端导航不需要重跑——
 * 类名已经打在 `<html>` 上，React 那侧的状态由 `AppearanceProvider` 的 effect 接住。
 */
export function ThemeBootstrap() {
  useServerInsertedHTML(() => (
    <script dangerouslySetInnerHTML={{ __html: appearanceBootstrapScript() }} />
  ));
  return null;
}

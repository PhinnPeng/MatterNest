/**
 * 外观（浅色 / 深色）的**读、写与首帧脚本**。
 *
 * 这个文件不 import react，也不 import "use client"：它两头都要用——
 * 服务端的 `app/layout.tsx` 要拿 `appearanceBootstrapScript()` 去注入 `<head>`，
 * 客户端的选择器组件要调 `applyAppearance()` 落盘。React 那一半（provider / hook）
 * 在 `./appearance-provider.tsx`。
 *
 * ## 为什么是 localStorage + `<head>` 脚本，而不是 cookie 或"等 hydration"
 *
 * 外观是**本机偏好**不是服务端事实，所以存在 `localStorage`。代价是服务端第一次渲染
 * 时不知道它——若等到 hydration 再改，用户会先看到一整屏浅色再"啪"地变深（US 4 说的白闪）。
 * 所以 `<head>` 里放一段**同步**脚本：它在浏览器画出第一帧之前就把 `html.dark` 打上，
 * 而两段令牌（`:root` / `html.dark`）早就静态注入在同一次响应里，于是第一帧就是深色。
 *
 * ⚠ 由此带来两条必须遵守的事：
 *   · 深色类是 `documentElement` 上的（那一刻 `<body>` 还不存在）；
 *   · React 那侧首帧**固定按浅色渲染**（状态初值是 "light"），否则 hydration 会对不上；
 *     `<html>` 上因此有 `suppressHydrationWarning`。antd 的 algorithm 会在挂载后
 *     一个 effect 里跟上——页面背景与外壳的第一帧已经是对的，只有 antd 组件自身
 *     会在那一帧之后换色。
 */
import { DARK_CLASS, type Appearance } from "./brand";

/** `localStorage` 的键。改它等于让所有已存偏好失效，慎改。 */
export const APPEARANCE_KEY = "mn-appearance";

/** 没有已存偏好时的外观。SSR 一律按它渲染。 */
export const DEFAULT_APPEARANCE: Appearance = "light";

/** 读已存偏好。不可用（SSR / 隐私模式禁读）时按默认外观，不抛。 */
export function readStoredAppearance(): Appearance {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  try {
    return window.localStorage.getItem(APPEARANCE_KEY) === "dark" ? "dark" : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/**
 * 把外观落到 DOM（`html.dark`）与 `localStorage`。
 *
 * `persist: false` 用于"状态跟上已存的偏好"那种调用——此时不该反过来再写一次存储。
 */
export function applyAppearance(appearance: Appearance, { persist = true } = {}): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(DARK_CLASS, appearance === "dark");
  if (!persist) return;
  try {
    window.localStorage.setItem(APPEARANCE_KEY, appearance);
  } catch {
    // 隐私模式禁写：本次会话仍然生效（类名已经打上了），只是刷新后回到已存值
  }
}

/**
 * 首帧脚本（`<head>` 里同步执行的那段）。
 *
 * 手写成自包含的 IIFE 而不是从上面的函数拼出来：它要在**没有模块系统**的那一刻跑，
 * 只能引用浏览器全局。键名与类名从常量插进去，避免第二份字面量。
 */
export function appearanceBootstrapScript(): string {
  return (
    `(function(){try{` +
    `if(localStorage.getItem(${JSON.stringify(APPEARANCE_KEY)})==="dark")` +
    `{document.documentElement.classList.add(${JSON.stringify(DARK_CLASS)})}` +
    `}catch(e){}})();`
  );
}

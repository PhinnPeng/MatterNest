/**
 * 外观偏好（跟随系统 / 浅色 / 深色）的**读、写、解析与首帧脚本**。
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
 *
 * ## 三档之后新增的一档：`system`（2026-10-18）
 *
 * 存的是**偏好**（`AppearancePref`）而不是物理外观：`"system"` 也原样落盘，
 * 由 `resolveAppearance()` 在运行时折成两台之一。折的动作要读 `matchMedia`，
 * 而 `matchMedia` 只在浏览器里有——所以本文件是"读浏览器"的唯一出处，
 * `brand.ts` 的 `resolveAppearance()` 保持纯函数（测试不必造 DOM）。
 */
import {
  DARK_CLASS,
  DARK_MEDIA_QUERY,
  resolveAppearance,
  type Appearance,
  type AppearancePref,
} from "./brand";

/** `localStorage` 的键。改它等于让所有已存偏好失效，慎改。 */
export const APPEARANCE_KEY = "mn-appearance";

/**
 * 没有已存偏好时的偏好档。**跟随系统**（2026-10-18 用户裁定）：
 * 三档里它是唯一不会与用户当下环境相左的一档——新同事第一次打开就与他的系统一致。
 */
export const DEFAULT_APPEARANCE_PREF: AppearancePref = "system";

/**
 * 旧常量名保留（迁移期别名）：值是**物理**外观，只用于"解析不出偏好时兜底成哪一台"。
 * 别把它当默认偏好用——默认偏好是上面的 `DEFAULT_APPEARANCE_PREF`。
 */
export const DEFAULT_APPEARANCE: Appearance = "light";

/** 判定一个存进去的字符串是不是合法偏好。非法值（手改 localStorage / 旧版本残留）当没存过。 */
function isPref(v: string | null): v is AppearancePref {
  return v === "system" || v === "light" || v === "dark";
}

/**
 * 读已存偏好。不可用（SSR / 隐私模式禁读）或值非法时按默认偏好，不抛。
 *
 * 旧的两档值（`"light"` / `"dark"`）依然是合法偏好，**不需要迁移**——
 * 这正是"偏好"与"物理外观"取值重叠带来的好处。
 */
export function readStoredAppearance(): AppearancePref {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE_PREF;
  try {
    const raw = window.localStorage.getItem(APPEARANCE_KEY);
    return isPref(raw) ? raw : DEFAULT_APPEARANCE_PREF;
  } catch {
    return DEFAULT_APPEARANCE_PREF;
  }
}

/**
 * 系统当前是不是深色。浏览器里读 `matchMedia`；没有它的环境（SSR / 老浏览器）按浅色。
 *
 * 抽出来是因为有三个调用点（首帧脚本对应的运行时、provider 的初值修正、provider 的订阅回调），
 * 三处各写一遍 `matchMedia(...).matches` 就会有三种对"没有 matchMedia"的处置。
 */
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(DARK_MEDIA_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * 把外观落到 DOM（`html.dark` + `color-scheme`）与 `localStorage`。
 *
 * 收的是**偏好**：`system` 也原样落盘，只有 DOM 那一步才折成物理外观。
 * `persist: false` 用于"状态跟上已存的偏好"那种调用——此时不该反过来再写一次存储。
 *
 * `color-scheme` 一并写：它让**原生控件**（滚动条、日期选择器的弹层、`<select>` 下拉）
 * 跟着换深色。antd 自己的控件不受影响（它们走 token），但浏览器那几处不属于任何设计系统，
 * 不写就会在深色页里露出一条白滚动条。
 */
export function applyAppearance(pref: AppearancePref, { persist = true } = {}): void {
  if (typeof document === "undefined") return;
  const appearance = resolveAppearance(pref, systemPrefersDark());
  document.documentElement.classList.toggle(DARK_CLASS, appearance === "dark");
  document.documentElement.style.colorScheme = appearance;
  if (!persist) return;
  try {
    window.localStorage.setItem(APPEARANCE_KEY, pref);
  } catch {
    // 隐私模式禁写：本次会话仍然生效（类名已经打上了），只是刷新后回到已存值
  }
}

/**
 * 首帧脚本（`<head>` 里同步执行的那段）。
 *
 * 手写成自包含的 IIFE 而不是从上面的函数拼出来：它要在**没有模块系统**的那一刻跑，
 * 只能引用浏览器全局。键名、类名、媒体查询、三个偏好值都从常量插进去，避免第二份字面量。
 *
 * 判据与 `resolveAppearance()` 一致，只是在这里展开成一行表达式：存的是 `"dark"` 就是深，
 * 存的是 `"light"` 就是浅，**其余（`"system"` / 没存过 / 值非法）一律问系统**。
 * 这一行决定了默认态是"跟随系统"——与 `DEFAULT_APPEARANCE_PREF` 是同一条判定，
 * 改一处必须改另一处。
 */
export function appearanceBootstrapScript(): string {
  const key = JSON.stringify(APPEARANCE_KEY);
  const cls = JSON.stringify(DARK_CLASS);
  const mq = JSON.stringify(DARK_MEDIA_QUERY);
  const light = JSON.stringify("light");
  const dark = JSON.stringify("dark");
  return (
    `(function(){try{` +
    `var p=localStorage.getItem(${key});` +
    `var d=(p===${dark})||(p!==${light}&&window.matchMedia(${mq}).matches);` +
    `if(d){document.documentElement.classList.add(${cls});}` +
    `document.documentElement.style.colorScheme=d?"dark":"light";` +
    `}catch(e){}})();`
  );
}

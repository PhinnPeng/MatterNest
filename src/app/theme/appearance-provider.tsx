"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { DARK_MEDIA_QUERY, resolveAppearance, type Appearance, type AppearancePref } from "./brand";
import {
  applyAppearance,
  DEFAULT_APPEARANCE_PREF,
  readStoredAppearance,
  systemPrefersDark,
} from "./appearance";

/**
 * 外观状态。**全站唯一的持有者**：`ConfigProvider` 的 algorithm 与侧栏底部的切换器
 * 都读它——两处各自 `useState` 就会立刻出现"切了主题但 antd 还是亮的"。
 *
 * 首帧初值固定默认偏好：SSR 与客户端第一次渲染必须逐字一致（见 `./appearance.ts` 的头注）。
 * 真正的偏好由 `<head>` 脚本先行落到 DOM，挂载后的那个 effect 只把 React 状态对齐过去。
 *
 * ## 两个值：偏好与物理外观（2026-10-18，三档）
 *
 *   · `pref` —— 用户选的（`system` / `light` / `dark`）。存的是它，切换器的高亮也是它。
 *   · `appearance` —— **解析后**的物理外观（只有 `light` / `dark`）。
 *     `tokensOf` / `antdThemeConfig` / 别处一切"要一套颜色"的调用点都读它。
 *
 * 分成两个而不是把 `system` 塞进 `appearance`：后者的每个消费者都得自己再判一次
 * "system 算哪台"，判漏一处就是深色偏好下露出浅色组件。解析只有一处（`resolveAppearance`）。
 */
type AppearanceContextValue = {
  /** 用户选定的偏好档（切换器的高亮读它） */
  pref: AppearancePref;
  /** 解析后的物理外观（要颜色/算法的地方读它） */
  appearance: Appearance;
  setAppearance: (next: AppearancePref) => void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<AppearancePref>(DEFAULT_APPEARANCE_PREF);
  /** 系统深浅。跟着媒体查询的变化走，只喂给 `resolveAppearance`。 */
  const [prefersDark, setPrefersDark] = useState(false);

  // 与 `<head>` 脚本的结果对齐，并顺手纠正"脚本没跑成"的情形（CSP 拦内联脚本等）
  useEffect(() => {
    const stored = readStoredAppearance();
    setPref(stored);
    setPrefersDark(systemPrefersDark());
    applyAppearance(stored, { persist: false });
  }, []);

  /*
   * 跟随系统时，系统的深浅切换要当场跟（用户睡前把系统切深、页面还亮着，是最容易记住的坏体验）。
   * 订阅**常挂**而不只在 `pref === "system"` 时挂：挂/卸本身要写清理逻辑，
   * 而多挂一个 change 监听几乎没有成本；状态里那个 `prefersDark` 在非 system 档下只是闲置。
   */
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DARK_MEDIA_QUERY);
    const onChange = () => setPrefersDark(mq.matches);
    // 初值补一次：`addEventListener` 只在**将来**变化时回调
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setAppearance = useCallback((next: AppearancePref) => {
    setPref(next);
    applyAppearance(next);
  }, []);

  const appearance = useMemo(() => resolveAppearance(pref, prefersDark), [pref, prefersDark]);
  const value = useMemo(
    () => ({ pref, appearance, setAppearance }),
    [pref, appearance, setAppearance],
  );
  return <AppearanceContext value={value}>{children}</AppearanceContext>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance() 只能用在 <AppearanceProvider> 之内");
  return value;
}

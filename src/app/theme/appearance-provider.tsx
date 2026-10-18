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

import type { Appearance } from "./brand";
import { applyAppearance, DEFAULT_APPEARANCE, readStoredAppearance } from "./appearance";

/**
 * 外观状态。**全站唯一的持有者**：`ConfigProvider` 的 algorithm 与侧栏底部的切换器
 * 都读它——两处各自 `useState` 就会立刻出现"切了主题但 antd 还是亮的"。
 *
 * 首帧初值固定 `DEFAULT_APPEARANCE`：SSR 与客户端第一次渲染必须逐字一致（见
 * `./appearance.ts` 的头注）。真正的偏好由 `<head>` 脚本先行落到 DOM，挂载后的
 * 那个 effect 只把 React 状态对齐过去。
 */
type AppearanceContextValue = {
  appearance: Appearance;
  setAppearance: (next: Appearance) => void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<Appearance>(DEFAULT_APPEARANCE);

  useEffect(() => {
    // 与 `<head>` 脚本的结果对齐，并顺手纠正"脚本没跑成"的情形（CSP 拦内联脚本等）
    const stored = readStoredAppearance();
    setAppearanceState(stored);
    applyAppearance(stored, { persist: false });
  }, []);

  const setAppearance = useCallback((next: Appearance) => {
    setAppearanceState(next);
    applyAppearance(next);
  }, []);

  const value = useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance]);
  return <AppearanceContext value={value}>{children}</AppearanceContext>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance() 只能用在 <AppearanceProvider> 之内");
  return value;
}

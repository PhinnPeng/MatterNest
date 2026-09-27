import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * `cn()` —— 样式三条之② 的落点（技术选型 §3.3）：
 * 覆盖组件默认样式一律走这里合并，**禁止行内 style 与 `!important`**。
 *
 * 注：shadcn CLI 的 `init` 也会生成同名文件；本仓先手写，是为了在没有 registry 网络时
 * 也能让 `components/ui/` 那层有稳定的合并入口（见 W0-2 任务 prd 的 N1 状态）。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

import { cn } from "@/app/lib/utils";

/**
 * 装配验证页（W0-2 / N1）：只用来证明 Next 16 + Tailwind v4 起得来、令牌生效。
 * **零业务数据**（禁令⑥）——不查库、不调 /api/**。
 * 真正的首页/登录页在 M2/M3 进来（master ② 的 P1 登录、P4/P7 列表等 14 页）。
 *
 * 顺带验样式三条之②：类名合并一律走 `cn()`，不写行内 style。
 */
export default function ProvisionalHome() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">MatterNest</h1>
      <p className="text-sm text-neutral-500">
        装配验证页 · Next 16 + React 19 + Tailwind v4 + 纯 shadcn
      </p>
      <p
        className={cn(
          "rounded-md border px-3 py-1 text-xs",
          "border-neutral-200 text-neutral-500",
          "border-neutral-300", // 演示 cn() 的后者覆盖语义（tailwind-merge 会吃掉前一条）
        )}
      >
        本页不得出现业务数据（禁令⑥）
      </p>
    </main>
  );
}

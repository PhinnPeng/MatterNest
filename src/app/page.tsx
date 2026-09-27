import { AppCalendar } from "@/app/components/app-calendar";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { APP_LOCALE, DATE_COMPACT_PATTERN } from "@/shared/time/zh-cn";
import { format } from "date-fns";

/**
 * 装配验证页（W0-2 / N1）：证明 Next 16 + Tailwind v4 + shadcn 六件 + 中文 locale 真能渲染。
 * **零业务数据**（禁令⑥）——不查库、不调 `/api/**`；这里的日期是写死的样本，不是业务时间。
 * 真正的首页/登录页在 M2/M3 进来（master ② 的 P1 登录、P4/P7 列表等 14 页）。
 */
export default function ProvisionalHome() {
  const sample = new Date("2026-09-27T02:00:00+08:00");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">MatterNest</h1>
        <p className="text-sm text-muted-foreground">
          装配验证页 · Next 16 + React 19 + Tailwind v4 + 纯 shadcn
        </p>
      </div>

      <Card className="w-80">
        <CardHeader>
          <CardTitle className="text-base">组件基线可用</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input placeholder="输入框（shadcn）" readOnly />
          <Button type="button">按钮（shadcn）</Button>
          <p className="text-xs text-muted-foreground">
            中文日期口径：{format(sample, DATE_COMPACT_PATTERN, { locale: APP_LOCALE })}
          </p>
        </CardContent>
      </Card>

      <AppCalendar />

      <p className="rounded-md border border-neutral-300 px-3 py-1 text-xs text-muted-foreground">
        本页不得出现业务数据（禁令⑥）
      </p>
    </main>
  );
}

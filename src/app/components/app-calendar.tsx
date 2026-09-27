"use client";

import { Calendar } from "@/app/components/ui/calendar";
import { APP_LOCALE } from "@/shared/time/zh-cn";
import { useState } from "react";

/**
 * 日历的 client 包装（W0-2 / N1 实测出来的必要结构）。
 *
 * **为什么必须有这一层**：`date-fns` 的 `Locale` 对象里带函数（`formatDistance`、`localize`、`match` …），
 * 而 `Calendar` 是 `"use client"` 件。在 Server Component 里写
 * `<Calendar locale={APP_LOCALE} />` 会在 **prerender 阶段直接失败**：
 * `Error: Functions cannot be passed directly to Client Components unless you explicitly expose it by
 * marking it with "use server"`。
 * 所以 locale 必须在 **client 侧 import**，不能由服务端当 prop 传下去。
 * M3 的日期字段（立案日、节点时间、期限）都按这个模式包，不要图省事在 server 侧传。
 */
export function AppCalendar({
  value,
  onPick,
}: {
  value?: Date;
  onPick?: (d: Date | undefined) => void;
}) {
  const [picked, setPicked] = useState<Date | undefined>(value);

  return (
    <Calendar
      locale={APP_LOCALE}
      numberOfMonths={1}
      selected={picked}
      captionLayout="dropdown"
      onSelect={(d: Date | undefined) => {
        setPicked(d);
        onPick?.(d);
      }}
    />
  );
}

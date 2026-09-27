import { cn } from "cn";
import { dateTime } from "@/app/lib/client/format";

/**
 * 到期标记（规则 3 的可视化落点：临期与逾期必须一眼扫得到）。
 *
 * 分档阈值 3/7 天来自节点提醒配置的默认档位（seed 里 `remind_days = {7,3,1}`），
 * 这里刻意**不**读那个数组：列表要的是"这条现在危不危险"的一次性判断，
 * 每行再去解析数组会让表格渲染变成 O(行×档)。真按节点提醒发消息是 P2 扫描器的事。
 *
 * 逾期用文字"逾期 N 天"而不是只把数字标红 —— 同 StatusMark 那条理由：颜色不能是唯一通道。
 */
export function DeadlineMark({
  iso,
  className,
}: {
  iso: string | null | undefined;
  className?: string;
}) {
  if (!iso) return <span className="text-muted-foreground/60">未定</span>;

  const due = new Date(iso).getTime();
  const days = Math.ceil((due - Date.now()) / 86_400_000);
  const tone =
    days < 0
      ? { dot: "bg-destructive", text: "text-destructive", label: `逾期 ${-days} 天` }
      : days <= 3
        ? { dot: "bg-amber-500", text: "text-amber-700", label: `剩 ${days} 天` }
        : days <= 7
          ? { dot: "bg-primary", text: "text-foreground", label: `剩 ${days} 天` }
          : { dot: "bg-muted-foreground/40", text: "text-muted-foreground", label: null };

  return (
    <span
      title={dateTime(iso)}
      className={cn("inline-flex items-center gap-1.5 text-sm", className)}
      data-days={days}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
      <span className={cn("num", tone.text)}>{tone.label ?? dateTime(iso)}</span>
    </span>
  );
}

import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * 空态与错误态。这两种状态在内部系统里出现频率极高（范围收窄、筛太窄、会话过期），
 * 所以规则是：**说清下一步能干什么**，而不是留一句"暂无数据"。
 * 空屏幕是邀请操作的，不是免责声明。
 */
export function StateBlock({
  title,
  hint,
  action,
  tone = "empty",
  className,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  tone?: "empty" | "error" | "denied";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center",
        tone === "error"
          ? "border-destructive/35 bg-destructive/[0.03]"
          : "border-border bg-muted/25",
        className,
      )}
    >
      <p className={cn("text-sm font-medium", tone === "error" && "text-destructive")}>{title}</p>
      {hint ? (
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

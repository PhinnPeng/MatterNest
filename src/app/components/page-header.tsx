import type { ReactNode } from "react";
import { cn } from "cn";

/**
 * 页面头：**编号/名称/状态**这类"必须出现在第一屏"的信息放这里，操作按钮靠右。
 * 详情页与列表页共用一个形状，是为了让"标题占多宽、副信息第几行"在全站只有一个答案。
 */
export function PageHeader({
  eyebrow,
  title,
  meta,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-wrap items-start justify-between gap-x-6 gap-y-3 pb-3", className)}
    >
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1 flex items-center gap-2 text-xs">{eyebrow}</div> : null}
        <h2 className="truncate text-lg leading-7 font-semibold">{title}</h2>
        {meta ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {meta}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** 顶栏下方的"键 : 值"一行（案号 / 承办人 / 立案日…）。刻意不做成两列网格：字段重要性差别很大，等宽网格会把"案由"和"币种"摆成一样的重量。 */
export function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground">{children}</dd>
    </div>
  );
}

/** 卡片小节标题（详情 Tab 内部分区用） */
export function SectionTitle({
  children,
  count,
  action,
}: {
  children: ReactNode;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 pb-1.5">
      <h3 className="flex items-baseline gap-1.5 text-sm font-medium">
        {children}
        {count !== undefined ? (
          <span className="num text-xs text-muted-foreground">{count}</span>
        ) : null}
      </h3>
      {action}
    </div>
  );
}

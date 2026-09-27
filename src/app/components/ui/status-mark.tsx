import { cn } from "cn";
import { useMeta, type HostKind } from "@/app/lib/client/api";
import type { StatusSemantics } from "@/shared/enums/status";

/**
 * 语义 → 色。放在这个组件里而不是 `@/shared/enums`：shared 只该管值域与中文，
 * 带上 Tailwind 类名会让一份"业务枚举"文件同时决定视觉，改主题时要翻库文件。
 *
 * 颜色只出现在**点**上，词永远保持中性前景色（除归档整体压暗一档）：
 * 这是"状态要能被扫读、不能靠色觉分辨"那条约束的实现处。
 */
const TONE: Record<StatusSemantics, { dot: string; text: string }> = {
  open: { dot: "bg-slate-400", text: "text-foreground" },
  in_progress: { dot: "bg-primary", text: "text-foreground" },
  closed: { dot: "bg-teal-600", text: "text-foreground" },
  archived: { dot: "bg-muted-foreground/45", text: "text-muted-foreground" },
  custom: { dot: "bg-primary/45", text: "text-foreground" },
};

/**
 * 状态标记：**点 + 词**，不给整块底色（主题三条之一）。
 *
 * 为什么词必须有：色觉障碍与内网那些灰阶打印机都会让"绿点=结案"失效，
 * 状态又是要被扫读和引用的东西（"这条已经结案了"要能在屏幕上读出来，而不是猜出来）。
 *
 * 名称与语义都从 `/api/meta` 的状态配置表来 —— 状态是配置驱动（枚举表 §0），
 * 运营改了一个 code 的中文名，这里跟着变；前端不抄第二份中文。
 */
export function StatusMark({
  host,
  code,
  className,
}: {
  host: HostKind;
  code: string | null | undefined;
  className?: string;
}) {
  const { data } = useMeta(host);
  const hit = data?.statuses.find((s) => s.code === code);
  const semantics = (hit?.semantics ?? "custom") as StatusSemantics;
  const tone = TONE[semantics] ?? TONE.custom;

  if (!code) return <span className="text-muted-foreground">—</span>;

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", tone.dot)}
        data-semantics={semantics}
      />
      <span className={cn("truncate", tone.text)}>{hit?.name ?? code}</span>
    </span>
  );
}

/**
 * 归档/已转案件这类"与状态正交的第二事实"用描边标记，不用第二个点：
 * 修订稿 §3.4 明确"已转案件不占状态位"，视觉上也不该跟状态抢同一个位置。
 */
export function FlagMark({
  children,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "info" | "warn";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-sm border px-1 py-px text-[0.68rem] leading-4 whitespace-nowrap",
        tone === "neutral" && "border-border text-muted-foreground",
        tone === "info" && "border-primary/35 bg-primary/[0.06] text-primary",
        tone === "warn" && "border-amber-500/40 bg-amber-500/[0.08] text-amber-700",
      )}
    >
      {children}
    </span>
  );
}

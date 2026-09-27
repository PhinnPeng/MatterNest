"use client";

import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";

import { useMeta } from "@/app/lib/client/api";
import { useOverview } from "@/app/lib/client/api";
import { PageHeader, SectionTitle } from "@/app/components/page-header";
import { StatusMark } from "@/app/components/ui/status-mark";
import { StateBlock } from "@/app/components/ui/state-block";
import { Skeleton } from "@/app/components/ui/skeleton";
import { Button } from "@/app/components/ui/button";
import { fromNow, dateTime } from "@/app/lib/client/format";
import { cn } from "cn";

/**
 * 工作台。开场放的是**到期压力**，不是四个大数字方块：
 * 这张页要回答的第一问是"今天有什么会过期"，所以临期清单排第一，案件总数只是背景信息。
 */
export function Workbench() {
  const { data, isPending, isError, error, refetch } = useOverview();
  const { data: meta } = useMeta("matter");
  const qc = useQueryClient();

  if (isError) {
    return (
      <StateBlock
        tone="error"
        title="工作台读数没拿到"
        hint={error instanceof Error ? error.message : "未知错误"}
        action={
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            重试
          </Button>
        }
      />
    );
  }

  const day = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader
        eyebrow={<span className="text-muted-foreground">{day}</span>}
        title="今天该动手的"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // 两个查询一起失效：只刷 overview 会留着上一个账号缓存的字典
              void qc.invalidateQueries({ queryKey: ["overview"] });
              void qc.invalidateQueries({ queryKey: ["meta"] });
            }}
          >
            <RefreshCwIcon />
            刷新
          </Button>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* 左：到期清单 */}
        <section>
          <SectionTitle count={data?.upcoming.length}>节点到期</SectionTitle>
          {isPending ? (
            <div className="space-y-1.5">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : !data?.upcoming.length ? (
            <StateBlock
              title="没有待办节点"
              hint="所有已确认时间的节点都完成了。新建节点会在案件详情页的「工作节点」里出现。"
              action={
                <Button asChild variant="outline" size="sm">
                  <Link href="/matters">去案件列表</Link>
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border/70 rounded-lg border border-border bg-card">
              {data.upcoming.map((n) => {
                const days = n.deadlineTime
                  ? Math.ceil((new Date(n.deadlineTime).getTime() - Date.now()) / 86_400_000)
                  : null;
                const overdue = days !== null && days < 0;
                const soon = days !== null && days >= 0 && days <= 3;
                return (
                  <li key={n.id}>
                    <Link
                      href={`/matters/${n.hostId}`}
                      className="flex items-baseline gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-primary/[0.04] focus-visible:bg-primary/[0.06]"
                    >
                      {/* 左侧一条色带承担"危险程度"，文字仍写完整日期：色带只是让扫读更快，不是唯一通道 */}
                      <span
                        aria-hidden
                        className={cn(
                          "h-8 w-0.5 shrink-0 self-center rounded-full",
                          overdue ? "bg-destructive" : soon ? "bg-amber-500" : "bg-transparent",
                        )}
                      />
                      <span className="w-[5.5rem] shrink-0 self-center">
                        <StatusMark host="matter" code={n.status} className="text-xs" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{n.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          <span className="num">{n.hostCode}</span> · {n.hostName}
                          {n.owner ? ` · ${n.owner}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 self-center text-right">
                        <span
                          className={cn(
                            "num block text-sm",
                            overdue
                              ? "text-destructive"
                              : soon
                                ? "text-amber-700"
                                : "text-foreground",
                          )}
                        >
                          {days === null
                            ? "未定"
                            : overdue
                              ? `逾期 ${-days} 天`
                              : days === 0
                                ? "今天"
                                : `剩 ${days} 天`}
                        </span>
                        <span className="block text-[0.68rem] text-muted-foreground">
                          {dateTime(n.deadlineTime)}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 右：计数 + 活动 */}
        <div className="space-y-5">
          <section>
            <SectionTitle>范围读数</SectionTitle>
            <dl className="divide-y divide-border/70 rounded-lg border border-border bg-card text-sm">
              <Read
                label="在办案件"
                value={data?.matters.total}
                note="未归档，含已结案"
                href="/matters"
              />
              <Read
                label="逾期节点"
                value={data?.nodes.overdue}
                tone={data?.nodes.overdue ? "bad" : undefined}
                note="已确认时间且未完成"
              />
              <Read
                label="7 日内到期"
                value={data?.nodes.within7}
                tone={data?.nodes.within7 ? "warn" : undefined}
                note="不含逾期"
              />
              <Read
                label="风险事项"
                value={data?.risks.total}
                note={data ? `其中已转案件 ${data.risks.converted} 条` : undefined}
                href="/risk-matters"
              />
            </dl>
            {meta ? (
              <StatusStrip
                statuses={meta.statuses}
                byStatus={data?.matters.byStatus ?? {}}
                total={data?.matters.total ?? 0}
              />
            ) : null}
          </section>

          <section>
            <SectionTitle count={data?.recent.length}>最近动作</SectionTitle>
            {isPending ? (
              <div className="space-y-1.5">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-9" />
                ))}
              </div>
            ) : !data?.recent.length ? (
              <StateBlock title="还没有活动记录" hint="建案、改状态、加评论都会记在这里。" />
            ) : (
              <ul className="divide-y divide-border/70 rounded-lg border border-border bg-card">
                {data.recent.map((r) => {
                  const body = (
                    <>
                      <span className="block truncate text-sm">
                        <span className="num">{r.hostCode ?? "—"}</span> · {r.actionLabel}
                      </span>
                      <span className="block truncate text-[0.68rem] text-muted-foreground">
                        {r.operator} · {fromNow(r.createdAt)}
                        {r.reason ? ` · ${r.reason}` : ""}
                      </span>
                    </>
                  );
                  return (
                    <li key={r.id} className="px-3 py-2">
                      {r.hostId ? (
                        <Link
                          href={`/${r.kind === "matter" ? "matters" : "risk-matters"}/${r.hostId}`}
                          className="block outline-none hover:bg-primary/[0.04]"
                        >
                          {body}
                        </Link>
                      ) : (
                        body
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Read({
  label,
  value,
  note,
  href,
  tone,
}: {
  label: string;
  value: number | undefined;
  note?: string;
  href?: string;
  tone?: "bad" | "warn";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-baseline gap-2">
        {note ? <span className="text-[0.68rem] text-muted-foreground">{note}</span> : null}
        {href ? (
          <Link
            href={href}
            className={cn(
              "num text-base underline-offset-4 hover:underline",
              tone === "bad" && "text-destructive",
              tone === "warn" && "text-amber-700",
            )}
          >
            {value ?? "—"}
          </Link>
        ) : (
          <span
            className={cn(
              "num text-base",
              tone === "bad" && "text-destructive",
              tone === "warn" && "text-amber-700",
            )}
          >
            {value ?? "—"}
          </span>
        )}
      </dd>
    </div>
  );
}

/**
 * 状态分布条。分段而不是饼图：一期只有四个状态，条形能直接读长短，
 * 饼图要转脖子比对角度。颜色沿用 StatusMark 那一套语义色（同一个值在两张页上不是两个颜色）。
 *
 * ⚠ 这里是全站**唯一**一处行内 `style`，因为它给的是**运行时几何**（占比来自数据库），
 * 不是外观覆盖 —— Tailwind 无法为任意百分比生成类名。样式三条② 禁的是用行内 style
 * 绕过令牌改颜色/间距；这条例外已按同一措辞写进 `spec/frontend/styling.md`，
 * 免得下一个人以为规则被悄悄放宽了。
 */
function StatusStrip({
  statuses,
  byStatus,
  total,
}: {
  statuses: { code: string; name: string; semantics: string }[];
  byStatus: Record<string, number>;
  total: number;
}) {
  const tone = (semantics: string) =>
    semantics === "closed"
      ? "bg-teal-600"
      : semantics === "in_progress"
        ? "bg-primary"
        : semantics === "archived"
          ? "bg-muted-foreground/40"
          : "bg-slate-400";

  return (
    <div className="mt-2">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        {total > 0
          ? statuses.map((s) => {
              const n = byStatus[s.code] ?? 0;
              return n ? (
                <span
                  key={s.code}
                  title={`${s.name} ${n}`}
                  className={cn(tone(s.semantics))}
                  style={{ width: `${(n / total) * 100}%` }}
                />
              ) : null;
            })
          : null}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.68rem] text-muted-foreground">
        {statuses.map((s) => (
          <li key={s.code} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-1.5 rounded-full", tone(s.semantics))} />
            {s.name}
            <span className="num">{byStatus[s.code] ?? 0}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

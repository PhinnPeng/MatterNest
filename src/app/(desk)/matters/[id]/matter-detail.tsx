"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon } from "lucide-react";

import { api, ApiFailure, useMeta, type MatterDetail as Matter } from "@/app/lib/client/api";
import { calDate, dateTime, fromNow, money } from "@/app/lib/client/format";
import { MetaItem, PageHeader, SectionTitle } from "@/app/components/page-header";
import { StatusMark, FlagMark } from "@/app/components/ui/status-mark";
import { DeadlineMark } from "@/app/components/ui/deadline-mark";
import { StatusDialog, type StatusTarget } from "@/app/components/status-dialog";
import { StateBlock } from "@/app/components/ui/state-block";
import { Skeleton } from "@/app/components/ui/skeleton";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Separator } from "@/app/components/ui/separator";
import { Textarea } from "@/app/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { nodeStatusSchema } from "@/shared/schema/hosts";
import type { NodeStatus } from "@/shared/enums/business";

/**
 * 案件详情。
 *
 * 三条实现约束：
 *   · 404 走"不可见或不存在"这一句措辞，不写"案件不存在" —— 服务层对两者都给 404
 *     （权限草案 §1 元规则 3），文案不能把这个区别说漏；
 *   · 状态、节点、评论三处写操作成功后一起失效 `["matter", id]` 与 `["matters"]`：
 *     详情页要立刻看到新状态，返回列表也要看见；
 *   · 取消节点必须填原因，这条在**服务层与 DB CHECK 各有一道**
 *     （`ck_mn_matter_node_cancel_reason`），前端只是提前提示。
 */
export function MatterDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data: meta } = useMeta("matter");
  const [statusOpen, setStatusOpen] = useState(false);

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["matter", id],
    queryFn: () => api.get<Matter>(`/api/matters/${id}`),
  });

  if (isPending) {
    return (
      <div className="mx-auto max-w-[1180px] space-y-4">
        <Skeleton className="h-16" />
        <Skeleton className="h-9 w-96" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError) {
    const denied = error instanceof ApiFailure && error.status === 404;
    return (
      <StateBlock
        tone={denied ? "denied" : "error"}
        title={denied ? "这条案件打不开" : "读取出错"}
        hint={
          denied
            ? "它要么不存在，要么不在你的数据范围内 —— 这两种情况系统给的是同一个响应，不区分。"
            : error instanceof Error
              ? error.message
              : "未知错误"
        }
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/matters">
              <ArrowLeftIcon />
              回案件列表
            </Link>
          </Button>
        }
      />
    );
  }

  const m = data;
  const level = meta?.levels.find((l) => l.code === m.level)?.name ?? m.level;
  const target: StatusTarget = { id: m.id, code: m.internalCode, name: m.name, status: m.status };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["matter", m.id] });
    qc.invalidateQueries({ queryKey: ["matters"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader
        eyebrow={
          <>
            <Link
              href="/matters"
              className="inline-flex items-center gap-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <ArrowLeftIcon className="size-3.5" />
              案件
            </Link>
            <span className="num text-foreground">{m.internalCode}</span>
            <StatusMark host="matter" code={m.status} />
            {m.isArchived ? <FlagMark tone="neutral">已归档</FlagMark> : null}
            {m.closingDate ? <FlagMark tone="info">已结案</FlagMark> : null}
          </>
        }
        title={m.name}
        meta={
          <>
            <MetaItem label="案号">
              <span className="num">{m.caseNo}</span>
            </MetaItem>
            <MetaItem label="案由">{m.cause}</MetaItem>
            <MetaItem label="程序">{meta?.enums.procedures[m.procedure] ?? m.procedure}</MetaItem>
            <MetaItem label="等级">{level}</MetaItem>
            <MetaItem label="标的额">
              <span className="num">{money(m.amount)}</span> 元
            </MetaItem>
            <MetaItem label="立案">{calDate(m.filingDate)}</MetaItem>
            <MetaItem label="更新">{fromNow(m.updatedAt)}</MetaItem>
          </>
        }
        actions={
          <Button size="sm" variant="outline" onClick={() => setStatusOpen(true)}>
            变更状态
          </Button>
        }
      />

      <Tabs defaultValue="nodes">
        <TabsList>
          <TabsTrigger value="basic">基本信息</TabsTrigger>
          <TabsTrigger value="nodes">
            工作节点
            <TabCount n={m.nodes.length} />
          </TabsTrigger>
          <TabsTrigger value="people">
            参与人
            <TabCount n={m.staff.length + m.parties.length} />
          </TabsTrigger>
          <TabsTrigger value="log">
            过程记录
            <TabCount n={m.progress.length + m.comments.length} />
          </TabsTrigger>
          <TabsTrigger value="activity">
            活动
            <TabCount n={m.activity.length} />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="basic">
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <Basic label="内部编号" value={<span className="num">{m.internalCode}</span>} />
            <Basic label="正式案号" value={<span className="num">{m.caseNo}</span>} />
            <Basic label="案件类型" value={meta?.enums.caseTypes[m.caseType] ?? m.caseType} />
            <Basic
              label="我方诉讼地位"
              value={meta?.enums.litigationRoles[m.litigationRole] ?? m.litigationRole}
            />
            <Basic label="受理法院" value={m.court ?? "—"} />
            <Basic label="币种" value={m.currency} />
            <Basic label="结案日期" value={calDate(m.closingDate)} />
            <Basic label="归档时间" value={dateTime(m.archivedAt)} />
            <Basic label="最近进展" value={dateTime(m.lastProgressAt)} />
          </dl>
          <Separator className="my-4" />
          <p className="max-w-prose text-sm leading-relaxed whitespace-pre-wrap">
            {m.description?.trim() ? m.description : "没有填写基本情况。"}
          </p>
        </TabsContent>

        <TabsContent value="nodes">
          {m.nodes.length === 0 ? (
            <StateBlock
              title="还没有工作节点"
              hint="节点是提醒的唯一入口：确认时间并设了期限，才会进工作台的到期清单。"
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>节点</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>时间</TableHead>
                    <TableHead>到期</TableHead>
                    <TableHead>负责人</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="w-40">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {m.nodes.map((n) => (
                    <NodeRow key={n.id} matterId={m.id} node={n} meta={meta} onDone={invalidate} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="people">
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <SectionTitle count={m.staff.length}>承办与协办</SectionTitle>
              <ul className="divide-y divide-border/70 rounded-lg border border-border bg-card">
                {m.staff.map((s) => (
                  <li key={s.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>{s.displayName}</span>
                    <span className="text-xs text-muted-foreground">
                      {meta?.enums.staffRoles[s.staffRole] ?? s.staffRole}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <SectionTitle count={m.parties.length}>当事人</SectionTitle>
              <ul className="divide-y divide-border/70 rounded-lg border border-border bg-card">
                {m.parties.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{p.name}</span>
                      <span className="block truncate text-[0.68rem] text-muted-foreground">
                        {meta?.enums.partyTypes[p.type] ?? p.type}
                        {p.idNumber ? ` · ${p.idNumber}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        {meta?.enums.litigationRoles[p.partyRole] ?? p.partyRole}
                      </span>
                      {p.represented ? <FlagMark tone="info">我方代理</FlagMark> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </TabsContent>

        <TabsContent value="log">
          <CommentComposer matterId={m.id} onDone={invalidate} />
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <section>
              <SectionTitle count={m.progress.length}>案件进展</SectionTitle>
              {m.progress.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">这条链路上还没有进展记录。</p>
              ) : (
                <ul className="space-y-2">
                  {m.progress.map((p) => (
                    <li key={p.id} className="rounded-lg border border-border bg-card px-3 py-2">
                      <p className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                        <span>{meta?.enums.progressTypes[p.progressType] ?? p.progressType}</span>
                        <span className="num">{calDate(p.progressDate)}</span>
                      </p>
                      <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap">
                        {p.content}
                      </p>
                      {p.nextPlan ? (
                        <p className="mt-1 text-xs text-muted-foreground">下一步：{p.nextPlan}</p>
                      ) : null}
                      <p className="mt-1 text-[0.68rem] text-muted-foreground">{p.author}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <SectionTitle count={m.comments.length}>评论</SectionTitle>
              {m.comments.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">还没有评论。</p>
              ) : (
                <ul className="space-y-2">
                  {m.comments.map((c) => (
                    <li key={c.id} className="rounded-lg border border-border bg-card px-3 py-2">
                      <p className="flex items-baseline justify-between gap-2 text-[0.68rem] text-muted-foreground">
                        <span>{c.author}</span>
                        <span>{fromNow(c.createdAt)}</span>
                      </p>
                      <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap">{c.body}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </TabsContent>

        <TabsContent value="activity">
          <ul className="divide-y divide-border/70 rounded-lg border border-border bg-card">
            {m.activity.map((a) => (
              <li key={a.id} className="flex items-baseline gap-3 px-3 py-2 text-sm">
                <span className="w-40 shrink-0 text-[0.68rem] text-muted-foreground">
                  {dateTime(a.createdAt)}
                </span>
                <span className="w-24 shrink-0 truncate text-xs">
                  {meta?.enums.auditActions[a.action] ?? a.action}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {a.operator}
                  {a.reason ? <span className="text-muted-foreground"> · {a.reason}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>

      <StatusDialog
        target={target}
        statuses={meta?.statuses ?? m.statuses}
        open={statusOpen}
        onOpenChange={setStatusOpen}
      />
    </div>
  );
}

function TabCount({ n }: { n: number }) {
  return <span className="num text-[0.7rem] text-muted-foreground">{n}</span>;
}

function Basic({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

/** 单行节点：状态动作就地做，不跳页 —— 节点是详情页最高频的操作。 */
function NodeRow({
  matterId,
  node,
  meta,
  onDone,
}: {
  matterId: string;
  node: Matter["nodes"][number];
  meta: ReturnType<typeof useMeta>["data"];
  onDone: () => void;
}) {
  const [reason, setReason] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: (body: { status: NodeStatus; cancelReason?: string }) =>
      api.post(`/api/matters/${matterId}/nodes/${node.id}`, body),
    onSuccess: onDone,
  });

  const label = (s: string) => meta?.enums.nodeStatuses[s] ?? s;
  const open = node.status === "not_started" || node.status === "in_progress";

  return (
    <TableRow>
      <TableCell>
        <span className="block">{node.name}</span>
        {node.remark ? (
          <span className="block text-[0.68rem] text-muted-foreground">{node.remark}</span>
        ) : null}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{node.nodeType}</TableCell>
      <TableCell className="num text-xs">
        {node.isTimeConfirmed ? (
          node.timeType === "range" ? (
            <>
              {dateTime(node.startTime)}
              <span className="text-muted-foreground"> → </span>
              {dateTime(node.endTime)}
            </>
          ) : (
            dateTime(node.startTime)
          )
        ) : (
          <span className="text-muted-foreground">时间未确认</span>
        )}
      </TableCell>
      <TableCell>
        {open ? (
          <DeadlineMark iso={node.deadlineTime} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-xs">{node.ownerName ?? "—"}</TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <span
            className={
              node.status === "completed"
                ? "text-teal-700"
                : node.status === "cancelled"
                  ? "text-muted-foreground line-through"
                  : ""
            }
          >
            {label(node.status)}
          </span>
          {node.sourceKind !== "manual" ? (
            <FlagMark title={`来源：${node.sourceKind}`}>{node.sourceKind}</FlagMark>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        {reason !== null ? (
          <div className="flex items-center gap-1.5">
            <Input
              autoFocus
              value={reason ?? ""}
              onChange={(e) => setReason(e.target.value)}
              placeholder="取消原因（必填）"
              aria-label="取消原因"
              className="h-7"
            />
            <Button
              size="xs"
              disabled={!reason?.trim() || mut.isPending}
              onClick={() => {
                const parsed = nodeStatusSchema.safeParse({
                  status: "cancelled",
                  cancelReason: reason,
                });
                if (!parsed.success) return;
                mut.mutate({ status: "cancelled", cancelReason: reason?.trim() });
                setReason(null);
              }}
            >
              确认
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setReason(null)}>
              否
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {node.status === "not_started" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={mut.isPending}
                onClick={() => mut.mutate({ status: "in_progress" })}
              >
                开始
              </Button>
            ) : null}
            {open ? (
              <Button
                size="xs"
                disabled={mut.isPending}
                onClick={() => mut.mutate({ status: "completed" })}
              >
                完成
              </Button>
            ) : null}
            {node.status !== "cancelled" ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setReason("")}
              >
                取消
              </Button>
            ) : null}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function CommentComposer({ matterId, onDone }: { matterId: string; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => api.post(`/api/matters/${matterId}/comments`, { body: body.trim() }),
    onSuccess: () => {
      setBody("");
      setError(null);
      onDone();
    },
    onError: (e) => setError(e instanceof ApiFailure ? e.message : "提交失败"),
  });

  return (
    <div className="grid gap-1.5">
      <Label htmlFor="comment-body">写一条评论</Label>
      <Textarea
        id="comment-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="记录一个结论、一次沟通，或一个待确认的点"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={body.trim().length === 0 || mut.isPending}
          onClick={() => mut.mutate()}
        >
          {mut.isPending ? "提交中" : "发布"}
        </Button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useMeta } from "@/app/lib/client/api";
import { PageHeader, SectionTitle } from "@/app/components/page-header";
import { StateBlock } from "@/app/components/ui/state-block";
import { Skeleton } from "@/app/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { FlagMark } from "@/app/components/ui/status-mark";

/**
 * 配置字典（**只读**）。
 *
 * 这张页存在的理由是 W0-3 那条裁定要能被看见：值域分两类——
 *   · 配置驱动（状态、风险等级、标签）→ 存在库里，运营可改，所以两张宿主各自一份；
 *   · 闭集枚举（案件类型、审级、诉讼地位、节点状态…）→ 写在 `@/shared/enums`，
 *     与迁移里的 `CHECK` 由 `enum-check.spec.ts` 双向核对。
 * 把它们并排列出来，"为什么这个能改那个不能改"就不用口头解释了。
 *
 * 一期不做配置编辑界面（`can_manage_config` 那条权限先只用于读），
 * 所以这里明确写"只读"而不是放一堆禁用按钮。
 */
export function ConfigView() {
  const matter = useMeta("matter");
  const risk = useMeta("risk_matter");
  const pending = matter.isPending || risk.isPending;

  if (pending) {
    return (
      <div className="mx-auto max-w-[1180px] space-y-3">
        <Skeleton className="h-9 w-52" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (matter.isError || risk.isError) {
    return <StateBlock tone="error" title="配置读不到" hint="会话可能已过期，重新登录后再看。" />;
  }

  const m = matter.data!;
  const r = risk.data!;

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader
        title="配置字典"
        meta={
          <>
            <span>只读。左侧菜单里看不到编辑入口是因为一期没做写接口，不是权限问题。</span>
            <Link href="/matters" className="text-primary underline-offset-4 hover:underline">
              回案件
            </Link>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <SectionTitle count={m.statuses.length}>案件状态</SectionTitle>
          <StatusTable rows={m.statuses} tags={m.tags} />
        </section>
        <section>
          <SectionTitle count={r.statuses.length}>事项状态</SectionTitle>
          <StatusTable rows={r.statuses} tags={r.tags} />
        </section>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section>
          <SectionTitle count={m.levels.length}>风险等级（两宿主共用一张表）</SectionTitle>
          <DenseTable
            head={["code", "名称"]}
            rows={m.levels.map((l) => [l.code, l.name])}
            mono={[true, false]}
          />
        </section>
        <section>
          <SectionTitle>闭集枚举（改动要走迁移，不在这里改）</SectionTitle>
          <div className="space-y-3">
            <EnumBlock title="案件类型" map={m.enums.caseTypes} />
            <EnumBlock title="审级 / 程序" map={m.enums.procedures} />
            <EnumBlock title="诉讼地位" map={m.enums.litigationRoles} />
            <EnumBlock title="当事人类型" map={m.enums.partyTypes} />
            <EnumBlock title="节点状态" map={m.enums.nodeStatuses} />
            <EnumBlock title="事项类型" map={r.enums.riskTypes} />
          </div>
        </section>
      </div>
    </div>
  );
}

function StatusTable({
  rows,
  tags,
}: {
  rows: { code: string; name: string; semantics: string }[];
  tags: { id: string; name: string }[];
}) {
  return (
    <div className="grid gap-4">
      <DenseTable
        head={["code", "名称", "语义（决定系统行为）"]}
        rows={rows.map((s) => [s.code, s.name, s.semantics])}
        mono={[true, false, true]}
      />
      {tags.length ? (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">
            标签 · <span className="num">{tags.length}</span>
          </p>
          <p className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <FlagMark key={t.id} tone="neutral">
                {t.name}
              </FlagMark>
            ))}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function DenseTable({
  head,
  rows,
  mono,
}: {
  head: string[];
  rows: (string | number)[][];
  mono?: boolean[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            {head.map((h) => (
              <TableHead key={h}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((cells, i) => (
            <TableRow key={i}>
              {cells.map((c, j) => (
                <TableCell key={j} className={mono?.[j] ? "num" : undefined}>
                  {c}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function EnumBlock({ title, map }: { title: string; map: Record<string, string> }) {
  const entries = Object.entries(map);
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">
        {title} · <span className="num">{entries.length}</span>
      </p>
      <p className="flex flex-wrap gap-1.5">
        {entries.map(([code, label]) => (
          <FlagMark key={code} title={code} tone="neutral">
            {label}
          </FlagMark>
        ))}
      </p>
    </div>
  );
}

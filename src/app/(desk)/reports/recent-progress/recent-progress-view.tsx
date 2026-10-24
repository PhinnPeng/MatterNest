"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { App as AntdApp, Button, Segmented, Space } from "antd";
import type { TableColumnsType } from "antd";
import { DownloadOutlined } from "@ant-design/icons";

import { api, ApiFailure, downloadCsv } from "@/app/lib/client/api";
import { fromNow } from "@/app/lib/client/format";
import {
  recentProgressExportPath,
  useRecentProgress,
  type RecentProgressExport,
} from "@/app/lib/client/api-reports";
import { DataTable } from "@/app/components/ui/data-table/DataTable";
import { StateBlock } from "@/app/components/ui/state-block";
import { hostBase } from "@/shared/hosts";
import { DEFAULT_PAGE_SIZE } from "@/shared/schema/list-query";
import { businessDateKey } from "@/shared/time/zh-cn";
import type {
  RecentProgressDays,
  RecentProgressItem,
  RecentProgressScope,
} from "@/shared/schema/reports";

/**
 * 报表 · 最近进展（2026-10-24 用户裁定）。
 *
 * 主从两栏：左列「最近案件 / 最近事项」，右侧是该范围下的最近进展表。
 * 口径：`last_progress_at` 倒序、滚动时间窗（7/30/90/全部，默认 30）、每行取最新一条进展。
 * 状态全部落在 URL 上：scope / days / page 可刷新、可转发。
 */
const SCOPES: { value: RecentProgressScope; label: string }[] = [
  { value: "matter", label: "最近案件" },
  { value: "risk_matter", label: "最近事项" },
];

const DAYS: { value: RecentProgressDays; label: string }[] = [
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
  { value: "all", label: "全部" },
];

const PAGE_SIZE = DEFAULT_PAGE_SIZE;

function scopeOf(raw: string | null): RecentProgressScope {
  return raw === "risk_matter" ? "risk_matter" : "matter";
}

function daysOf(raw: string | null): RecentProgressDays {
  return raw === "7" || raw === "90" || raw === "all" ? raw : "30";
}

export function RecentProgressView() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { message } = AntdApp.useApp();

  const scope = scopeOf(sp.get("scope"));
  const days = daysOf(sp.get("days"));
  const page = Math.max(1, Number(sp.get("page") ?? 1) || 1);

  /** 切 scope / days 时回到第 1 页；翻页只改 page。 */
  const go = (patch: { scope?: RecentProgressScope; days?: RecentProgressDays; page?: number }) => {
    const qs = new URLSearchParams(sp.toString());
    if (patch.scope) qs.set("scope", patch.scope);
    if (patch.days) qs.set("days", patch.days);
    if (patch.scope || patch.days) qs.delete("page");
    if (patch.page) qs.set("page", String(patch.page));
    const suffix = qs.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  };

  const q = useRecentProgress({ scope, days, page, pageSize: PAGE_SIZE });
  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  /** 翻页越界（比如手改 URL 到第 9 页）：说“这一页没有”，不要讲成“这段时间没有进展”。 */
  const outOfRange = total > 0 && (page - 1) * PAGE_SIZE >= total;

  const exportMut = useMutation({
    mutationFn: () => api.get<RecentProgressExport>(recentProgressExportPath(scope, days)),
    onSuccess: (r) => {
      const stamp = businessDateKey(new Date());
      const name = scope === "matter" ? "最近案件" : "最近事项";
      downloadCsv(`${name}-最近进展-${stamp}.csv`, r.csv);
      message.success(
        `已导出 ${r.rows} 行${r.truncated ? "；命中超过上限，只导出了前 1000 行" : ""}`,
      );
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "导出失败"),
  });

  if (q.isError) {
    return (
      <StateBlock
        tone="error"
        title="报表没加载出来"
        hint="刷新页面或稍后再试。"
        action={
          <Button size="small" onClick={() => void q.refetch()}>
            重试
          </Button>
        }
      />
    );
  }

  const codeLabel = scope === "matter" ? "案号" : "编号";

  const columns: TableColumnsType<RecentProgressItem> = [
    {
      title: codeLabel,
      dataIndex: "code",
      width: 160,
      ellipsis: true,
      render: (_: unknown, r) => (
        <Link href={`/${hostBase(scope)}/${r.hostId}`} className="num">
          {r.code}
        </Link>
      ),
    },
    { title: "名称", dataIndex: "name", width: 240, ellipsis: true },
    {
      title: "进展",
      dataIndex: "content",
      render: (_: unknown, r) => (
        <div
          style={{
            fontSize: 13,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {r.content || "—"}
        </div>
      ),
    },
    { title: "类型", dataIndex: "progressLabel", width: 96, ellipsis: true },
    {
      title: "时间",
      dataIndex: "progressAt",
      width: 110,
      ellipsis: true,
      render: (_: unknown, r) => (
        <span className="mut3 num" style={{ fontSize: 12 }}>
          {fromNow(r.progressAt)}
        </span>
      ),
    },
    {
      title: "经办人",
      dataIndex: "owner",
      width: 110,
      ellipsis: true,
      render: (_: unknown, r) => r.owner ?? "—",
    },
  ];

  return (
    <div className="master">
      <div className="card">
        <div className="card-h">
          <h2>报表</h2>
        </div>
        <div className="card-b" style={{ padding: 10 }}>
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              className={scope === s.value ? "pick on" : "pick"}
              aria-current={scope === s.value ? "true" : undefined}
              onClick={() => go({ scope: s.value })}
            >
              <span className="t">
                <b>{s.label}</b>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="pane">
          <DataTable<RecentProgressItem>
            title={scope === "matter" ? "最近案件" : "最近事项"}
            columns={columns}
            rows={items}
            rowKey={(r) => r.hostId}
            total={total}
            page={page}
            pageSize={PAGE_SIZE}
            loading={q.isFetching}
            onPageChange={(p) => go({ page: p })}
            /* 排序固定为最近进展倒序；表头不给排序开关，避免"点了没反应" */
            onSortChange={() => undefined}
            onRowOpen={(r) => router.push(`/${hostBase(scope)}/${r.hostId}`)}
            tools={
              <Space size={8}>
                <Segmented<RecentProgressDays>
                  size="small"
                  options={DAYS}
                  value={days}
                  onChange={(v) => go({ days: v })}
                />
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  disabled={!total || exportMut.isPending}
                  onClick={() => exportMut.mutate()}
                >
                  导出
                </Button>
              </Space>
            }
            empty={
              q.isPending ? null : (
                <StateBlock
                  title={
                    outOfRange
                      ? "这一页没有数据"
                      : days === "all"
                        ? "还没有进展记录"
                        : `最近 ${days} 天没有进展`
                  }
                  hint={
                    outOfRange || days === "all"
                      ? undefined
                      : "在案件或事项详情的「进展」里记一条，就会出现在这里。"
                  }
                  action={
                    outOfRange ? (
                      <Button size="small" onClick={() => go({ page: 1 })}>
                        回到第一页
                      </Button>
                    ) : days === "all" ? undefined : (
                      <Button size="small" onClick={() => go({ days: "all" })}>
                        看全部
                      </Button>
                    )
                  }
                />
              )
            }
          />
        </div>
      </div>
    </div>
  );
}

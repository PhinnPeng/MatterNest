"use client";

import { Button, Card, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { api, type FavoriteRow } from "@/app/lib/client/api";
import { dateTime } from "@/app/lib/client/format";
import { StateBlock } from "@/app/components/ui/state-block";
import { PageHeader } from "@/app/components/page-header";

/**
 * 我关注的（F1-13）。
 *
 * ⚠ 界面词是「关注」，而 `WATCH_TYPE_LABELS.favorite` 的中文仍是「收藏」——勘误第 7 条
 * 本票不动字典（它同时被通知与筛选消费，面更大），所以这一页的可见文案与字典**刻意不一致**。
 *
 * ## 为什么类型与编号是两列
 *
 * 案件与事项**形态不同**（案件有案号、事项有事项编号），合并成一列会让两类行看起来
 * 是同一种东西 —— 而「事项 → 案件」在本系统里是一道真实边界（GLOSSARY 的词条）。
 * 所以「类型」标签 + 编号 + 名称三列，一眼能看出这条是哪种。
 *
 * ## 为什么没有分页、没有筛选
 *
 * 关注是**用户主动建立**的集合，规模由用户自己的行为决定。加分页等于承认它会大到
 * 需要翻页，而那时该先问「为什么会关注这么多」。服务端也因此不分页
 * （见 `api/watch/route.ts` 的注释）。
 */
export function FavoritesView() {
  const router = useRouter();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["watch", "favorites"],
    queryFn: () => api.get<{ favorites: FavoriteRow[] }>("/api/watch"),
  });

  const columns: TableColumnsType<FavoriteRow> = [
    {
      key: "targetType",
      title: "类型",
      width: 80,
      render: (_v, r) => (
        <Tag style={{ marginInlineEnd: 0 }}>{r.targetType === "matter" ? "案件" : "事项"}</Tag>
      ),
    },
    {
      key: "subtitle",
      title: "编号",
      width: 170,
      render: (_v, r) => <span style={{ fontSize: 13 }}>{r.subtitle || "—"}</span>,
    },
    {
      key: "title",
      title: "名称",
      dataIndex: "title",
      ellipsis: true,
      render: (name: string, r) => (
        <Space size={6}>
          <Typography.Link
            onClick={() =>
              router.push(
                r.targetType === "matter"
                  ? `/matters/${r.targetId}`
                  : `/risk-matters/${r.targetId}`,
              )
            }
          >
            {name}
          </Typography.Link>
          {/* 归档如实标出：关注是"我还想看这条"，归档恰恰是"它结束了、我可能还要回看"——
              所以归档行**保留**，只是要让人一眼看出它的状态。 */}
          {r.isArchived ? <Tag color="default">已归档</Tag> : null}
        </Space>
      ),
    },
    {
      key: "createdAt",
      title: "关注于",
      width: 170,
      render: (_v, r) => <span style={{ fontSize: 12 }}>{dateTime(r.createdAt)}</span>,
    },
  ];

  const favorites = data?.favorites ?? [];

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      {/*
        页标题走共享的 `PageHeader`（`.pagehead` + `h2`），与其余页同形。

        换掉 antd `Typography.Title level={4}` 的理由不是审美：那一档渲出的是 `<h4>`，
        而本页唯一的 `h1` 在顶栏（`app-shell.tsx`），于是标题层级是 h1 → h4 —— 跳了两级。
        读屏按标题跳转时会听不出页面结构（US 7）。`PageHeader` 的 `h2` 正好补上中间那级。

        ⚠ 原来标题右侧还有一句「只有你自己看得见」，已删。它是**旁白**：
        念出来听，读者会问"这不是一眼就看出来吗"——标题就写着「我关注的」。
        私密语义不是靠一句标语守的：它由服务端保证（`api/watch` 只回当前用户的收藏），
        并在 `favorite-button.tsx` 的文件头记着口径。页面头没有第二行插槽（刻意的，
        见 `page-header.tsx` 的头注），这句落不进四种允许的落点。
      */}
      <PageHeader title="我关注的" />

      {isError ? (
        <StateBlock
          tone="error"
          title="关注读取出错"
          hint={error instanceof Error ? error.message : undefined}
          action={
            <Button size="small" onClick={() => void refetch()}>
              重试
            </Button>
          }
        />
      ) : isPending ? (
        <Card size="small" loading />
      ) : favorites.length === 0 ? (
        <StateBlock title="还没有关注" hint="在案件或事项详情页点右上角的 ⭐，就会出现在这里。" />
      ) : (
        <Card size="small">
          <Table<FavoriteRow>
            size="small"
            rowKey={(r) => `${r.targetType}-${r.targetId}`}
            columns={columns}
            dataSource={favorites}
            pagination={false}
          />
        </Card>
      )}
    </div>
  );
}

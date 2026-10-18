"use client";

import { useMutation } from "@tanstack/react-query";
import { App as AntdApp, Button, Card, Table, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { ReloadOutlined } from "@ant-design/icons";

import { PageHeader } from "@/app/components/page-header";
import { StateBlock } from "@/app/components/ui/state-block";
import { INK, BRAND } from "@/app/theme/brand";
import { ApiFailure, downloadCsv } from "@/app/lib/client/api";
import { fetchReport, useImportBatches } from "@/app/lib/client/api-import";
import { importKindLabel, isImportDenied, type ImportBatchDto } from "@/app/lib/client/import-ui";

/**
 * 批量导入 · 报告找回（MATT-102 降级后）。
 *
 * ## 这一页现在只说一件事：**最近导入 + 报告在哪里**
 *
 * 导入的入口已经搬到案件页 / 事项页的页头按钮（弹层形式，类型由入口页锁定）。
 * 这一页保留下来只为一件事：用户**关掉弹层之后**，错误报告还得有个地址能回来拿
 * （票面原文：「报告得有个地址能回来拿」）。所以这里只有「最近导入」一张卡，
 * 没有类型选择器、没有上传区、没有变体选择器 —— 那些都是弹层里的形态，页上再来一份
 * 只会让人怀疑哪个才是真的入口。
 *
 * ## 权限：不镜像 `canImport`
 *
 * 能否导入由服务端每个端点各自判定（`guards.ts#canImport` → 403 `import_forbidden`）。
 * 前端**不写第二份谓词**：客户端的 `Actor` 里根本没有 `isAdmin`，镜像出来的判定会漂。
 * 所以这一页靠**一次真读**换权限面 —— 挂载时拉「最近导入」，非 L1 会当场拿到 403，
 * 页面直接画成明确拒绝，而不是让用户点一次才知道。这不是额外请求：最近导入本来就是
 * 这一页仅剩的内容。
 */
export function ImportView() {
  const { message } = AntdApp.useApp();
  const batches = useImportBatches();
  const denied = batches.isError && isImportDenied(batches.error);

  const downloadReport = useMutation({
    mutationFn: (ref: string) => fetchReport(ref),
    onSuccess: (r) => downloadCsv(r.fileName, r.csv),
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "报告下载失败"),
  });

  if (denied) {
    return (
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <PageHeader title="批量导入" />
        <StateBlock
          tone="denied"
          title="批量导入只对持有全局数据范围的角色开放"
          hint="当前角色不具备。需要的话请系统所有者授予「全局管理 / 全局经办」这类全局范围的角色。"
        />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <PageHeader title="批量导入" />
      <BatchesCard
        items={batches.data?.items ?? []}
        loading={batches.isPending}
        onReport={(r) => downloadReport.mutate(r)}
        onRetry={() => void batches.refetch()}
      />
    </div>
  );
}

/** 最近导入（报告的找回路径） */
function BatchesCard({
  items,
  loading,
  onReport,
  onRetry,
}: {
  items: ImportBatchDto[];
  loading: boolean;
  onReport: (reportRef: string) => void;
  onRetry: () => void;
}) {
  const cols: TableColumnsType<ImportBatchDto> = [
    {
      key: "createdAt",
      title: "时间",
      dataIndex: "createdAt",
      width: 170,
      ellipsis: true,
      render: (v: string) => <span className="num">{v.slice(0, 16).replace("T", " ")}</span>,
    },
    {
      key: "hostType",
      title: "类型",
      dataIndex: "hostType",
      width: 100,
      ellipsis: true,
      render: (v: ImportBatchDto["hostType"]) => importKindLabel(v),
    },
    { key: "fileName", title: "文件", dataIndex: "fileName", ellipsis: true },
    {
      key: "counts",
      title: "已导入 / 未导入",
      width: 150,
      ellipsis: true,
      render: (_v, r) => (
        <span>
          <span className="num" style={{ color: BRAND.success }}>
            {r.importedRows}
          </span>
          <span style={{ color: INK.muted }}> / </span>
          <span className="num" style={{ color: BRAND.overdue }}>
            {r.errorRows}
          </span>
        </span>
      ),
    },
    {
      key: "report",
      title: "报告",
      width: 120,
      render: (_v, r) => (
        <Button size="small" onClick={() => onReport(r.reportRef)}>
          下载报告
        </Button>
      ),
    },
  ];

  return (
    <Card
      size="small"
      variant="outlined"
      title={<span style={{ fontSize: 13 }}>最近导入</span>}
      extra={<Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={onRetry} />}
    >
      <Table<ImportBatchDto>
        size="small"
        rowKey={(r) => r.id}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: 940 }}
        loading={loading}
        dataSource={items}
        columns={cols}
        locale={{
          emptyText: (
            <Typography.Text style={{ fontSize: 12 }}>
              还没有导入过。入口在案件页 / 事项页的页头「批量导入」按钮。
            </Typography.Text>
          ),
        }}
      />
    </Card>
  );
}

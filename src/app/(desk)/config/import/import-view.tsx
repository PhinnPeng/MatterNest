"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { App as AntdApp, Button, Card, Table, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { ReloadOutlined } from "@ant-design/icons";

import { ImportDialog } from "@/app/components/import-dialog";
import { PageHeader } from "@/app/components/page-header";
import { StateBlock } from "@/app/components/ui/state-block";
import { INK, BRAND } from "@/app/theme/brand";
import { ApiFailure, downloadCsv } from "@/app/lib/client/api";
import { fetchReport, useImportBatches } from "@/app/lib/client/api-import";
import { importKindLabel, isImportDenied, type ImportBatchDto } from "@/app/lib/client/import-ui";

/**
 * 批量导入 · 当事人入口 + 报告找回（MATT-102 降级后）。
 *
 * ## 这一页现在管两件事：**当事人的导入 + 最近导入与报告在哪里**
 *
 * 案件 / 风险事项的导入入口搬到了各自页头的弹层按钮（类型由入口页锁定）。但
 * **当事人（`party`）没有宿主页**（`mn_party` 是跨宿主共享实体，F3-1），也就没有
 * 哪一页能替它挂那个按钮；`/parties` 刻意不放导入按钮（原有设计）。MATT-102 的
 * 降级把 `TemplateBlock` / `UploadBlock` 整块删掉时，连带把当事人模板与上传也
 * 一起弄成了不可达 —— 三张模板里少一张，违反了 user story 36「三张模板在弹层里可下载」。
 *
 * 所以这里补回当事人那一个入口：页头一个按钮开 `ImportDialog`，`hostType="party"`。
 * 弹层自己会渲染它所锁 `hostType` 的模板下载，所以「怎么填」与「能不能导」在这一处
 * 同时有了答案，不需要在页上再铺一份上传区（那会让人怀疑哪个才是真入口）。
 *
 * ## 权限：不镜像 `canImport`
 *
 * 能否导入由服务端每个端点各自判定（`guards.ts#canImport` → 403 `import_forbidden`）。
 * 前端**不写第二份谓词**：客户端的 `Actor` 里根本没有 `isAdmin`，镜像出来的判定会漂。
 * 所以这一页靠**一次真读**换权限面 —— 挂载时拉「最近导入」，非 L1 会当场拿到 403，
 * 页面直接画成明确拒绝，而不是让用户点一次才知道。当事人入口按钮与最近导入同屏，
 * 拒绝态下整页换成 `StateBlock`，按钮不会出现。
 */
export function ImportView() {
  const { message } = AntdApp.useApp();
  const [importingParty, setImportingParty] = useState(false);
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
      <PageHeader
        title="批量导入"
        actions={
          <button type="button" className="btn pri sm" onClick={() => setImportingParty(true)}>
            导入当事人
          </button>
        }
      />
      <BatchesCard
        items={batches.data?.items ?? []}
        loading={batches.isPending}
        onReport={(r) => downloadReport.mutate(r)}
        onRetry={() => void batches.refetch()}
      />
      {/* 当事人是唯一没有宿主页的种类，它的入口只能落在这里（见文件头） */}
      <ImportDialog hostType="party" open={importingParty} onOpenChange={setImportingParty} />
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
              还没有导入过。案件 / 事项的入口在各自页头，当事人在本页页头。
            </Typography.Text>
          ),
        }}
      />
    </Card>
  );
}

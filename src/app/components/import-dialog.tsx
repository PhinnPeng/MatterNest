"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import {
  Alert,
  App as AntdApp,
  Button,
  Flex,
  Modal,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import { DownloadOutlined, UploadOutlined } from "@ant-design/icons";

import { StateBlock } from "@/app/components/ui/state-block";
import { INK, BRAND } from "@/app/theme/brand";
import { ApiFailure, downloadCsv } from "@/app/lib/client/api";
import { fetchTemplate, runImport } from "@/app/lib/client/api-import";
import {
  buildImportPayload,
  checkImportPayload,
  fileSizeLabel,
  importCounts,
  importKindLabel,
  importPayloadError,
  type ImportIssueDto,
  type ImportSummaryDto,
} from "@/app/lib/client/import-ui";
import type { ImportKind } from "@/shared/enums/import";
import { MAX_IMPORT_ROWS } from "@/shared/schema/import";

/**
 * 批量导入弹层（P14 / MATT-102）。
 *
 * ## 入口与类型都由**入口页**决定，弹层里不给类型选择器
 *
 * 案件页 → `matter`，事项页 → `risk_matter`（票面原文：类型由入口页锁定）。
 * 所以这里只有 `hostType` 一个必填 prop，没有下拉 —— 用户是在"案件"里点的导入，
 * 再让他选一次"要导什么"是把入口给的信息又收回去。
 *
 * ## 预检（dryRun）与真导共用一段渲染
 *
 * 预检和真导都是同一个 `POST /api/import`，响应是同样形状的 `ImportSummary`
 * （服务端实现保证"同一实现跑两次"，见 `services/import.ts`）。所以这里
 * `preview` 与 `result` 两个状态用的是**同一个 `SummaryPanel`** —— 三个数（共 X / 将导入 Y /
 * 有问题 Z）在预检和结果里都同屏，这是 P14 的核心信息，也是"预检查了等于真导也这样"的读法。
 *
 * ## 为什么先预检、后真导是两个按钮而不是一步
 *
 * 一次导入 1000 行约一分半，且**会真的写库**。让用户先看到"哪些行有问题、最后会进多少行"，
 * 再决定导不导 —— 预检存在的全部意义就是这个。所以主按钮是「开始导入」，
 * 旁边是「预检」；预检完之后不自动真导。
 */
export function ImportDialog({
  hostType,
  open,
  onOpenChange,
}: {
  /** 由入口页锁定，弹层里不可改 */
  hostType: ImportKind;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { message } = AntdApp.useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; size: number; text: string } | null>(null);
  /** 预检结果（dryRun）。真导成功后清掉 —— 否则同屏会有两份"将导入 Y"，读者不知道信哪个 */
  const [preview, setPreview] = useState<ImportSummaryDto | null>(null);
  /** 真导结果 */
  const [result, setResult] = useState<ImportSummaryDto | null>(null);
  /** 文件级拒绝（400）：表头不认识 / 编码不是 UTF-8 / 行数超上限。整份退回，没有逐行结果 */
  const [fileError, setFileError] = useState<string | null>(null);

  const label = importKindLabel(hostType);

  const downloadTemplate = useMutation({
    mutationFn: () => fetchTemplate(hostType),
    onSuccess: (r) => downloadCsv(r.fileName, r.csv),
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "模板下载失败"),
  });

  function resetAll() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setFileError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  /** 提交前先过**同一份** schema（不是第二套规则）。预检与真导走同一段组装 */
  function submitWith(dryRun: boolean) {
    if (!file) return;
    const checked = checkImportPayload(buildImportPayload(hostType, file.name, file.text));
    if (!checked.ok) {
      setFileError(importPayloadError(checked.issues));
      return;
    }
    return { dryRun, payload: checked.data };
  }

  const previewMut = useMutation({
    mutationFn: () => {
      const req = submitWith(true);
      if (!req) throw new Error("skipped");
      return runImport(req.payload, { dryRun: true });
    },
    onSuccess: (r) => {
      setFileError(null);
      setResult(null);
      setPreview(r);
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "skipped") return;
      setPreview(null);
      setFileError(e instanceof ApiFailure ? e.message : "预检失败，请重试");
    },
  });

  const importMut = useMutation({
    mutationFn: () => {
      const req = submitWith(false);
      if (!req) throw new Error("skipped");
      return runImport(req.payload);
    },
    onSuccess: (r) => {
      setFileError(null);
      setPreview(null);
      setResult(r);
      message.success(
        r.replayed ? "这份文件之前导过，本次一行都没有新增" : `已导入 ${r.importedRows} 行`,
      );
    },
    onError: (e) => {
      if (e instanceof Error && e.message === "skipped") return;
      setResult(null);
      // 400 是**文件级**拒绝（整份退回）；403 由入口按钮的权限面接管
      setFileError(e instanceof ApiFailure ? e.message : "导入失败，请重试");
    },
  });

  function pickFile(f: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setFile({ name: f.name, size: f.size, text: String(reader.result ?? "") });
      setPreview(null);
      setResult(null);
      setFileError(null);
    };
    reader.onerror = () => message.error("文件读不出来，请换一份");
    reader.readAsText(f);
  }

  const busy = previewMut.isPending || importMut.isPending;
  const summary = result ?? preview;

  return (
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      title={`批量导入${label}`}
      width={780}
      footer={
        <Space>
          <Button onClick={() => onOpenChange(false)}>关闭</Button>
          <Button
            disabled={!file || busy}
            loading={previewMut.isPending}
            onClick={() => previewMut.mutate()}
          >
            预检
          </Button>
          <Button
            type="primary"
            disabled={!file || busy}
            loading={importMut.isPending}
            onClick={() => importMut.mutate()}
          >
            开始导入
          </Button>
        </Space>
      }
    >
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Button
          icon={<DownloadOutlined />}
          loading={downloadTemplate.isPending}
          onClick={() => downloadTemplate.mutate()}
        >
          下载{label}模板（CSV）
        </Button>
        <Tag>.csv · UTF-8</Tag>
      </Flex>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) pickFile(f);
        }}
      />

      {file ? (
        <Flex align="center" gap={12} wrap>
          <Typography.Text strong ellipsis style={{ minWidth: 0, flex: "1 1 240px" }}>
            {file.name}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {fileSizeLabel(file.size)}
          </Typography.Text>
          <Button size="small" onClick={resetAll}>
            换一份
          </Button>
        </Flex>
      ) : (
        <Flex vertical gap={8} align="center" style={{ padding: "12px 0" }}>
          <Typography.Text type="secondary">还没有选文件</Typography.Text>
          <Button icon={<UploadOutlined />} onClick={() => inputRef.current?.click()}>
            选择 CSV 文件
          </Button>
        </Flex>
      )}

      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
        一次最多 {MAX_IMPORT_ROWS} 行 · 1000 行约一分半
      </Typography.Text>

      {fileError ? (
        <div style={{ marginTop: 12 }}>
          <StateBlock
            tone="error"
            title={fileError}
            hint="改好表头、或另存为「CSV UTF-8」之后，重新选文件再传一次。"
          />
        </div>
      ) : null}

      {summary ? (
        <div style={{ marginTop: 12 }}>
          <SummaryPanel summary={summary} phase={result ? "import" : "preview"} />
        </div>
      ) : null}
    </Modal>
  );
}

/**
 * 三个数 + 逐行原因。预检（`phase="preview"`）与真导（`phase="import"`）共用。
 *
 * 三个数由服务端给（不在前端反算）：恒等式不成立会在这里抛（`importCounts` 的契约），
 * 由错误边界兜住，而不是安静地摆出一组对不上的数。
 * 逐行只显示服务端截好的那一批（`issues` 已被 `SUMMARY_ISSUE_LIMIT` 截断）——
 * 前端**不再写第二个上限数字**，否则两处迟早漂开。
 */
function SummaryPanel({
  summary,
  phase,
}: {
  summary: ImportSummaryDto;
  phase: "preview" | "import";
}) {
  const counts = importCounts(summary);

  const cols: TableColumnsType<ImportIssueDto> = [
    {
      key: "row",
      title: "行号",
      dataIndex: "row",
      width: 76,
      ellipsis: true,
      render: (v: number) => <span className="num">{v}</span>,
    },
    {
      key: "field",
      title: "字段",
      dataIndex: "field",
      width: 170,
      ellipsis: true,
      render: (_v, r) => (
        <Space size={6}>
          <span>{r.field}</span>
          {/* 原因码是给测试与统计读的，悬停才出（落点③），不占常驻版面 */}
          <Tooltip title="错误报告里按这个码归类">
            <span className="num" style={{ color: INK.faint, fontSize: 11 }}>
              {r.code}
            </span>
          </Tooltip>
        </Space>
      ),
    },
    { key: "message", title: "原因", dataIndex: "message", ellipsis: true },
  ];

  const shown = summary.issues.length;

  return (
    <div>
      <Flex gap={32} wrap style={{ marginBottom: 8 }}>
        <Statistic title="共（文件里的数据行）" value={counts.total} />
        <Statistic
          title={phase === "preview" ? "将导入" : "已导入"}
          value={counts.imported}
          valueStyle={{ color: BRAND.success }}
        />
        <Statistic title="有问题" value={counts.error} valueStyle={{ color: BRAND.overdue }} />
      </Flex>

      {phase === "preview" ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          message="这是预检，还没有写入。确认无误后再点「开始导入」。"
        />
      ) : summary.replayed ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          message="这一份文件之前导过，本次一行都没有新增"
          description="已经导入的行按内容命中被跳过；坏行照旧报它原来的原因。若要补录，请只保留没进去的行再传一次。"
        />
      ) : counts.error > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`${counts.error} 行没有导入`}
          description={
            shown < counts.error
              ? `下面是最前面的 ${shown} 条，完整清单在错误报告里。`
              : "下面是全部未导入的行。"
          }
        />
      ) : null}

      <Typography.Text strong style={{ fontSize: 13 }}>
        未导入的行
        {shown < counts.error ? `（显示前 ${shown} 条，共 ${counts.error} 条）` : ""}
      </Typography.Text>

      <Table<ImportIssueDto>
        size="small"
        rowKey={(r) => `${r.row}-${r.field}-${r.code}`}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: 640 }}
        style={{ marginTop: 6 }}
        dataSource={summary.issues}
        columns={cols}
        locale={{
          emptyText: <Typography.Text style={{ fontSize: 12 }}>没有未导入的行。</Typography.Text>,
        }}
      />

      {phase === "import" && summary.reportRef !== "" ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
          报告留在 <Link href="/config/import">批量导入页</Link>，关掉这里也能回去下载。
        </Typography.Text>
      ) : null}
    </div>
  );
}

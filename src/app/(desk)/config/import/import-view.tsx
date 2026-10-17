"use client";

import { useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Collapse,
  Flex,
  Progress,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import { DownloadOutlined, ReloadOutlined, UploadOutlined } from "@ant-design/icons";

import { PageHeader } from "@/app/components/page-header";
import { StateBlock } from "@/app/components/ui/state-block";
import { INK, BRAND } from "@/app/theme/brand";
import { ApiFailure, downloadCsv, useMeta } from "@/app/lib/client/api";
import {
  fetchReport,
  fetchTemplate,
  runImport,
  useImportBatches,
} from "@/app/lib/client/api-import";
import {
  buildImportPayload,
  checkImportPayload,
  fileSizeLabel,
  importCounts,
  importKindLabel,
  importPayloadError,
  isImportDenied,
  variantOf,
  type ImportBatchDto,
  type ImportIssueDto,
  type ImportSummaryDto,
} from "@/app/lib/client/import-ui";
import { IMPORT_KINDS, type ImportKind } from "@/shared/enums/import";
import {
  IMPORT_TEMPLATES,
  MAX_IMPORT_ROWS,
  VALUE_LIST_SEP,
  enumValueHint,
  headerOf,
  type ImportColumn,
} from "@/shared/schema/import";

/**
 * 批量导入（P14 / M7 US-M7-1 / MATT-67）—— 承载 F7-4 的页面。
 *
 * ## 这一页只说两件事
 *
 * ① **怎么把文件交上来**（选模板 → 上传 → 开始导入）；
 * ② **交上来之后哪些行没进去**——「已导入 / 未导入」两个数**必须同屏**，这是 P14 的核心信息。
 *    逐行原因列在下面，完整清单走「下载错误报告」。
 *
 * ## 权限：不镜像 `canImport`
 *
 * 能否导入由服务端每个端点各自判定（`guards.ts#canImport` → 403 `import_forbidden`）。
 * 前端**不写第二份谓词**：客户端的 `Actor` 里根本没有 `isAdmin`（逃生口），
 * 镜像出来的判定会与服务端漂开。所以这一页靠**一次真读**换权限面 ——
 * 挂载时拉「最近导入」（`useImportBatches`），非 L1 会当场拿到 403，
 * 页面直接画成明确拒绝，而不是让用户点一次导入才知道。这不是额外请求：
 * 最近导入本来就是这一页要显示的东西（用户关掉标签页后，报告的找回路径）。
 *
 * ## 逐行结果不排序不分页
 *
 * 响应里的 `issues` 是服务端截好的"先看一眼"的量（上限见服务端 `SUMMARY_ISSUE_LIMIT`），
 * 没有分页也没有排序语义 —— 所以这里不套 `DataTable`（它的契约是受控分页的服务端列表，
 * 页大小 > 100 直接抛）。照 `report-cards.tsx` 的写法：`Card` + `pagination={false}` 的小表，
 * 密度契约仍照旧（每列 `width` + `ellipsis`，`scroll.x` = 列宽合计）。
 *
 * ## ⚠ 三种排列尚未定稿
 *
 * 票面原文：P14 变体选定是用户的决定，选定那张票未关之前「可以做外壳与交互，
 * 但不要把它当定稿」。所以 A/B/C 三种排列都实现了、都能用 `?variant=` 打开，
 * 缺省是父代理的建议值 C。选择器在页头，悬停才说明它待定。
 */
export function ImportView() {
  const { message } = AntdApp.useApp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const variant = variantOf(searchParams.get("variant"));

  const [kind, setKind] = useState<ImportKind>("risk_matter");
  const [file, setFile] = useState<{ name: string; size: number; text: string } | null>(null);
  const [summary, setSummary] = useState<ImportSummaryDto | null>(null);
  /** 文件级拒绝（400）：表头不认识 / 编码不是 UTF-8 / 行数超上限。整份退回，没有逐行结果 */
  const [fileError, setFileError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const batches = useImportBatches();
  const denied = batches.isError && isImportDenied(batches.error);
  const dict = useMeta("risk_matter");

  const downloadTemplate = useMutation({
    mutationFn: (k: ImportKind) => fetchTemplate(k),
    onSuccess: (r) => {
      message.success(`已下载 ${r.fileName}`);
      downloadCsv(r.fileName, r.csv);
    },
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "模板下载失败"),
  });

  const downloadReport = useMutation({
    mutationFn: (ref: string) => fetchReport(ref),
    onSuccess: (r) => downloadCsv(r.fileName, r.csv),
    onError: (e) => message.error(e instanceof ApiFailure ? e.message : "报告下载失败"),
  });

  const submit = useMutation({
    mutationFn: (p: { kind: ImportKind; name: string; text: string }) => {
      const checked = checkImportPayload(buildImportPayload(p.kind, p.name, p.text));
      if (!checked.ok)
        throw new ApiFailure(400, {
          error: "validation_failed",
          message: importPayloadError(checked.issues),
        });
      return runImport(checked.data);
    },
    onSuccess: (r) => {
      setFileError(null);
      setSummary(r);
      message.success(
        r.replayed ? "这份文件之前导过，本次一行都没有新增" : `已导入 ${r.importedRows} 行`,
      );
      // 「最近导入」里要出现这一批（它就是报告的找回路径），所以拉一次
      void batches.refetch();
    },
    onError: (e) => {
      setSummary(null);
      // 400 是**文件级**拒绝（整份退回）；403 已由页面级的拒绝面接管
      setFileError(e instanceof ApiFailure ? e.message : "导入失败，请重试");
    },
  });

  function pickFile(f: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setFile({ name: f.name, size: f.size, text: String(reader.result ?? "") });
      setSummary(null);
      setFileError(null);
    };
    reader.onerror = () => message.error("文件读不出来，请换一份");
    reader.readAsText(f);
  }

  if (denied) {
    return (
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <PageHeader title="批量导入" />
        <StateBlock
          tone="denied"
          title="批量导入只对持有全局数据范围的角色开放"
          hint="当前角色不具备。需要的话请系统所有者授予「全局管理 / 全局经办」这类全局范围的角色。"
        />
      </div>
    );
  }

  const template = (
    <TemplateBlock
      kind={kind}
      onKind={setKind}
      onDownload={downloadTemplate}
      levels={dict.data?.levels ?? []}
    />
  );
  const upload = (
    <UploadBlock
      file={file}
      busy={submit.isPending}
      inputRef={inputRef}
      onPick={pickFile}
      onClear={() => {
        setFile(null);
        setSummary(null);
        setFileError(null);
        if (inputRef.current) inputRef.current.value = "";
      }}
      onRun={() => file && submit.mutate({ kind, name: file.name, text: file.text })}
      collapsed={variant === "C" && summary !== null}
      summary={summary}
    />
  );
  const result =
    fileError !== null ? (
      <StateBlock
        tone="error"
        title={fileError}
        hint="改好表头、或另存为「CSV UTF-8」之后，重新选文件再传一次。"
        action={
          <Button
            size="small"
            onClick={() => {
              setFileError(null);
              inputRef.current?.click();
            }}
          >
            重新选文件
          </Button>
        }
      />
    ) : summary ? (
      <ResultBlock
        summary={summary}
        cap={variant === "C" ? 18 : 12}
        onDownloadReport={() => downloadReport.mutate(summary.reportRef)}
        reportBusy={downloadReport.isPending}
      />
    ) : null;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      <PageHeader
        title="批量导入"
        actions={
          <Tooltip title="P14 的三种排列（A 单栏 / B 左右两栏 / C 结果独占）尚未定稿，待用户选定后再收敛。">
            <span>
              <Segmented
                size="small"
                value={variant}
                onChange={(v) => {
                  const next = String(v);
                  const q = next === "C" ? "" : `?variant=${next}`;
                  router.replace(`/config/import${q}`);
                }}
                options={[
                  { label: "A", value: "A" },
                  { label: "B", value: "B" },
                  { label: "C", value: "C" },
                ]}
              />
            </span>
          </Tooltip>
        }
      />

      {submit.isPending ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="导入进行中"
          description={
            <Space size={6}>
              <span>一次最多 {MAX_IMPORT_ROWS} 行；1000 行实测约一分半。</span>
              <span>请停在页面上不要关闭。</span>
            </Space>
          }
        />
      ) : null}

      {variant === "A" ? (
        <Flex vertical gap={12}>
          {template}
          {upload}
          {result}
        </Flex>
      ) : variant === "B" ? (
        <Flex gap={16} align="flex-start" wrap>
          <div style={{ flex: "0 0 300px", maxWidth: 300 }}>{template}</div>
          <div style={{ flex: 1, minWidth: 340 }}>
            {/* 变体 B：导入之后结果**替换**上传区（不滚动找结果）；文件级错误时留着上传区 */}
            {result && summary !== null ? (
              result
            ) : (
              <Flex vertical gap={12}>
                {upload}
                {result}
              </Flex>
            )}
          </div>
        </Flex>
      ) : (
        <Flex vertical gap={12}>
          {upload}
          {result}
        </Flex>
      )}

      <BatchesCard
        items={batches.data?.items ?? []}
        loading={batches.isPending}
        onReport={(r) => downloadReport.mutate(r)}
        onRetry={() => void batches.refetch()}
      />
    </div>
  );
}

/* ───────────────────────── 模板：选类型 + 下载 + 字段表 ───────────────────────── */

function TemplateBlock({
  kind,
  onKind,
  onDownload,
  levels,
}: {
  kind: ImportKind;
  onKind: (k: ImportKind) => void;
  onDownload: { mutate: (k: ImportKind) => void; isPending: boolean; variables?: ImportKind };
  levels: readonly { code: string; name: string }[];
}) {
  const columns = IMPORT_TEMPLATES[kind];
  return (
    <Card size="small" variant="outlined" styles={{ body: { padding: 0 } }}>
      <Flex align="center" justify="space-between" gap={12} wrap style={{ padding: "12px 16px" }}>
        <Segmented
          value={kind}
          onChange={(v) => onKind(v as ImportKind)}
          options={IMPORT_KINDS.map((k) => ({ label: importKindLabel(k), value: k }))}
        />
        <Button
          icon={<DownloadOutlined />}
          loading={onDownload.isPending && onDownload.variables === kind}
          onClick={() => onDownload.mutate(kind)}
        >
          下载{importKindLabel(kind)}模板（CSV）
        </Button>
      </Flex>
      <Collapse
        ghost
        items={[
          {
            key: "fields",
            label: `字段与取值（${columns.length} 列）`,
            children: <FieldTable columns={columns} levels={levels} />,
          },
        ]}
      />
    </Card>
  );
}

/**
 * 字段表（副标题纪律的**落点④**）：取值与字段说明落在这里，不在页头讲规则。
 * 列规格与取值清单都从 `shared/schema/import.ts` 取 —— 那里是模板、逐行解析、spec
 * 三处共用的唯一一份，页面再抄一份必然与下载下来的模板漂开。
 */
function FieldTable({
  columns,
  levels,
}: {
  columns: readonly ImportColumn[];
  levels: readonly { code: string; name: string }[];
}) {
  const rows = columns.map((c) => ({
    key: c.field,
    header: headerOf(c),
    required: c.required,
    hint: hintOf(c, levels),
  }));
  const cols: TableColumnsType<(typeof rows)[number]> = [
    {
      key: "header",
      title: "列",
      dataIndex: "header",
      width: 170,
      ellipsis: true,
      render: (_v, r) => (
        <Space size={4}>
          <span>{r.header}</span>
          {r.required ? (
            <Tag color="red" variant="filled">
              必填
            </Tag>
          ) : null}
        </Space>
      ),
    },
    { key: "hint", title: "取值与说明", dataIndex: "hint", ellipsis: true },
  ];
  return (
    <Table
      size="small"
      rowKey="key"
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: 470 }}
      dataSource={rows}
      columns={cols}
    />
  );
}

/** 说明行里那一列的文字：枚举列的取值清单 / 配置列按当前启用项现算 / 其余取列的 hint */
function hintOf(c: ImportColumn, levels: readonly { code: string; name: string }[]): string {
  if (c.kind === "enum") return enumValueHint(c);
  if (c.kind === "config") {
    const list = levels.map((l) => `${l.name}（${l.code}）`).join(VALUE_LIST_SEP);
    return `取值：${list || "暂无启用的配置项"}（按配置表启用的等级）`;
  }
  return c.hint ?? "—";
}

/* ───────────────────────── 上传区 ───────────────────────── */

function UploadBlock({
  file,
  busy,
  inputRef,
  onPick,
  onClear,
  onRun,
  collapsed,
  summary,
}: {
  file: { name: string; size: number } | null;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPick: (f: File) => void;
  onClear: () => void;
  onRun: () => void;
  collapsed: boolean;
  summary: ImportSummaryDto | null;
}) {
  const counts = summary ? importCounts(summary) : null;

  if (collapsed && file && counts) {
    // 变体 C：导入完成后上传区塌成一条细 bar，把首屏让给「多少行没进去」
    return (
      <Card size="small" variant="outlined" styles={{ body: { padding: "8px 16px" } }}>
        <Flex align="center" gap={12} wrap>
          <Typography.Text strong ellipsis style={{ minWidth: 0, flex: "1 1 200px" }}>
            {file.name}
          </Typography.Text>
          <Space size={16}>
            <Typography.Text type="secondary">
              共 <span className="num">{counts.total}</span> 行
            </Typography.Text>
            <Typography.Text style={{ color: BRAND.success }}>
              进库 <span className="num">{counts.imported}</span>
            </Typography.Text>
            <Typography.Text style={{ color: BRAND.overdue }}>
              未进 <span className="num">{counts.error}</span>
            </Typography.Text>
          </Space>
          <Button size="small" onClick={onClear}>
            换一份文件
          </Button>
        </Flex>
      </Card>
    );
  }

  return (
    <Card
      size="small"
      variant="outlined"
      title={<span style={{ fontSize: 13 }}>上传填好的模板</span>}
      extra={<Tag>.csv · UTF-8</Tag>}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
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
          <Button size="small" onClick={onClear}>
            换一份
          </Button>
        </Flex>
      ) : (
        <Flex vertical gap={8} align="center">
          <Typography.Text type="secondary">还没有选文件</Typography.Text>
          <Button icon={<UploadOutlined />} onClick={() => inputRef.current?.click()}>
            选择 CSV 文件
          </Button>
        </Flex>
      )}

      <Flex align="center" gap={12} wrap style={{ marginTop: 12 }}>
        <Button type="primary" disabled={!file} loading={busy} onClick={onRun}>
          开始导入
        </Button>
        <Tooltip
          title={`文件先过表头校验，不合格整份退回。一次最多 ${MAX_IMPORT_ROWS} 行；1000 行实测约一分半，导入期间请停在页面上。`}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            一次最多 {MAX_IMPORT_ROWS} 行 · 1000 行约一分半
          </Typography.Text>
        </Tooltip>
      </Flex>
    </Card>
  );
}

/* ───────────────────────── 结果：两个数同屏 + 逐行原因 ───────────────────────── */

function ResultBlock({
  summary,
  cap,
  onDownloadReport,
  reportBusy,
}: {
  summary: ImportSummaryDto;
  cap: number;
  onDownloadReport: () => void;
  reportBusy: boolean;
}) {
  // 这三个数由服务端给（不在前端反算）：恒等式不成立会在这里抛，由错误边界兜住
  const counts = importCounts(summary);
  const shown = Math.min(cap, summary.issues.length);

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

  return (
    <Card size="small" variant="outlined" styles={{ body: { padding: 0 } }}>
      <Flex gap={32} wrap style={{ padding: "16px 16px 8px" }}>
        <Statistic title="文件里的数据行" value={counts.total} />
        <Statistic title="已导入" value={counts.imported} valueStyle={{ color: BRAND.success }} />
        <Statistic title="未导入" value={counts.error} valueStyle={{ color: BRAND.overdue }} />
        <Flex vertical justify="center" style={{ flex: 1, minWidth: 180 }}>
          <Progress
            percent={counts.okPercent}
            showInfo={false}
            strokeColor={BRAND.success}
            trailColor={INK.line}
          />
        </Flex>
      </Flex>

      <div style={{ padding: "0 16px 12px" }}>
        {summary.replayed ? (
          <Alert
            type="info"
            showIcon
            message="这一份文件之前导过，本次一行都没有新增"
            description="已经导入的行按内容命中被跳过；坏行照旧报它原来的原因。若要补录，请只保留没进去的行再传一次。"
          />
        ) : counts.error > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={`${counts.error} 行没有导入`}
            description={
              shown < counts.error
                ? `下面是最前面的 ${shown} 条，完整清单在错误报告里。`
                : "下面是全部未导入的行。"
            }
          />
        ) : null}
      </div>

      <Flex align="center" justify="space-between" gap={12} wrap style={{ padding: "0 16px 10px" }}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          未导入的行
          {shown < counts.error ? `（显示前 ${shown} 条，共 ${counts.error} 条）` : ""}
        </Typography.Text>
        <Button icon={<DownloadOutlined />} loading={reportBusy} onClick={onDownloadReport}>
          下载错误报告（CSV）
        </Button>
      </Flex>

      <Table<ImportIssueDto>
        size="small"
        rowKey={(r) => `${r.row}-${r.field}-${r.code}`}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: 940 }}
        dataSource={summary.issues.slice(0, cap)}
        columns={cols}
        locale={{
          emptyText: <Typography.Text style={{ fontSize: 12 }}>没有未导入的行。</Typography.Text>,
        }}
      />
    </Card>
  );
}

/* ───────────────────────── 最近导入（报告的找回路径） ───────────────────────── */

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
      render: (v: ImportKind) => importKindLabel(v),
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
      style={{ marginTop: 12 }}
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
              还没有导入过。上面选好类型、下载模板填完后上传即可。
            </Typography.Text>
          ),
        }}
      />
    </Card>
  );
}

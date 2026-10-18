import { importRequestSchema } from "@/shared/schema/import";
import { IMPORT_KIND_LABELS, type ImportKind } from "@/shared/enums/import";

import { ApiFailure } from "./api";

/**
 * 批量导入页（P14 / MATT-67）**不碰 DOM 的那一半**：计数口径、提交前校验、403 识别、
 * 变体解析、文件大小文案。
 *
 * ## 为什么单独成文件（而不是全写在 `import-view.tsx` 里）
 *
 * 这四件事都是**纯判断**，不需要 React、不需要真库。放进视图里，唯一能验它们的就只剩
 * 真浏览器探针 —— 而探针要真上传、真跑 81 秒。抽出来之后：
 *   · 「两个数怎么算的」与「计数不自洽就抛」在毫秒级被钉住（`import-ui.spec.ts`）；
 *   · 探针只负责票面第 7 条那件真浏览器才能验的事（页面上的数与接口返回一致）。
 * 这与 `lib/client/archive-readiness.ts` 的分工同形：判定在服务端、展示口径在客户端一处。
 *
 * ## 为什么这里的 DTO 是手写的一遍
 *
 * 与 `api.ts` 顶部那条注释同源：服务层的 `ImportSummary` 从
 * `@/app/lib/server/services/import` 导出，而**服务端类型不得进客户端模块**
 * （哪怕 `import type` 会被擦除，下一个人去掉 `type` 就把 DB 代码拖进 bundle）。
 * 所以字段名在这里逐字重写一遍 —— 服务端改了 select 列，这一层先在 `tsc` 上红。
 */

/** 逐行问题（服务层 `ImportIssueLine` 的线上形态，字段名逐字对应） */
export type ImportIssueDto = {
  row: number;
  field: string;
  code: string;
  message: string;
  /** 这一行最终进库没有。`true` 只出现在"写进去了但幂等键被并发占了"那种告警上 */
  imported: boolean;
};

/** `POST /api/import` 的响应（`ImportSummary`） */
export type ImportSummaryDto = {
  batchId: string;
  hostType: ImportKind;
  fileName: string;
  totalRows: number;
  importedRows: number;
  errorRows: number;
  /** 这一次一行都没新增、且有行因"已导过"被跳过 ⇒ 同文件重放 */
  replayed: boolean;
  reportRef: string;
  issues: ImportIssueDto[];
  issueTotal: number;
  truncatedIssues: boolean;
};

/** `GET /api/import/templates` 与 `GET /api/import/report/[id]` 的共同出口形状：JSON 里带 `csv` */
export type ImportCsvDto = { fileName: string; csv: string };

export type ImportBatchDto = {
  id: string;
  hostType: ImportKind;
  fileName: string;
  totalRows: number;
  importedRows: number;
  errorRows: number;
  status: string;
  createdAt: string;
  reportRef: string;
};

export type ImportBatchListDto = { items: ImportBatchDto[] };

/* ───────────────────────── 计数：页面上的两个数 ───────────────────────── */

export type ImportCounts = {
  total: number;
  imported: number;
  /** **未导入**（校验失败 + 内容重复）。与「已导入」同屏，这是 P14 的核心信息 */
  error: number;
  /** 已导入占比（0–100 的整数），画进度条用 */
  okPercent: number;
};

/**
 * 三个计数：**已导入 / 未导入必须来自服务端**，不由前端 `total - imported` 反算。
 *
 * 反算看起来等价，实则把"服务端算错了"这件事藏起来：恒等式一旦不成立，
 * 页面会安静地画出一个与报告条目数不符的数。所以这里**先断言恒等式**，
 * 不成立就抛（错误边界兜住），而不是把三个数并排摆出来当没问题。
 * 服务层内部也断言同一条（`services/import.ts`），这里是同一条 AC 的另一层。
 */
export function importCounts(s: {
  totalRows: number;
  importedRows: number;
  errorRows: number;
}): ImportCounts {
  const { totalRows, importedRows, errorRows } = s;
  if (totalRows !== importedRows + errorRows) {
    throw new Error(
      `导入计数不自洽：文件 ${totalRows} 行，已导入 ${importedRows}，未导入 ${errorRows}`,
    );
  }
  const okPercent = totalRows === 0 ? 0 : Math.round((100 * importedRows) / totalRows);
  return { total: totalRows, imported: importedRows, error: errorRows, okPercent };
}

/* ───────────────────────── 提交前校验 ───────────────────────── */

export type ImportPayload = { hostType: ImportKind; fileName: string; csv: string };

/** 请求体形状由 `importRequestSchema` 定（`.strict()`，键名不能改），前端只是照它组装 */
export function buildImportPayload(
  hostType: ImportKind,
  fileName: string,
  csv: string,
): ImportPayload {
  return { hostType, fileName, csv };
}

export type PayloadIssue = { path: string; message: string };

/**
 * 提交前先过**同一份** schema（不是第二套规则）。
 *
 * 为什么值得在客户端跑一遍：一次导入实测 81s/1000 行。"文件是空的"或"文件太大"
 * 这类**不需要库**就能判断的事，让用户等一分半再收到 400 是纯粹的浪费。
 * 但规则本身来自 `shared/schema/import.ts`（禁令⑧：校验规则单源），这里只是提前跑。
 */
export function checkImportPayload(
  payload: ImportPayload,
): { ok: true; data: ImportPayload } | { ok: false; issues: PayloadIssue[] } {
  const r = importRequestSchema.safeParse(payload);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({
      path: i.path.map(String).join("."),
      message: i.message,
    })),
  };
}

/**
 * 把 schema 的 issues 翻成一句给用户读的话。
 *
 * zod 的**默认**文案是英文的（`Too big: expected string to have <=200 characters`），
 * 而 schema 里 `fileName` 的 `max` 那一处没写 `message` —— 直接透传等于把一句英文
 * 摆在中文界面里，还带着 `expected` 这种只有写代码的人看得懂的词。
 *
 * 所以只把**认得出的那一处**（`fileName`）换掉，并且**不重抄上限数字**
 * （那个数住在 `shared/schema/import.ts` 的 `MAX_FILE_NAME` 里，抄一份就会漂）；
 * 其余路径一律透传 schema 的原文 —— 宁可少说，也不在前端编一句话。
 */
export function importPayloadError(issues: readonly PayloadIssue[]): string {
  const first = issues[0];
  if (!first) return "文件读不出来，请重新选择。";
  if (first.path === "fileName") return "文件名太长";
  return first.message;
}

/* ───────────────────────── 权限：403 的 UI 面 ───────────────────────── */

/**
 * 是不是"你没有导入权"（`importForbidden` → 403）？
 *
 * 只认 403：404 在本仓意味着"不可见"，500 是服务端坏了 —— 把后两者画成权限文案
 * 会让用户去找管理员，而真正该做的是重试或报障。
 *
 * ⚠ 这里**不重算** `canImport`（那条判定在 `guards.ts`，服务端每个端点各判一次）。
 * 前端只把服务端给的结果翻译成界面：镜像一份谓词就会有两份会漂的"谁能导"。
 */
export function isImportDenied(e: unknown): boolean {
  return e instanceof ApiFailure && e.status === 403;
}

/* ───────────────────────── 杂项文案 ───────────────────────── */

/** 文件大小：列表里给"268 KB"而不是 274432 这种字节数 */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `hostType` → 中文名。复用枚举表里的那一份，不在页面里写第二个字典 */
export const importKindLabel = (k: ImportKind): string => IMPORT_KIND_LABELS[k];

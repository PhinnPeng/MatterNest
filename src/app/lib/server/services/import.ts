import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { nextId } from "@/shared/ids/snowflake";
import { IMPORT_KIND_LABELS, type ImportIssueCode, type ImportKind } from "@/shared/enums/import";
import { matterCreateSchema, riskCreateSchema } from "@/shared/schema/hosts";
import {
  IMPORT_TEMPLATES,
  buildImportRow,
  parseImportFile,
  templateRows,
  type ImportDeps,
  type ImportFileProblem,
  type ImportRowIssue,
} from "@/shared/schema/import";
import type { Actor } from "../auth/auth";
import { getDb } from "../db/client";
import { importBatch, importRow, riskLevelConfig } from "../db/schema";
import { logActivity } from "./activity";
import { csvText } from "./exports";
import { createMatter } from "./matters";
import {
  OwnCompanyPartyError,
  UnknownPartyError,
  createParty,
  partyCreateSchema,
  type PartyLinkInput,
} from "./parties";
import { createRiskMatter } from "./risks";
import { UnassignableAssigneeError, listUsersForCreate } from "./selectable-users";

/**
 * 批量导入（F7-4 / M7 US-M7-1，MATT-44）。
 *
 * ## 逐行为什么是**一行一个事务**
 *
 * 导入的是三年历史烂账，一行坏掉不能让整批归零（Q42=A 的裁定原文）。
 * 落法不是在"一个大事务里 try/catch 每一行"——那样任何一条真错误都会把整个事务
 * 打进 aborted 态（PG 的事务语义），后续行全废。所以逐行调用**既有创建服务**
 * （`createRiskMatter` / `createMatter` / `createParty`），它们各自开一个事务：
 * 一行提交、一行失败，互不影响。这也顺带满足 master §6.2 的硬要求
 * 「导入必须走同一 StaffService 与编号生成器，不得直插 SQL」——
 * 这里一行插入 SQL 都没有，编号、初始态、参与人、当事人查重、`*_CREATED` 审计
 * 全部复用单条路径的那几份实现。
 *
 * ⚠ **代价写在明处**：创建服务自带事务 ⇒ 业务记录与 `mn_import_row` 那一条
 *   **不可能在同一个事务里**。两者之间进程若被杀，会出现"记录已建、导入行没记"，
 *   于是重导那一行会**多出一条重复记录**。这是刻意的方向选择：
 *   反过来（先占幂等键再建记录）崩溃会留下"键已占、记录没建"，
 *   重导**静默跳过**那一行 —— 少了行比多了行危险（票面原话）。
 *   多出来的记录在列表里看得见，`status='running'` 的批次也留着痕迹。
 *
 * ## 幂等键：**行的内容**，不是文件
 *
 * 键 = `sha256(host_type + 规范化后的落库入参)`，落在 `mn_import_row.row_hash`，
 * 由 partial unique index `uk_mn_import_row_content` 兜底。三条理由见 `rowHashOf`。
 * 键选"行"而不是"文件"的直接后果：用户改掉 500 行里的 1 行再传一次，
 * 另外 499 行按内容命中、**一行都不会重复**；而若按文件哈希做键，
 * 改动一个字符就会让整份文件重新导一遍（那才是这个功能最容易出的事故）。
 */

/** 文件级问题（表头/编码/行数）→ 400，不是"逐行跳过"：不知道哪一列是什么，任何一行都无从解释 */
export class ImportFileError extends Error {
  constructor(readonly problem: ImportFileProblem) {
    super(problem.message);
    this.name = "ImportFileError";
  }
}

/** 报告里的一条（一行可能有多个问题，每个问题一行 CSV 记录） */
export type ImportIssueLine = {
  row: number;
  field: string;
  code: ImportIssueCode;
  message: string;
  /** 这一行最终进了库没有。`true` 只出现在并发冲突那种"写进去了但键被占了"的告警上 */
  imported: boolean;
};

export type ImportSummary = {
  batchId: string;
  hostType: ImportKind;
  fileName: string;
  /** 文件里的数据行数（不含表头、说明行、空行） */
  totalRows: number;
  importedRows: number;
  /** **未导入**的行数（校验失败 + 内容重复）。与 §3.5 载荷的 `error_rows` 同义 */
  errorRows: number;
  /**
   * 这一次**一行都没新增**，且有行是因为"已经导过"被跳过 ⇒ 同文件重放。
   * 判据的两个半边（不能只看零新增）见 `runImport` 里 `alreadyImportedRows` 的注释。
   */
  replayed: boolean;
  /** 错误报告的可下载引用（= 批次 id）。`BULK_IMPORT` 载荷里的 `report_ref` 就是它 */
  reportRef: string;
  /** 前若干条问题（完整清单走报告下载）。上限见 `SUMMARY_ISSUE_LIMIT` */
  issues: ImportIssueLine[];
  issueTotal: number;
  truncatedIssues: boolean;
};

/** 响应里内联多少条问题。给的是"先看一眼"的量，完整清单在报告里 */
export const SUMMARY_ISSUE_LIMIT = 50;

/** 批次列表返回多少条（够回查最近几次导入） */
export const IMPORT_BATCH_LIST_LIMIT = 20;

/** 取一次导入要用的配置与花名册。**逐行循环外只取一次**：行数上千时按行查会白跑上千次 */
async function loadDeps(): Promise<ImportDeps> {
  const db = await getDb();
  const levels = await db
    .select({ code: riskLevelConfig.code, name: riskLevelConfig.name })
    .from(riskLevelConfig)
    .where(eq(riskLevelConfig.isEnabled, true))
    .orderBy(riskLevelConfig.sortOrder);
  // 处理人只认"在册且已开通"的用户：与创建表单同一个来源（IQ-14 的创建期例外）
  const users = await listUsersForCreate();
  return {
    levels,
    users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })),
  };
}

/**
 * 模板 CSV（事项 / 案件 / 当事人）。
 *
 * 生成走 `templateRows`（shared，与逐行解析同一份列规格）+ 服务层的 `csvText`
 * （与两条导出链路同一份编码）——**没有第二份列清单，也没有第二份 CSV 编码**。
 * 说明行按**当前配置**现算（风险等级来自 `mn_risk_level_config`），
 * 所以模板里写的取值与库里的启用项不会脱节。
 */
export async function importTemplate(kind: ImportKind): Promise<{ fileName: string; csv: string }> {
  const deps = await loadDeps();
  return {
    fileName: `${IMPORT_KIND_LABELS[kind]}导入模板.csv`,
    csv: csvText(templateRows(kind, deps)),
  };
}

/* ───────────────────────────── 幂等键 ───────────────────────────── */

/** 稳定 JSON：键名升序、丢掉 `undefined` —— 同一份语义必须得到同一个串 */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

/**
 * 行的幂等键。
 *
 * ## 为什么是"行的内容"而不是"文件哈希"
 *
 * 文件哈希只能回答"这份文件是不是一模一样"——而真实用法是**改错行再传一次**：
 * 500 行里改了 1 行，文件哈希变了，整份文件会被重新导一遍，499 行变成重复记录。
 * 内容键把"这一行导过没有"变成逐行可判，于是重传只补没进去的那几行。
 *
 * ## 为什么哈希的是**解析后的入参**而不是单元格原文
 *
 * 三个理由，每个都对应一次真实的重复/漏导：
 *   · `合同` 与 `contract` 是同一个值 —— 原文不同、语义相同，键必须相同；
 *   · Excel 会把日期重排成 `2024/1/5` 或 `2024-01-05` —— 归一后同一个键；
 *   · 处理人写"姓名"还是"账号" —— 解析到同一个 id 后同一个键。
 * 代价是**配置变了**（比如风险等级改名）会让同一行的键变化，于是重传会再导一遍。
 * 那是可接受的：配置改名本身就是一次需要人判断的变更。
 *
 * ## 当事人顺序
 *
 * 哈希前按名称排序：同一批当事人换个填写顺序是同一件事，不该被当成新行。
 * `sort_order` 落库时仍按文件里的顺序（排序只作用于键，不作用于数据）。
 */
export function rowHashOf(kind: ImportKind, data: Record<string, unknown>): string {
  const parties = Array.isArray(data.parties)
    ? [...(data.parties as Record<string, unknown>[])].sort(
        (a, b) =>
          String(a.name ?? "").localeCompare(String(b.name ?? "")) ||
          String(a.idNumber ?? "").localeCompare(String(b.idNumber ?? "")),
      )
    : [];
  const canonical = stableJson({
    ...data,
    ...(parties.length > 0 ? { parties } : {}),
  });
  return createHash("sha256").update(`${kind}\n${canonical}`).digest("hex");
}

/* ───────────────────────────── 逐行 ───────────────────────────── */

/** zod 的 `parties.0.name` → 模板里的「对方当事人」，报告里的字段列要是人话 */
export function reportFieldLabel(kind: ImportKind, path: string): string {
  const m = /^parties\.\d+\.(.+)$/.exec(path);
  const key = m ? `parties[].${m[1]}` : path;
  const col = IMPORT_TEMPLATES[kind].find((c) => c.field === key);
  return col ? col.label : path === "" ? "整行" : path;
}

/** 把 zod 的 issues 翻成报告条目：字段名换成人话，码统一成 `invalid_field` */
function issuesFromZod(
  kind: ImportKind,
  issues: readonly { path: PropertyKey[]; message: string }[],
): ImportRowIssue[] {
  return issues.map((i) => ({
    field: reportFieldLabel(kind, i.path.map(String).join(".")),
    code: "invalid_field" as const,
    message: i.message,
  }));
}

/**
 * 同一件事的**显示边界**：构建器产出的 `field` 是内部字段名（`ownerId`/`description`），
 * 而报告与摘要里那一列是**给人看的**（「处理人」「风险描述」）。
 *
 * 为什么不在构建器里直接产出中文：字段名是稳定的、可被单测逐个钉住的东西，
 * 而中文列名会随排版改。翻译只发生在**落到库里**与**回到响应里**这两处 ——
 * 也就是仅有的两个"用户会读"的出口。
 */
function labelIssues(kind: ImportKind, issues: readonly ImportRowIssue[]): ImportRowIssue[] {
  return issues.map((i) => ({ ...i, field: reportFieldLabel(kind, i.field) }));
}

type Created = { ok: true; hostId: bigint } | { ok: false; issue: ImportRowIssue };

/**
 * 逐行落库：调用**单条路径的创建服务**，把可预期错误翻成报告条目。
 * `dryRun` 时把开关透传给创建服务（那里只跳过取号与写库事务，校验一条不少）。
 *
 * 未知错误**故意不 catch**：那意味着代码有 bug，继续跑只会把剩下的行
 * 一条条标成"错误"而掩盖真因。让它冒泡 ⇒ 请求 500、批次停在 `running`、
 * 已经提交的行都在，用户重传即可（内容键会把它们跳过）。
 */
async function createRecord(
  kind: ImportKind,
  actor: Actor,
  data: Record<string, unknown>,
  dryRun = false,
): Promise<Created> {
  const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const opts = { dryRun };
  try {
    if (kind === "risk_matter") {
      const r = await createRiskMatter(
        actor,
        {
          name: String(data.name),
          type: String(data.type),
          level: String(data.level),
          description: String(data.description),
          source: s(data.source) ?? null,
          discoverDate: s(data.discoverDate) ?? null,
          ownerId: s(data.ownerId),
          parties: (data.parties ?? []) as PartyLinkInput[],
        },
        opts,
      );
      return { ok: true, hostId: BigInt(r.id) };
    }
    if (kind === "matter") {
      /**
       * 案件的「处理人」必填（IQ-6），而 `matterCreateSchema.ownerId` 是**选填**
       * （单条路径允许它缺省，服务层回落到操作人）。导入这条路上"缺省回落"是错的：
       * 那会把历史案件整批挂到导数据的人头上，而这件事**不会报错**。
       * 模板层已经把它列为必填，这里再挡一道 —— 静默改归属比报错难查得多。
       */
      /**
       * 案件的「处理人」必填（IQ-6），而 `matterCreateSchema.ownerId` 是**选填**
       * （单条路径允许它缺省，服务层回落到操作人）。导入这条路上"缺省回落"是错的：
       * 那会把历史案件整批挂到导数据的人头上，而这件事**不会报错**。
       *
       * ⚠ 诚实的层次说明（反向红实测出来的）：这条 guard 今天**到不了**——
       *   逐行构建器对空处理人给的是 `""`，而 DTO 的 id 正则（`^\d+$`）先把它拒了。
       *   它挡的不是今天的数据，是**下一次重构**：只要有人把构建器里的
       *   `ownerId: ownerId ?? ""` 顺手改成"空就不带这个键"，`.optional()` 就会放行
       *   `undefined`，`createMatter` 随即回落操作人 —— 那正是这条口径要防的事。
       *   （反向红要验出行为变化，得把模板元数据、构建器、这一处**三处一起摘**，
       *     见 `agent-work/revred-import.mjs` 的 `owner-fallback` 条目。）
       */
      if (!s(data.ownerId)) {
        return {
          ok: false,
          issue: { field: "处理人", code: "required", message: "案件必须填处理人，这一行没填" },
        };
      }
      const r = await createMatter(
        actor,
        {
          name: String(data.name),
          cause: String(data.cause),
          caseType: String(data.caseType),
          procedure: String(data.procedure),
          litigationRole: String(data.litigationRole),
          court: s(data.court) ?? null,
          amount: s(data.amount),
          level: String(data.level),
          caseNo: s(data.caseNo) ?? null,
          filingDate: s(data.filingDate) ?? null,
          ownerId: s(data.ownerId),
          description: s(data.description) ?? null,
          parties: (data.parties ?? []) as PartyLinkInput[],
        },
        opts,
      );
      return { ok: true, hostId: BigInt(r.id) };
    }
    /**
     * 当事人这一档的入参**就是** `partyCreateSchema` 的形状（不需要改名或补 null），
     * 所以直接再 parse 一次拿类型，而不是手写六个字段再逐个 cast：
     * 手写的那份会在 DTO 加字段时静默漏掉（新增字段既不在入参里、也没有编译错误）。
     */
    const r = await createParty(actor, partyCreateSchema.parse(data), opts);
    if (r.ok) return { ok: true, hostId: BigInt(r.id) };
    if (r.why === "own_company") {
      return {
        ok: false,
        issue: {
          field: "当事人名称",
          code: "own_company",
          message: `「${r.name}」是本企业名称：我方（本企业）永不进当事人表，这一行请填对方当事人或第三人`,
        },
      };
    }
    return {
      ok: false,
      issue: {
        field: "证件号",
        code: "identity_exists",
        message: `库里已有同证件号的档案「${r.name}」（未新建）。要把它挂到案件上，请在案件/事项模板的「对方当事人」列填名称`,
      },
    };
  } catch (e) {
    // ⚠ 顺序要紧：`OwnCompanyPartyError extends UnknownPartyError`，反了会把本企业名
    // 报成"引用了不存在的当事人"，用户按那句话去改 partyId —— 而根本没有那一列。
    if (e instanceof OwnCompanyPartyError) {
      return {
        ok: false,
        issue: { field: "对方当事人", code: "own_company", message: e.message },
      };
    }
    if (e instanceof UnknownPartyError) {
      return {
        ok: false,
        issue: { field: "对方当事人", code: "invalid_field", message: e.message },
      };
    }
    if (e instanceof UnassignableAssigneeError) {
      return { ok: false, issue: { field: "处理人", code: "unassignable", message: e.message } };
    }
    throw e;
  }
}

/* ───────────────────────────── 导入 ───────────────────────────── */

/**
 * `BULK_IMPORT` 的载荷形状。**逐字照枚举表 §3.5**：
 * `{host_type, total_rows, imported_rows, error_rows, report_ref}`。
 *
 * 单独一个函数而不是在 `runImport` 里就地拼一个对象字面量（照 `exportAuditPayload`
 * 的既有姿态）：载荷形状是**事后审计的查询契约**（"所有导入"要能一条 SQL 捞出来），
 * 它必须能被单测钉住，而不是靠"读一遍那段代码"。
 */
export type ImportAuditPayload = {
  host_type: string;
  total_rows: number;
  imported_rows: number;
  error_rows: number;
  report_ref: string;
};

export function importAuditPayload(p: {
  hostType: ImportKind;
  totalRows: number;
  importedRows: number;
  errorRows: number;
  reportRef: string;
}): ImportAuditPayload {
  return {
    host_type: p.hostType,
    total_rows: p.totalRows,
    imported_rows: p.importedRows,
    error_rows: p.errorRows,
    report_ref: p.reportRef,
  };
}

/** 错误报告的列（导出一份报告时表头就用它，测试也断言它） */
export const IMPORT_REPORT_HEADER = ["行号", "字段", "原因", "状态"] as const;

/**
 * 跑一次导入。**预检（`dryRun`）与真导走的是同一个函数体的同一段解析与逐行校验**——
 * 唯一的区别是"写不写库"，见下面三处 `if (!dryRun)` 与 `createRecord(..., dryRun)`。
 * 这样"预检说能导的行真导时进得去"不是一句约定，而是同一段代码跑了两遍：
 *   · 文件级解析（`parseImportFile`）与逐行构建（`buildImportRow`）**不分支**；
 *   · DTO 校验（`dtoFor`）与内容键（`rowHashOf`）**不分支**；
 *   · **幂等判定（内容键比对）在预检里照常参与** —— 否则预检会把"已导过的行"报成"能导"，
 *     真导时它们全被 `already_imported` 跳过，预检就成了谎报。
 * `dryRun` 只跳过三类写：① 批次行；② 逐行 `mn_import_row`；③ 业务记录（`createRecord`
 * 把 `dryRun` 透传给创建服务，那里同样只跳过取号与写库事务）。
 */
export async function runImport(
  actor: Actor,
  req: { hostType: ImportKind; fileName: string; csv: string },
  opts: { dryRun?: boolean } = {},
): Promise<ImportSummary> {
  const db = await getDb();
  const dryRun = opts.dryRun === true;
  const kind = req.hostType;
  const parsed = parseImportFile(kind, req.csv);
  if (!parsed.ok) throw new ImportFileError(parsed.problem);

  const deps = await loadDeps();
  const batchId = BigInt(nextId());
  const operator = BigInt(actor.userId);

  // 批次行**先落**（`running`）：这样"跑到一半崩了"在库里是可见的，
  // 而不是"什么都没发生"。计数在收尾事务里补齐。
  // 预检不落批次：没有真导入就不该在「最近导入」里多出一条什么都没导的记录。
  if (!dryRun) {
    await db.insert(importBatch).values({
      id: batchId,
      hostType: kind,
      fileName: req.fileName,
      status: "running",
      createdBy: operator,
    });
  }

  /** 逐行明细落库。预检整段跳过 —— 它是写库，不是判据 */
  const persist = dryRun ? noopPersist : writeRow;

  const issues: ImportIssueLine[] = [];
  const seenInRun = new Map<string, number>();
  let importedRows = 0;
  let errorRows = 0;
  /**
   * 「这一次是不是同文件重放」的判据：**一行都没新增，且确实有行是因为"已导入过"被跳过**。
   *
   * 为什么不写成"每一行都是已导入"：带坏行的文件重传时（历史烂账的常态），
   * 坏行**还是坏的**（它们本来就没进库，自然不会变成"已导入"），
   * 于是那个更严的定义永远为假 —— 用户拿不到"这次什么都没新增"这个信号。
   * 反过来也不能只看 `importedRows === 0`：一份全是坏行的文件同样零新增，
   * 那不是重放，是没导进去。两个条件一起才是"重放"（判据在收尾处算，见 `replayed`）。
   */
  let alreadyImportedRows = 0;

  /** 记一行没进库。`replay` 只对"内容已导入"那一条为真 */
  const skipRow = (rowNo: number, rowIssues: readonly ImportRowIssue[], replay = false) => {
    errorRows += 1;
    if (replay) alreadyImportedRows += 1;
    for (const i of labelIssues(kind, rowIssues)) {
      issues.push({
        row: rowNo,
        field: i.field,
        code: i.code,
        message: i.message,
        imported: false,
      });
    }
  };

  for (const row of parsed.rows) {
    const built = buildImportRow(kind, row.cells, deps);

    if (!built.ok) {
      await persist(batchId, kind, row.rowNo, null, "skipped", null, built.issues);
      skipRow(row.rowNo, built.issues);
      continue;
    }

    /**
     * 第二道门：**格式**校验交给既有 DTO（禁令⑧：校验规则单源）。
     * 逐行构建只管"这一格说的是什么"（枚举名→码、日期归一、姓名→id），
     * 长度/正则/必填那类规则在这里跑，用的是建案/建事项/建档案**同一个** schema。
     */
    const dto = dtoFor(kind).safeParse(built.input);
    if (!dto.success) {
      const rowIssues = issuesFromZod(kind, dto.error.issues);
      await persist(batchId, kind, row.rowNo, null, "skipped", null, rowIssues);
      skipRow(row.rowNo, rowIssues);
      continue;
    }

    const data = dto.data as Record<string, unknown>;
    const hash = rowHashOf(kind, data);

    // ① 本文件内重复：同一份台账里两行内容逐字相同 —— 报出来，不静默吞
    const earlier = seenInRun.get(hash);
    if (earlier !== undefined) {
      const rowIssues: ImportRowIssue[] = [
        {
          field: "整行",
          code: "duplicate_row",
          message: `与本文件第 ${earlier} 行的内容完全相同，未重复导入（若这是两笔真事，请在其中一行加上可区分的信息）`,
        },
      ];
      await persist(batchId, kind, row.rowNo, null, "skipped", null, rowIssues);
      skipRow(row.rowNo, rowIssues);
      continue;
    }
    // ② 之前批次导过同样内容：同文件重放 / 改了一行再传，都走这一条
    const prior = await findImportedByHash(kind, hash);
    if (prior) {
      const rowIssues: ImportRowIssue[] = [
        {
          field: "整行",
          code: "already_imported",
          message: `与第 ${prior.rowNo} 行（批次 ${prior.batchId}）内容相同，已导入过，未重复导入`,
        },
      ];
      await persist(batchId, kind, row.rowNo, null, "skipped", null, rowIssues);
      skipRow(row.rowNo, rowIssues, true);
      continue;
    }

    const created = await createRecord(kind, actor, data, dryRun);
    if (!created.ok) {
      await persist(batchId, kind, row.rowNo, null, "skipped", null, [created.issue]);
      skipRow(row.rowNo, [created.issue]);
      continue;
    }

    /**
     * 写导入行。唯一索引冲突在这里是**并发**（两个标签页同时导同一份文件）：
     * 业务记录已经建出来了，所以这一行**如实记成已导入**，但把重复告警挂上去
     * （`row_hash` 留空 ⇒ 不占幂等键，否则会与赢家那行互撞）。
     * 记成"未导入"会是撒谎——库里确实多了一条。
     */
    const warn: ImportRowIssue[] = [];
    try {
      await persist(batchId, kind, row.rowNo, hash, "imported", created.hostId, null);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      warn.push({
        field: "整行",
        code: "duplicate_row",
        message:
          "并发导入：另一批次已导入同样的内容。本次仍写入了记录，请在列表里核对后删除多余的一条",
      });
      await persist(batchId, kind, row.rowNo, null, "imported", created.hostId, warn);
    }
    seenInRun.set(hash, row.rowNo);
    importedRows += 1;
    for (const w of warn) issues.push({ row: row.rowNo, ...w, imported: true });
  }

  const totalRows = parsed.rows.length;
  /**
   * **恒等式**：`total = imported + error`。
   * 这条断言是防"看起来导进去了、其实少了行"的最后一道 —— 计数对不上就当场抛，
   * 而不是给用户一份自洽但错误的摘要。（逐行累加的三条路径都在上面，漏一条这里就红。）
   */
  if (totalRows !== importedRows + errorRows) {
    throw new Error(
      `导入计数不自洽：文件 ${totalRows} 行，已导入 ${importedRows}，未导入 ${errorRows}`,
    );
  }

  const payload = importAuditPayload({
    hostType: kind,
    totalRows,
    importedRows,
    errorRows,
    reportRef: String(batchId),
  });

  // 「重放」判据见 `alreadyImportedRows` 的声明处
  const replayed = importedRows === 0 && alreadyImportedRows > 0;

  // 收尾：计数、状态、汇总日志**同一个事务** —— 三者描述的是同一件事，
  // 分开写就会出现"日志说导了 812 行、批次记录说 810"。
  // 预检没有批次行可收尾，也不写 `BULK_IMPORT` 汇总（那会被读成"真导过一批"）。
  if (!dryRun) {
    await db.transaction(async (tx) => {
      await tx
        .update(importBatch)
        .set({ totalRows, importedRows, errorRows, status: "completed" })
        .where(eq(importBatch.id, batchId));
      await logActivity(tx, actor, {
        // 与 `PARTY_MERGED` 同一种落点：导入是**账号维度**的汇总动作，不挂任何业务宿主
        // （E03 的 `app_user` 是唯一"无业务宿主"的合法落点，迁移 0006 开的）。
        targetType: "app_user",
        targetId: operator,
        action: "BULK_IMPORT",
        payload,
      });
    });
  }

  return {
    // 预检没落批次：这两个引用指向一个不存在的批次，给空串而不是那个用过的雪花号
    // ——后者会让用户点"下载报告"时撞 404，读起来像"报告丢了"。
    batchId: dryRun ? "" : String(batchId),
    hostType: kind,
    fileName: req.fileName,
    totalRows,
    importedRows,
    errorRows,
    replayed,
    reportRef: dryRun ? "" : String(batchId),
    issues: issues.slice(0, SUMMARY_ISSUE_LIMIT),
    issueTotal: issues.length,
    truncatedIssues: issues.length > SUMMARY_ISSUE_LIMIT,
  };
}

/**
 * 预检时的逐行落库替身：什么都不写。
 *
 * 之所以做到"替身"这一层，是为了让逐行循环**一个字都不分支** ——
 * 一旦在循环里写 `if (!dryRun) await writeRow(...)`，预检与真导就从同一段代码
 * 变成了两段长得像的代码，那正是本票要避免的。
 * 零参箭头可赋给七参的 `RowWriter`（TS 里少写参数是合法协变），所以这里没有
 * 一排用不上的形参，也就不会有 lint 的"未使用变量"。
 */
const noopPersist: RowWriter = async () => {};

/** 逐行落库函数（真导写库 / 预检空转）的签名，两处共用一个 */
type RowWriter = (
  batchId: bigint,
  hostType: ImportKind,
  rowNo: number,
  rowHash: string | null,
  status: "imported" | "skipped",
  hostId: bigint | null,
  rowIssues: readonly ImportRowIssue[] | null,
) => Promise<void>;

/** 三份 DTO 按 kind 分派。写成显式 switch 而不是表：新增 kind 时这里必须一起改，编译期就会提醒 */
function dtoFor(kind: ImportKind) {
  if (kind === "risk_matter") return riskCreateSchema;
  if (kind === "matter") return matterCreateSchema;
  return partyCreateSchema;
}

async function writeRow(
  batchId: bigint,
  hostType: ImportKind,
  rowNo: number,
  rowHash: string | null,
  status: "imported" | "skipped",
  hostId: bigint | null,
  rowIssues: readonly ImportRowIssue[] | null,
): Promise<void> {
  const db = await getDb();
  await db.insert(importRow).values({
    id: BigInt(nextId()),
    batchId,
    hostType,
    rowNo,
    rowHash,
    status,
    hostId,
    // 落库前把字段名换成中文列名：报告是给人读的（见 `labelIssues`）
    issues: rowIssues && rowIssues.length > 0 ? labelIssues(hostType, rowIssues) : null,
  });
}

/** PG 的唯一索引冲突（`uk_mn_import_row_content` 的并发那一路）。postgres.js 把码放在 `code` 上 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

/**
 * 内容键 → 之前导过的那一行。
 *
 * ⚠ 这里**必须**是裸表查询：drizzle 在 select 列表上下文里会把本表的列渲染成**不带限定**
 * 的名字（本仓已因此出过三个真缺陷），一旦写成关联子查询就会解析到内层表而静默恒 NULL。
 * 这条查询只有一个表、没有子查询，所以不受那条陷阱影响 —— 但下一个人若要给它加 join，
 * 请先读 `services/risks.ts` 的 `partyCount` 那段注释。
 */
async function findImportedByHash(
  kind: ImportKind,
  hash: string,
): Promise<{ batchId: string; rowNo: number } | null> {
  const db = await getDb();
  const [hit] = await db
    .select({ batchId: importRow.batchId, rowNo: importRow.rowNo })
    .from(importRow)
    .where(
      and(
        eq(importRow.hostType, kind),
        eq(importRow.rowHash, hash),
        eq(importRow.status, "imported"),
      ),
    )
    .limit(1);
  return hit ? { batchId: String(hit.batchId), rowNo: hit.rowNo } : null;
}

/* ───────────────────────────── 报告与批次 ───────────────────────────── */

/**
 * 错误报告 CSV：**行号 / 字段 / 原因 / 状态**。
 *
 * 前三列就是票面 AC 要的（行号、字段、原因）。第四列是为了让"并发写入"那类
 * **已导入但有告警**的行不至于读起来像"没导进去"——状态一列把两者分开。
 *
 * **不含单元格原值**：当事人行里可能有证件号，而它是加密列；把原值抄进报告
 * 等于给加密开后门（与 `createParty` 不把证件号写进审计载荷同一条禁令）。
 * 用户靠行号回 Excel 找那一格。
 */
export async function importReportCsv(
  batchId: string,
): Promise<{ fileName: string; csv: string } | null> {
  const db = await getDb();
  const [batch] = await db
    .select({
      id: importBatch.id,
      hostType: importBatch.hostType,
      fileName: importBatch.fileName,
    })
    .from(importBatch)
    .where(eq(importBatch.id, BigInt(batchId)))
    .limit(1);
  if (!batch) return null;

  const rows = await db
    .select({
      rowNo: importRow.rowNo,
      status: importRow.status,
      issues: importRow.issues,
    })
    .from(importRow)
    .where(and(eq(importRow.batchId, batch.id), isNotNull(importRow.issues)))
    .orderBy(importRow.rowNo);

  const lines: string[][] = [[...IMPORT_REPORT_HEADER]];
  for (const r of rows) {
    const list = Array.isArray(r.issues) ? (r.issues as ImportRowIssue[]) : [];
    for (const i of list) {
      lines.push([
        String(r.rowNo),
        i.field,
        i.message,
        r.status === "imported" ? "已导入（有告警）" : "未导入",
      ]);
    }
  }
  const label = IMPORT_KIND_LABELS[batch.hostType as ImportKind] ?? batch.hostType;
  return { fileName: `${label}导入错误报告-${batchId}.csv`, csv: csvText(lines) };
}

/** 最近几次导入（报告入口的数据源）。L1 独占，所以不做行级可见性收窄 */
export async function listImportBatches() {
  const db = await getDb();
  const rows = await db
    .select({
      id: importBatch.id,
      hostType: importBatch.hostType,
      fileName: importBatch.fileName,
      totalRows: importBatch.totalRows,
      importedRows: importBatch.importedRows,
      errorRows: importBatch.errorRows,
      status: importBatch.status,
      createdAt: importBatch.createdAt,
    })
    .from(importBatch)
    .orderBy(desc(importBatch.createdAt), desc(importBatch.id))
    .limit(IMPORT_BATCH_LIST_LIMIT);
  return {
    items: rows.map((r) => ({ ...r, id: String(r.id), reportRef: String(r.id) })),
  };
}

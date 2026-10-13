import { z } from "zod";
import {
  CASE_TYPES,
  CASE_TYPE_LABELS,
  CASE_TYPES_WRITABLE,
  ID_TYPES,
  ID_TYPE_LABELS,
  LITIGATION_ROLES,
  LITIGATION_ROLE_LABELS,
  PARTY_TYPES,
  PARTY_TYPE_LABELS,
  PROCEDURES,
  PROCEDURE_LABELS,
  RISK_MATTER_SOURCES,
  RISK_MATTER_SOURCE_LABELS,
  RISK_MATTER_SOURCES_WRITABLE,
  RISK_MATTER_TYPES,
  RISK_MATTER_TYPE_LABELS,
} from "@/shared/enums/business";
import { IMPORT_KINDS, type ImportIssueCode, type ImportKind } from "@/shared/enums/import";

/**
 * 批量导入（F7-4 / M7 US-M7-1）的**模板与逐行解析**——本文件是纯 TS，不含任何 DB 读取。
 *
 * ## 三件事在这里，因为它们必须能被机器核对
 *
 * 1. **模板列规格**（`IMPORT_TEMPLATES`）：每列的字段名、表头文字、是否必填、值域来源。
 *    枚举列写 `enumId`（E12…E18），于是 `import.spec.ts` 能把"模板允许填什么"
 *    与 `ENUM_REGISTRY` 逐条对拉 —— 这正是票面要的"模板字段与枚举取值一致**能被机器检查**"。
 *    只写在文档里的一致性会漂：`E13` 的 `non_litigation`、`E16` 的 `customer_complaint`
 *    都是**作废但仍在库**的值（§5.3 禁止从 CHECK 删值），模板一旦照抄全集就会把作废值
 *    重新放进用户手里。所以规格里存的是 `*_WRITABLE`，spec 里有一条专门钉它。
 * 2. **CSV 解析与表头校验**：结构错误（表头不认识、必填列缺失、编码不对）是**文件级**拒绝，
 *    值错误是**行级**跳过。两者的分界线就是本文件的 `parseImportFile`。
 * 3. **逐行构建**（`buildImportRow`）：单元格 → 落库入参。这里做的是**语义**解析
 *    （枚举中文名 → 码、日期/金额归一、处理人姓名 → id、当事人拆分），
 *    **格式**校验仍由 `shared/schema/hosts.ts` 的既有 DTO 在服务层跑一遍
 *    （禁令⑧：校验规则单源）。两层不重叠：这里只管"这一格说的是什么"，
 *    DTO 管"这个值合不合规"。
 *
 * ## 为什么不自己写一份 CSV 编码
 *
 * 编码（`csvCell`/`csvText`）与解析必须是一对，而编码那份**已经在**服务端
 * （`services/exports.ts`，整卷导出与当事人导出共用）。在 shared 里再写一份就是
 * 第二份实现 —— 失败形态是"导出的文件自己能读、别人给的文件读不了"，两边都不报错。
 * 所以本文件只出**单元格矩阵**（`templateRows`），拼文本由服务层用同一份 `csvText` 完成。
 */

/* ───────────────────────────── 列规格 ───────────────────────────── */

/**
 * 列的值形态。`enum` 与 `config` 的区别是**值域来源**（枚举表 vs 配置表），
 * 不是"像不像枚举"：配置驱动的值域运营可以改，所以模板的说明行要按当前配置现算。
 */
export type ImportColumnKind =
  "text" | "date" | "amount" | "enum" | "config" | "user" | "partyNames" | "partyIds";

export type ImportColumn = {
  /** 目标字段名，与落库入参/DTO 同名；报告里的「字段」列直接用它 */
  field: string;
  /** 表头文字（**不含**必填星号，星号由 `headerOf` 加） */
  label: string;
  required: boolean;
  kind: ImportColumnKind;
  /** `kind === "enum"` 时：枚举表行号（E12…E18）。spec 据此对拉注册表 */
  enumId?: string;
  /** 可写入子集（去掉作废值）。缺省 = 该枚举全集 */
  writable?: readonly string[];
  /** 说明行里这一列的文字（取值清单由生成器追加，不写在这里） */
  hint?: string;
};

/** 当事人五列在两条宿主模板里是同一组（字段名前缀 `parties[]`），抽出来避免抄两遍 */
const PARTY_COLUMNS: readonly ImportColumn[] = [
  {
    field: "parties[].name",
    label: "对方当事人",
    required: false,
    kind: "partyNames",
    hint: "多个用「、」分隔",
  },
  {
    field: "parties[].idNumber",
    label: "对方当事人证件号",
    required: false,
    kind: "partyIds",
    hint: "与「对方当事人」按位置对应；对应不上的留空占位",
  },
  {
    field: "parties[].type",
    label: "当事人类型",
    required: false,
    kind: "enum",
    enumId: "E17",
    hint: "整行当事人共用；留空按「法人」",
  },
  {
    field: "parties[].idType",
    label: "对方证件类型",
    required: false,
    kind: "enum",
    enumId: "E18",
    hint: "整行当事人共用；留空则不记证件类型",
  },
  {
    field: "parties[].partyRole",
    label: "对方诉讼地位",
    required: false,
    kind: "enum",
    enumId: "E12",
    hint: "整行当事人共用；留空按「其他」",
  },
];

/** 三张模板的列规格。顺序 = 模板列顺序，也是报告里字段的出现顺序 */
export const IMPORT_TEMPLATES: Record<ImportKind, readonly ImportColumn[]> = {
  risk_matter: [
    { field: "name", label: "事项名称", required: true, kind: "text" },
    { field: "type", label: "风险类型", required: true, kind: "enum", enumId: "E15" },
    { field: "level", label: "风险等级", required: true, kind: "config" },
    { field: "discoverDate", label: "发现日期", required: false, kind: "date" },
    {
      field: "source",
      label: "来源",
      required: false,
      kind: "enum",
      enumId: "E16",
      writable: RISK_MATTER_SOURCES_WRITABLE,
    },
    { field: "amount", label: "涉及金额", required: false, kind: "amount" },
    { field: "description", label: "风险描述", required: true, kind: "text" },
    { field: "measure", label: "处置措施", required: false, kind: "text" },
    {
      field: "ownerId",
      label: "处理人",
      required: false,
      kind: "user",
      hint: "填账号或姓名；留空 = 未指派处理人",
    },
    ...PARTY_COLUMNS,
  ],
  matter: [
    { field: "name", label: "案件名称", required: true, kind: "text" },
    { field: "cause", label: "案由", required: true, kind: "text" },
    {
      field: "caseType",
      label: "案件类型",
      required: true,
      kind: "enum",
      enumId: "E13",
      writable: CASE_TYPES_WRITABLE,
    },
    { field: "procedure", label: "审级程序", required: true, kind: "enum", enumId: "E14" },
    { field: "litigationRole", label: "我方诉讼地位", required: true, kind: "enum", enumId: "E12" },
    { field: "court", label: "受理法院", required: false, kind: "text" },
    { field: "caseNo", label: "案号", required: false, kind: "text", hint: "留空则取内部编号" },
    { field: "filingDate", label: "立案日期", required: false, kind: "date" },
    { field: "amount", label: "标的额", required: false, kind: "amount" },
    { field: "level", label: "风险等级", required: true, kind: "config" },
    { field: "description", label: "案件描述", required: false, kind: "text" },
    {
      field: "ownerId",
      label: "处理人",
      required: true,
      kind: "user",
      hint: "案件必须有处理人，填账号或姓名",
    },
    ...PARTY_COLUMNS,
  ],
  party: [
    { field: "name", label: "当事人名称", required: true, kind: "text" },
    { field: "type", label: "当事人类型", required: true, kind: "enum", enumId: "E17" },
    { field: "idType", label: "证件类型", required: false, kind: "enum", enumId: "E18" },
    { field: "idNumber", label: "证件号", required: false, kind: "text" },
    { field: "contact", label: "联系方式", required: false, kind: "text" },
    { field: "remark", label: "备注", required: false, kind: "text" },
  ],
};

/**
 * 说明行的哨兵。**整行第一格逐字等于它**才被跳过 —— 不用"以 # 开头"那种模糊约定：
 * 真实数据里出现这个串的概率是零，而"以 # 开头"会静默吃掉一行的第一格。
 */
export const IMPORT_HINT_MARKER = "※说明行（导入时自动跳过）";

/** 表头文字：必填列加 `*`。加星号的是这里，认星号的是 `normalizeHeaderCell`，同一处 */
export function headerOf(column: ImportColumn): string {
  return column.required ? `${column.label}*` : column.label;
}

/** 一次导入最多多少数据行（schema 层拦，不只在界面上拦：界面拦不住手写的 POST） */
export const MAX_IMPORT_ROWS = 1000;

/** 请求体里 CSV 文本的硬上限（字符）。1000 行 × 每行数百字符，留足余量 */
export const MAX_IMPORT_CSV_CHARS = 2_000_000;

/** 一批导入的文件名长度上限（与 `varchar(200)` 同源） */
const MAX_FILE_NAME = 200;

export const importRequestSchema = z
  .object({
    /**
     * ⚠ 键名沿用枚举表 §3.5 `BULK_IMPORT` 载荷的 `host_type`（那是审计查询契约，
     * 不该为了这一处措辞改）。值域是 `IMPORT_KINDS` 三值 —— 其中 `party` **没有宿主**
     * （当事人档案是跨宿主共享实体）。列名与值域的这一处错位是继承文档键名的代价，
     * 比让审计载荷换个键名便宜；理由同时写在 `db/schema/import.ts` 的列注释上。
     */
    hostType: z.enum(IMPORT_KINDS, { message: "请选择要导入的模板类型" }),
    fileName: z.string().trim().min(1, "缺少文件名").max(MAX_FILE_NAME),
    csv: z.string().min(1, "文件是空的").max(MAX_IMPORT_CSV_CHARS, "文件太大，请拆成多次导入"),
  })
  // `.strict()`：zod 默认静默剥离未知键，而这里最危险的一种客户端 bug 是把 `csv`
  // 写成 `content` —— 默认形态会把它悄悄丢掉，请求照样 400 说"文件是空的"，
  // 排查方向却指向文件而不是字段名。
  .strict();
export type ImportRequest = z.infer<typeof importRequestSchema>;

/* ───────────────────────────── CSV 解析 ───────────────────────────── */

export type CsvRecord = { rowNo: number; cells: string[] };

/**
 * RFC 4180 解析：引号包裹、`""` 转义、引号内的换行与逗号、CRLF/LF、BOM。
 *
 * `rowNo` 是**逻辑行号**（从 1 起），不是物理行号：一格里有换行时两者会分开，
 * 而用户在 Excel 里看到的是逻辑行 —— 报告里的行号必须是他能对上的那个。
 */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  let rowNo = 1;
  let touched = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      touched = true;
      i++;
      continue;
    }
    if (ch === ",") {
      cells.push(cur);
      cur = "";
      touched = true;
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      cells.push(cur);
      out.push({ rowNo, cells });
      rowNo++;
      cells = [];
      cur = "";
      touched = false;
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cur += ch;
    touched = true;
    i++;
  }
  // 末行没有换行符时才收尾。`touched` 挡住"文件以换行结尾"产生的幽灵空行。
  if (touched || cur !== "" || cells.length > 0) {
    cells.push(cur);
    out.push({ rowNo, cells });
  }
  return out;
}

/** 表头格归一：去空白、去必填星号（用户会把它删掉，也会有人保留） */
export function normalizeHeaderCell(raw: string): string {
  return raw
    .replace(/[\u3000\s]+/g, "")
    .replace(/[*＊]+$/, "")
    .trim();
}

const isBlankCells = (cells: readonly string[]) => cells.every((c) => c.trim() === "");
const isHintRow = (cells: readonly string[]) => (cells[0] ?? "").trim() === IMPORT_HINT_MARKER;

export type ImportFileProblemCode =
  | "bad_encoding"
  | "empty_file"
  | "bad_header"
  | "unknown_column"
  | "missing_column"
  | "too_many_rows";

export type ImportFileProblem = { code: ImportFileProblemCode; message: string };
export type ImportFileRow = { rowNo: number; cells: string[] };

/**
 * 文件级解析：**结构错误在这里一次性拒掉**（表头不认识、必填列缺失、编码不是 UTF-8、
 * 行数超上限），值错误留给逐行处理。
 *
 * 为什么结构错误不能"逐行跳过"：不知道哪一列是什么，任何一行都无从解释。
 * 拒掉整份文件在这里不是"全有全无"，而是"这份文件不是我们的模板"。
 *
 * 返回的 `cells` 已经**按模板列顺序重排**（文件里列顺序可以不同，表头认得出就行）。
 */
export function parseImportFile(
  kind: ImportKind,
  text: string,
  opts: { maxRows?: number } = {},
): { ok: true; rows: ImportFileRow[] } | { ok: false; problem: ImportFileProblem } {
  const maxRows = opts.maxRows ?? MAX_IMPORT_ROWS;

  /**
   * Excel 在 Windows 上"另存为 CSV"默认写 ANSI/GBK，读成 UTF-8 就是一片 U+FFFD。
   * 不提前识别的话，症状是"表头里有不认识的列：����" —— 用户会去改表头，
   * 而真正要改的是保存格式。所以这一条单独一个码、单独一句话。
   */
  if (text.includes("\uFFFD")) {
    return {
      ok: false,
      problem: {
        code: "bad_encoding",
        message:
          "文件不是 UTF-8 编码（Excel 在 Windows 上默认存成 ANSI/GBK）。请用「另存为 → CSV UTF-8（逗号分隔）」重新导出后再上传。",
      },
    };
  }

  const records = parseCsv(text);
  if (records.length === 0) {
    return { ok: false, problem: { code: "empty_file", message: "文件里没有任何内容" } };
  }

  // 表头 = 第一条既非空行、也非说明行的记录。这样"用户把说明行删了"与"说明行还在"
  // 两种文件都能读，而不是假设表头恒在第 1 行。
  let cursor = 0;
  while (cursor < records.length) {
    const r = records[cursor] as CsvRecord;
    if (!isBlankCells(r.cells) && !isHintRow(r.cells)) break;
    cursor++;
  }
  const header = records[cursor];
  if (!header) {
    return { ok: false, problem: { code: "empty_file", message: "文件里只有空行" } };
  }

  const columns = IMPORT_TEMPLATES[kind];
  const byLabel = new Map(columns.map((c) => [normalizeHeaderCell(c.label), c]));
  const index = new Map<string, number>();
  const unknown: string[] = [];
  for (const [i, raw] of header.cells.entries()) {
    const key = normalizeHeaderCell(raw);
    if (key === "") continue;
    if (!byLabel.has(key)) {
      unknown.push(raw.trim());
      continue;
    }
    const field = (byLabel.get(key) as ImportColumn).field;
    if (index.has(field)) {
      return {
        ok: false,
        problem: { code: "bad_header", message: `表头里「${key}」出现了两次，无法判断用哪一列` },
      };
    }
    index.set(field, i);
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      problem: {
        code: "unknown_column",
        message: `表头里有本模板不认识的列：${unknown.join("、")}。请下载对应模板后在其表头上填写（多出来的列请删掉——留着会被当成已导入，实际没有）。`,
      },
    };
  }
  const missing = columns.filter((c) => c.required && !index.has(c.field)).map((c) => c.label);
  if (missing.length > 0) {
    return {
      ok: false,
      problem: {
        code: "missing_column",
        message: `表头里缺少必填列：${missing.join("、")}。请下载对应模板填写。`,
      },
    };
  }

  const rows: ImportFileRow[] = [];
  for (let i = cursor + 1; i < records.length; i++) {
    const r = records[i] as CsvRecord;
    if (isBlankCells(r.cells) || isHintRow(r.cells)) continue;
    const cells = columns.map((c) => {
      const at = index.get(c.field);
      return at === undefined ? "" : (r.cells[at] ?? "").trim();
    });
    rows.push({ rowNo: r.rowNo, cells });
  }
  if (rows.length > maxRows) {
    return {
      ok: false,
      problem: {
        code: "too_many_rows",
        message: `一次最多导入 ${maxRows} 行，这份文件有 ${rows.length} 行。请拆成多个文件分批导入。`,
      },
    };
  }
  return { ok: true, rows };
}

/* ───────────────────────────── 单元格归一 ───────────────────────────── */

/** 多值分隔符：中文顿号/逗号、半角逗号、分号（全/半角）。中文名里出现这些的概率极低 */
const MULTI_SEP = /[、,，;；]/;

export function splitMulti(raw: string): string[] {
  return raw
    .split(MULTI_SEP)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * 日期归一：`2024-01-05` / `2024-1-5` / `2024/1/5` / `2024.1.5` / `2024年1月5日` → `2024-01-05`。
 *
 * 为什么容错：Excel 会把用户输入的日期按单元格格式重排，同一个日期在不同人手里
 * 导出成 `2024/1/5` 或 `2024-01-05`。为此让整行失败是**把格式问题伪装成数据问题**。
 * 但归一之后仍然逐字校验形状 —— 容错的是写法，不是正确性。
 */
export function normalizeDate(raw: string): string | null {
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // 用 UTC 构造再回读，挡住 2 月 30 日这类"形状对、日期不存在"的输入
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 金额归一：去掉千分位、货币符号与「元」，去空白 → 数字字符串（最多两位小数）。
 *
 * ⚠ 全程**字符串**处理，一次 `Number()` 都没有（票面口径：金额列 `numeric(18,2)`，
 * `Number` 在 18 位有效数字上会静默丢精度，而丢掉的恰好是分位）。
 */
export function normalizeAmount(raw: string): string | null {
  const s = raw
    .replace(/[\s\u3000]/g, "")
    .replace(/[¥￥]/g, "")
    .replace(/元$/, "")
    .replace(/,/g, "");
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return s;
}

/* ───────────────────────────── 取值解析 ───────────────────────────── */

export type EnumOption = { value: string; label: string };

/**
 * 枚举的**取值来源表**：`enumId` → 全集与中文名，**逐字镜像注册表**。
 *
 * 为什么写成显式映射而不是 import `ENUM_REGISTRY`：注册表在 `shared/enums/index.ts`，
 * 而它要引 schema 层的值域（见 `enums/import.ts`）——`schema/import.ts` 反过来引它就会成环。
 * 代价是这张表要与注册表同步，所以 `import.spec.ts` 用 `ENUM_REGISTRY` **逐行对拉它**
 * （值集合与中文名都比），漂了当场红。
 *
 * ⚠ 这里存的是**全集**（含作废值），过滤只发生在列规格的 `writable` 上 ——
 * 两处都过滤就是第二份"哪些值作废"的定义。
 */
const ENUM_SOURCE: Readonly<
  Record<string, { values: readonly string[]; labels: Readonly<Record<string, string>> }>
> = {
  E12: { values: LITIGATION_ROLES, labels: LITIGATION_ROLE_LABELS },
  E13: { values: CASE_TYPES, labels: CASE_TYPE_LABELS },
  E14: { values: PROCEDURES, labels: PROCEDURE_LABELS },
  E15: { values: RISK_MATTER_TYPES, labels: RISK_MATTER_TYPE_LABELS },
  E16: { values: RISK_MATTER_SOURCES, labels: RISK_MATTER_SOURCE_LABELS },
  E17: { values: PARTY_TYPES, labels: PARTY_TYPE_LABELS },
  E18: { values: ID_TYPES, labels: ID_TYPE_LABELS },
};

/** spec 用：本文件镜像了哪些枚举行 */
export const ENUM_IDS_USED = Object.keys(ENUM_SOURCE);

/** spec 用：`enumId` → 本文件认为的**全集**与中文名（对拉 `ENUM_REGISTRY` 的那一半） */
export function enumSourceOf(
  enumId: string,
): { values: readonly string[]; labels: Readonly<Record<string, string>> } | undefined {
  return ENUM_SOURCE[enumId];
}

/**
 * 某一列允许填的取值（码 + 中文名）。**唯一实现**：模板的说明行、逐行解析、
 * spec 的机器检查都从这里取，三处各写一遍必然漂。
 */
export function enumOptionsOf(column: ImportColumn): EnumOption[] {
  const src = ENUM_SOURCE[column.enumId ?? ""];
  if (!src) return [];
  const values = column.writable ?? src.values;
  return values.map((value) => ({ value, label: src.labels[value] ?? value }));
}

/**
 * 一格文本 → 枚举码。接受**中文名**与**英文码**两种写法（用户会从旧台账里抄中文，
 * 也会从别处粘 `contract`）。作废值（`non_litigation`/`customer_complaint`）不在
 * `writable` 里，因此这里天然拒收 —— spec 有一条专门钉它。
 */
export function resolveEnumToken(column: ImportColumn, raw: string): string | null {
  const token = raw.trim();
  if (token === "") return null;
  for (const opt of enumOptionsOf(column)) {
    if (token === opt.value || token === opt.label) return opt.value;
  }
  return null;
}

/**
 * 说明行里**取值清单**的分隔符。
 *
 * 为什么不是 `/`：取值本身会带 `/` —— E16 的 `external_dispute` 中文名是「对外纠纷/投诉」，
 * 于是说明行会写成 `业务报备/对外纠纷/投诉/收到对方当事人律师函/…`，其中「投诉」
 * 看起来就是一个可填的值。用户抄它 ⇒ `unknown_enum`（报告会列出全部取值，能自愈，
 * 但白跑一次）。顿号与本仓其余"列举中文项"的写法一致（`join("、")` 十处），
 * 且**当前没有任何取值含它**。
 *
 * ⚠ 这个常量是契约的一半：`import.spec.ts` 有一条断言按它把说明行切开，
 * 切出的**每一段都必须在注册表取值里** —— 谁把它换成会出现在取值里的字符，那条当场红。
 */
export const VALUE_LIST_SEP = "、";

/** 取值清单（说明行用）。例：`取值：合同、劳动争议、…、其他（可填中文名或英文码）` */
export function enumValueHint(column: ImportColumn): string {
  const names = enumOptionsOf(column).map((o) => o.label);
  return `取值：${names.join(VALUE_LIST_SEP)}（可填中文名或英文码）`;
}

/* ───────────────────────────── 逐行构建 ───────────────────────────── */

export type ImportRowIssue = { field: string; code: ImportIssueCode; message: string };

/** 逐行解析的外部依赖。**注入**而不是在这里查库：本文件保持纯函数，spec 可离线跑 */
export type ImportDeps = {
  /** 启用的风险等级（配置驱动，枚举表 §0） */
  levels: readonly { code: string; name: string }[];
  /** 在册且已开通的用户（`listUsersForCreate` 的结果） */
  users: readonly { id: string; username: string; displayName: string }[];
};

export type ImportPartyCandidate = {
  name: string;
  type: string;
  partyRole: string;
  idType?: string;
  idNumber?: string;
};

export type RiskImportRow = {
  name: string;
  type: string;
  level: string;
  description: string;
  source?: string;
  measure?: string;
  amount?: string;
  discoverDate?: string;
  ownerId?: string;
  parties: ImportPartyCandidate[];
};

export type MatterImportRow = {
  name: string;
  cause: string;
  caseType: string;
  procedure: string;
  litigationRole: string;
  level: string;
  ownerId: string;
  court?: string;
  caseNo?: string;
  filingDate?: string;
  amount?: string;
  description?: string;
  parties: ImportPartyCandidate[];
};

export type PartyImportRow = {
  name: string;
  type: string;
  idType?: string;
  idNumber?: string;
  contact?: string;
  remark?: string;
};

export type ImportRowInput = RiskImportRow | MatterImportRow | PartyImportRow;
export type ImportRowResult<T> = { ok: true; input: T } | { ok: false; issues: ImportRowIssue[] };

/**
 * 单元格读取器：**每一格只解析一次**（结果按字段记忆）。
 *
 * 为什么必须记忆：构建一行时同一格会被问两次很常见（"非空才带上"与"带上它的值"），
 * 而每次问都可能推一条问题 —— 重复推的后果是错误报告里同一行同一个字段出现两遍，
 * 用户会以为有两处要改。
 */
type CellReader = {
  issues: ImportRowIssue[];
  /** 文本；`required` 且为空时推一条 `required` */
  text: (field: string, required?: boolean) => string;
  enumCode: (field: string) => string | null;
  date: (field: string) => string | undefined;
  amount: (field: string) => string | undefined;
  user: (field: string, deps: ImportDeps) => string | null;
  /** 列的中文名（报错文案用）。`kind` 决定查哪张模板 —— 三个模板里有同名字段（`type`/`name`） */
  label: (field: string) => string;
  /** 推一条问题（去重：同字段同码只留第一条） */
  push: (issue: ImportRowIssue) => void;
};

function readerFor(kind: ImportKind, cells: readonly string[]): CellReader {
  const columns = IMPORT_TEMPLATES[kind];
  const at = new Map(columns.map((c, i) => [c.field, i]));
  const byField = new Map(columns.map((c) => [c.field, c]));
  const issues: ImportRowIssue[] = [];
  const rawOf = (field: string) => cells[at.get(field) ?? -1] ?? "";

  const push = (issue: ImportRowIssue) => {
    if (issues.some((i) => i.field === issue.field && i.code === issue.code)) return;
    issues.push(issue);
  };

  const memo = new Map<string, unknown>();
  const once = <T>(key: string, make: () => T): T => {
    if (memo.has(key)) return memo.get(key) as T;
    const v = make();
    memo.set(key, v);
    return v;
  };

  return {
    issues,
    push,
    label: (field) => byField.get(field)?.label ?? field,
    text(field, required = false) {
      return once(`text:${field}:${required}`, () => {
        const v = rawOf(field).trim();
        if (v === "" && required) {
          push({
            field,
            code: "required",
            message: `「${byField.get(field)?.label ?? field}」是必填列，这一行没填`,
          });
        }
        return v;
      });
    },
    enumCode(field) {
      return once(`enum:${field}`, () => {
        const v = rawOf(field).trim();
        if (v === "") return null;
        const column = byField.get(field);
        if (!column) return null;
        const code = resolveEnumToken(column, v);
        if (code === null) {
          push({
            field,
            code: "unknown_enum",
            message: `「${column.label}」不认识「${v}」。${enumValueHint(column)}`,
          });
        }
        return code;
      });
    },
    date(field) {
      return once(`date:${field}`, () => {
        const v = rawOf(field).trim();
        if (v === "") return undefined;
        const norm = normalizeDate(v);
        if (norm === null) {
          push({
            field,
            code: "invalid_field",
            message: `日期「${v}」读不出来，请写成 2024-01-05 这样的格式`,
          });
          return undefined;
        }
        return norm;
      });
    },
    amount(field) {
      return once(`amount:${field}`, () => {
        const v = rawOf(field).trim();
        if (v === "") return undefined;
        const norm = normalizeAmount(v);
        if (norm === null) {
          push({
            field,
            code: "invalid_field",
            message: `金额「${v}」读不出来，请填数字（最多两位小数，可带千分位）`,
          });
          return undefined;
        }
        return norm;
      });
    },
    user(field, deps) {
      return once(`user:${field}`, () => {
        const token = rawOf(field).trim();
        if (token === "") return null;
        const hits = deps.users.filter((u) => u.username === token || u.displayName === token);
        if (hits.length === 0) {
          push({
            field,
            code: "unknown_user",
            message: `处理人「${token}」在在册且已开通的用户里找不到（可填账号或姓名）`,
          });
          return null;
        }
        if (hits.length > 1) {
          push({
            field,
            code: "ambiguous_user",
            message: `处理人「${token}」对应 ${hits.length} 个账号（${hits
              .map((h) => h.username)
              .join("、")}），请改填账号`,
          });
          return null;
        }
        return (hits[0] as { id: string }).id;
      });
    },
  };
}

/** 当事人：名称（多值）+ 证件号（多值，按位置对应）+ 共用的类型/证件类型/地位 */
function buildParties(r: CellReader): ImportPartyCandidate[] {
  const names = splitMulti(r.text("parties[].name"));
  const ids = splitMulti(r.text("parties[].idNumber"));
  if (ids.length > names.length) {
    r.push({
      field: "parties[].idNumber",
      code: "party_mismatch",
      message: `证件号有 ${ids.length} 个，当事人只有 ${names.length} 个 —— 两列按位置对应，证件号不能比当事人多`,
    });
    return [];
  }
  if (names.length === 0) return [];
  /**
   * 类型 / 证件类型 / 诉讼地位是**整行共用**的（一行一份，不做逐人对应）：
   * 逐人对应要靠第二组位置配对，而历史台账里绝大多数行只有一个对手方。
   * 留空给文档化的默认值 —— 类型按「法人」（对手方绝大多数是企业）、
   * 地位按「其他」（事项阶段本来还没有诉讼地位）。
   */
  const type = r.enumCode("parties[].type") ?? "legal_person";
  const partyRole = r.enumCode("parties[].partyRole") ?? "other";
  const idType = r.enumCode("parties[].idType");
  return names.map((name, i) => ({
    name,
    type,
    partyRole,
    ...(idType ? { idType } : {}),
    ...(ids[i] ? { idNumber: ids[i] as string } : {}),
  }));
}

/** 风险等级：配置驱动，按 code 或 name 匹配当前启用项 */
function levelOf(r: CellReader, deps: ImportDeps): string {
  const v = r.text("level", true);
  if (v === "") return "";
  const hit = deps.levels.find((l) => l.code === v || l.name === v);
  if (!hit) {
    r.push({
      field: "level",
      code: "unknown_config",
      message: `风险等级「${v}」不在启用的配置项里。可选：${deps.levels
        .map((l) => `${l.name}（${l.code}）`)
        .join(VALUE_LIST_SEP)}`,
    });
    return "";
  }
  return hit.code;
}

/** 必填的枚举列：空值本身要报 `required`（`enumCode` 对空值静默返回 null） */
function requiredEnum(r: CellReader, field: string): string {
  const code = r.enumCode(field);
  if (code !== null) return code;
  if (r.text(field) === "") {
    r.push({ field, code: "required", message: `「${r.label(field)}」是必填列，这一行没填` });
  }
  return "";
}

/**
 * 逐行构建的**唯一入口**。返回 `{ok:false, issues}` 时该行被跳过（进错误报告），
 * 但**同一行的所有问题都会收集齐**：一次只报一个错会让用户改 N 遍。
 */
export function buildImportRow(
  kind: "risk_matter",
  cells: readonly string[],
  deps: ImportDeps,
): ImportRowResult<RiskImportRow>;
export function buildImportRow(
  kind: "matter",
  cells: readonly string[],
  deps: ImportDeps,
): ImportRowResult<MatterImportRow>;
export function buildImportRow(
  kind: "party",
  cells: readonly string[],
  deps: ImportDeps,
): ImportRowResult<PartyImportRow>;
export function buildImportRow(
  kind: ImportKind,
  cells: readonly string[],
  deps: ImportDeps,
): ImportRowResult<ImportRowInput>;
export function buildImportRow(
  kind: ImportKind,
  cells: readonly string[],
  deps: ImportDeps,
): ImportRowResult<ImportRowInput> {
  const r = readerFor(kind, cells);

  if (kind === "party") {
    const idType = r.enumCode("idType");
    const idNumber = r.text("idNumber");
    const contact = r.text("contact");
    const remark = r.text("remark");
    const input: PartyImportRow = {
      name: r.text("name", true),
      type: requiredEnum(r, "type"),
      ...(idType ? { idType } : {}),
      ...(idNumber ? { idNumber } : {}),
      ...(contact ? { contact } : {}),
      ...(remark ? { remark } : {}),
    };
    return r.issues.length > 0 ? { ok: false, issues: r.issues } : { ok: true, input };
  }

  /**
   * 案件的「处理人」必填（IQ-6）：先跑必填检查，再解析成账号 —— 与其余必填列同一形状。
   * 事项侧不跑这一步：经办人可空（IQ-5），空 = 未指派处理人。
   *
   * ⚠ 下面 matter 分支里 `ownerId: ownerId ?? ""` 的 `?? ""` **是这道防线的一半**：
   *   它让"没解析出处理人"变成空串，而 DTO 的 id 正则（`^\d+$`）会拒掉空串，
   *   于是案件永远走不到 `createMatter` 的"缺省回落操作人"那条路。
   *   顺手改成"空就不带这个键"会让 `.optional()` 放行 undefined —— 见
   *   `services/import.ts` 里 `createRecord` 的 matter 分支那段注释。
   */
  if (kind === "matter") r.text("ownerId", true);
  const ownerId = r.user("ownerId", deps);
  const parties = buildParties(r);
  const level = levelOf(r, deps);
  const amount = r.amount("amount");

  if (kind === "risk_matter") {
    const source = r.enumCode("source");
    const measure = r.text("measure");
    const discoverDate = r.date("discoverDate");
    const input: RiskImportRow = {
      name: r.text("name", true),
      type: requiredEnum(r, "type"),
      level,
      description: r.text("description", true),
      ...(source ? { source } : {}),
      ...(measure ? { measure } : {}),
      ...(amount ? { amount } : {}),
      ...(discoverDate ? { discoverDate } : {}),
      ...(ownerId ? { ownerId } : {}),
      parties,
    };
    return r.issues.length > 0 ? { ok: false, issues: r.issues } : { ok: true, input };
  }

  const caseType = requiredEnum(r, "caseType");
  const procedure = requiredEnum(r, "procedure");
  const litigationRole = requiredEnum(r, "litigationRole");
  const court = r.text("court");
  const caseNo = r.text("caseNo");
  const filingDate = r.date("filingDate");
  const description = r.text("description");
  const input: MatterImportRow = {
    name: r.text("name", true),
    cause: r.text("cause", true),
    caseType,
    procedure,
    litigationRole,
    level,
    ownerId: ownerId ?? "",
    ...(court ? { court } : {}),
    ...(caseNo ? { caseNo } : {}),
    ...(filingDate ? { filingDate } : {}),
    ...(amount ? { amount } : {}),
    ...(description ? { description } : {}),
    parties,
  };
  return r.issues.length > 0 ? { ok: false, issues: r.issues } : { ok: true, input };
}

/* ───────────────────────────── 模板生成 ───────────────────────────── */

/**
 * 模板的**单元格矩阵**：表头行 + 说明行。拼 CSV 文本由服务层用 `csvText` 做
 * （理由见文件头"为什么不自己写一份 CSV 编码"）。
 *
 * 说明行里带取值清单，所以模板是**自解释**的：用户不必回来查文档就知道能填什么。
 * 不带示例数据行 —— 示例行会被真的导进去，而"模板本身就是一份可导入文件"这件事
 * 比"看一眼例子"值钱得多。
 */
export function templateRows(kind: ImportKind, deps: ImportDeps): string[][] {
  const columns = IMPORT_TEMPLATES[kind];
  const header = columns.map(headerOf);
  const hint = columns.map((c) => {
    const parts: string[] = [];
    if (c.required) parts.push("必填");
    if (c.kind === "enum") parts.push(enumValueHint(c));
    if (c.kind === "config") {
      parts.push(
        `取值：${deps.levels
          .map((l) => `${l.name}（${l.code}）`)
          .join(VALUE_LIST_SEP)}（按配置表启用的等级）`,
      );
    }
    if (c.kind === "date") parts.push("YYYY-MM-DD（也接受 2024/1/5 这类写法）");
    if (c.kind === "amount") parts.push("数字，最多两位小数");
    if (c.kind === "user") parts.push("在册且已开通的用户");
    if (c.hint) parts.push(c.hint);
    return parts.join("；");
  });
  return [header, [IMPORT_HINT_MARKER, ...hint.slice(1)]];
}

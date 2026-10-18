import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matterCreateSchema, riskCreateSchema } from "@/shared/schema/hosts";
import type { ImportKind } from "@/shared/enums/import";
import {
  IMPORT_TEMPLATES,
  buildImportRow,
  parseImportFile,
  templateRows,
  type ImportDeps,
} from "@/shared/schema/import";
import { stripTsComments } from "../../../../../tools/lint-guard/strip-comments.mjs";
import { csvText } from "./exports";
import { IMPORT_REPORT_HEADER, importAuditPayload, reportFieldLabel, rowHashOf } from "./import";
import { partyCreateSchema } from "./parties";

/**
 * 服务层这一半的断言。分三组，各钉一件在 shared 那侧**做不到**的事：
 *
 *   1. **必填列是够的**：模板的必填列填满之后，必须能过既有 DTO ——
 *      这条证明"模板没有漏掉某个 DTO 要求的字段"，而漏掉的后果是**每一行都失败**
 *      （用户在导入时才发现，且报告会说"请输入案由"这种他明明填了的话）。
 *   2. **模板 → CSV → 解析**的往返：编码与服务端那份 `csvText` 同源（shared 层
 *      引不到它，所以这条只能在这里）。往返失败意味着"我们生成的模板，我们自己读不了"。
 *   3. **载荷与报告的形状**：`BULK_IMPORT` 的载荷键是审计查询契约，报告列是 AC 逐字要求的。
 */
const deps: ImportDeps = {
  levels: [{ code: "high", name: "高" }],
  users: [{ id: "9001", username: "sunyi", displayName: "孙奕" }],
};

/** 每张模板的"只填必填列"最小行 —— 键是字段名，值是用户会写的**中文名** */
const MINIMAL: Record<ImportKind, Record<string, string>> = {
  risk_matter: { name: "某合同纠纷", type: "合同", level: "高", description: "对方拖欠货款" },
  matter: {
    name: "某买卖合同案",
    cause: "买卖合同纠纷",
    caseType: "民商事",
    procedure: "一审",
    litigationRole: "原告",
    level: "高",
    ownerId: "孙奕",
  },
  party: { name: "某某公司", type: "法人" },
};

function cellsOf(kind: ImportKind, values: Record<string, string>): string[] {
  return IMPORT_TEMPLATES[kind].map((c) => values[c.field] ?? "");
}

describe("模板的必填列是够的（与既有 DTO 对齐）", () => {
  const dtoOf: Record<ImportKind, { safeParse: (v: unknown) => { success: boolean } }> = {
    risk_matter: riskCreateSchema,
    matter: matterCreateSchema,
    party: partyCreateSchema,
  };

  for (const kind of Object.keys(MINIMAL) as ImportKind[]) {
    it(`${kind}：只填必填列就能过 DTO`, () => {
      const built = buildImportRow(kind, cellsOf(kind, MINIMAL[kind]), deps);
      expect(built.ok, built.ok ? "" : JSON.stringify(built.issues)).toBe(true);
      if (!built.ok) return;
      const dto = dtoOf[kind].safeParse(built.input);
      expect(dto.success, JSON.stringify(dto)).toBe(true);
    });
  }

  it("必填列**不是**多余的：把其中一列清空，DTO 或构建器必须报出来", () => {
    // 反向：若某个"必填"其实不必要，这条会红 —— 提醒把它改成选填，
    // 否则用户被迫为一行填一个系统根本不要的值。
    const built = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", { ...MINIMAL.risk_matter, type: "" }),
      deps,
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.issues.some((i) => i.code === "required")).toBe(true);
  });
});

describe("模板 → CSV → 解析 往返", () => {
  for (const kind of Object.keys(MINIMAL) as ImportKind[]) {
    it(`${kind}：生成的模板能被自己的导入器读，且读出来是 0 行数据`, () => {
      const csv = csvText(templateRows(kind, deps));
      const parsed = parseImportFile(kind, csv);
      expect(parsed.ok, parsed.ok ? "" : parsed.problem.message).toBe(true);
      if (!parsed.ok) return;
      // 表头与说明行都不是数据行 —— 说明行被识别、表头被消费
      expect(parsed.rows.length).toBe(0);
    });
  }

  it("在模板上填一行再解析：单元格落到正确的列（含说明行的列顺序）", () => {
    const rows = templateRows("matter", deps);
    const filled = cellsOf("matter", MINIMAL.matter);
    const csv = csvText([rows[0] as string[], rows[1] as string[], filled]);
    const parsed = parseImportFile("matter", csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0]?.rowNo).toBe(3);
    const built = buildImportRow("matter", parsed.rows[0]?.cells ?? [], deps);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.input).toMatchObject({ name: "某买卖合同案", ownerId: "9001" });
  });
});

describe("幂等键（行的内容）", () => {
  const base = {
    name: "某事项",
    type: "contract",
    level: "high",
    description: "描述",
    parties: [],
  };

  it("键名顺序不影响键值（同一件事只有一个键）", () => {
    expect(rowHashOf("risk_matter", { ...base })).toBe(
      rowHashOf("risk_matter", {
        parties: [],
        description: "描述",
        level: "high",
        type: "contract",
        name: "某事项",
      }),
    );
  });

  it("当事人顺序不影响键值（换个填写顺序是同一件事）", () => {
    const a = rowHashOf("risk_matter", {
      ...base,
      parties: [
        { name: "甲公司", partyRole: "defendant" },
        { name: "乙公司", partyRole: "other" },
      ],
    });
    const b = rowHashOf("risk_matter", {
      ...base,
      parties: [
        { name: "乙公司", partyRole: "other" },
        { name: "甲公司", partyRole: "defendant" },
      ],
    });
    expect(a).toBe(b);
  });

  it("不同 kind 的同一份内容不是同一个键（当事人与事项不会互相顶掉）", () => {
    expect(rowHashOf("party", { name: "甲", type: "legal_person" })).not.toBe(
      rowHashOf("risk_matter", { name: "甲", type: "legal_person" }),
    );
  });

  it("内容变一个字就是另一个键（否则改过的行会被当成已导入而**静默漏掉**）", () => {
    expect(rowHashOf("risk_matter", base)).not.toBe(
      rowHashOf("risk_matter", { ...base, description: "描述 " }),
    );
  });
});

describe("载荷与报告的形状", () => {
  it("BULK_IMPORT 载荷的键与枚举表 §3.5 逐字一致", () => {
    const p = importAuditPayload({
      hostType: "risk_matter",
      totalRows: 10,
      importedRows: 8,
      errorRows: 2,
      reportRef: "123",
    });
    expect(Object.keys(p).sort()).toEqual(
      ["error_rows", "host_type", "imported_rows", "report_ref", "total_rows"].sort(),
    );
    expect(p).toEqual({
      host_type: "risk_matter",
      total_rows: 10,
      imported_rows: 8,
      error_rows: 2,
      report_ref: "123",
    });
  });

  it("报告的前三列就是 AC 要的「行号 / 字段 / 原因」", () => {
    expect(IMPORT_REPORT_HEADER.slice(0, 3)).toEqual(["行号", "字段", "原因"]);
  });

  it("报告里的字段是中文列名，不是 zod 路径", () => {
    expect(reportFieldLabel("matter", "parties.0.name")).toBe("对方当事人");
    expect(reportFieldLabel("risk_matter", "description")).toBe("风险描述");
    expect(reportFieldLabel("party", "type")).toBe("当事人类型");
    // 路径里出现模板没有的字段时原样带回，而不是编一个中文名
    expect(reportFieldLabel("party", "unknownField")).toBe("unknownField");
  });
});

/**
 * 预检（`?dryRun=1`）与真导**走同一条实现**的结构证明（MATT-102）。
 *
 * ## 为什么这一组断言值得存在
 *
 * 票面的核心承诺是「预检说能导的行真导时进得去」不是一句约定，而是**同一个实现跑了两次**。
 * 那条承诺在真库上的验收（同一份文件先 dryRun 再真导、两个响应的两项计数一致）要库，
 * 留给父代理的冒烟；**离线这一层能钉的、也最该钉的是它的结构前提**：
 * 解析、构建、DTO 校验、内容键比对这几步在 `runImport` 里**只出现一次** ——
 * 不是"真导一份、预检一份"。一旦有人把它们复制进 `if (dryRun)` 的另一支，
 * 这里当场红（且是断言失败，不是编译错误）。
 *
 * ⚠ 用 `stripTsComments` 剥注释再匹配：本文件的注释里**大量**写着这些函数名
 * （解释为什么不能各写一份），不剥就会把"文档里提到"当成"代码里有第二份"。
 * 这与 `tools/lint-guard/check.mjs` 的源码断言同一个理由。
 */
describe("dry-run 与真导走同一条实现（结构证明）", () => {
  /** 剥掉注释与字符串内容的服务层源码（只留代码，且行号仍对得上） */
  const svc = stripTsComments(readFileSync("src/app/lib/server/services/import.ts", "utf8"));

  /** `runImport` 函数体：从它的声明到下一个顶层声明（`noopPersist`）之间 */
  const runImportBody = (() => {
    const start = svc.indexOf("export async function runImport");
    const end = svc.indexOf("const noopPersist");
    return svc.slice(start, end);
  })();

  it("解析与逐行校验的每一步在 runImport 里各出现**一次**（不是两支各一份）", () => {
    for (const call of [
      "parseImportFile(kind",
      "buildImportRow(kind",
      "dtoFor(kind).safeParse",
      "findImportedByHash(kind",
      "createRecord(kind",
    ]) {
      const hits = runImportBody.split(call).length - 1;
      expect(hits, `${call} 在 runImport 里出现 ${hits} 次 —— 预检与真导不能各走一份`).toBe(1);
    }
  });

  it("内容键（幂等判定）在预检里照常参与 —— 它的计算不在任何 dryRun 分支里", () => {
    // `rowHashOf` 的调用就在逐行循环里、与 dryRun 无关；只有"写库"那一处走 persist
    const hits = runImportBody.split("rowHashOf(kind").length - 1;
    expect(hits).toBe(1);
    // 反向：若有人把内容键挪进 `if (!dryRun)`，这一句会命中 0 —— 那正是"预检谎报能导"的成因
    expect(runImportBody).not.toMatch(/if \(!dryRun\)[^]{0,80}rowHashOf/);
  });

  it("dryRun 只挡在**写库**那两处（批次行 + 收尾），不挡判据", () => {
    // `createRecord` 调用点**不在** dryRun 分支里：预检照样逐行跑创建服务的校验
    expect(runImportBody).not.toMatch(/if \(!dryRun\)[^]{0,120}createRecord\(kind/);
    // 逐行落库是"替身"而非分支：persist 在两支之间选，循环体本身不分支
    expect(runImportBody).toContain("const persist = dryRun ? noopPersist : writeRow;");
  });

  it("两个宿主创建服务各有 dryRun 出口，且**取号**被 dryRun 挡住（预检不消耗编号）", () => {
    // ⚠ `stripTsComments` 会剥掉字符串**内容**，所以 `nextCode("matter")` 在剥后是
    // `nextCode("")` —— 这里只按函数名匹配，不带上那条被剥掉的参数。
    for (const [file, fn] of [
      ["matters", "createMatter"],
      ["risks", "createRiskMatter"],
    ] as const) {
      const src = stripTsComments(readFileSync(`src/app/lib/server/services/${file}.ts`, "utf8"));
      expect(src, `${fn} 没有 dryRun 开关`).toContain("opts: { dryRun?: boolean } = {}");
      // 取号写成 `dryRun ? … : await nextCode(…)`：同一行里 dryRun 三元先于 nextCode ⇒ 预检不取号
      expect(src, `${fn} 的取号没被 dryRun 挡住`).toMatch(/dryRun \?[^\n]*nextCode\(/);
    }
    const partySrc = stripTsComments(
      readFileSync("src/app/lib/server/services/parties.ts", "utf8"),
    );
    expect(partySrc, "createParty 没有 dryRun 开关").toContain("opts: { dryRun?: boolean } = {}");
  });
});

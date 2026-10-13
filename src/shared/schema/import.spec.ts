import { describe, expect, it } from "vitest";
import { ENUM_REGISTRY, STRUCT_REGISTRY } from "@/shared/enums";
import { IMPORT_ISSUE_CODES, type ImportKind } from "@/shared/enums/import";
import {
  ENUM_IDS_USED,
  IMPORT_HINT_MARKER,
  IMPORT_TEMPLATES,
  type ImportDeps,
  buildImportRow,
  enumOptionsOf,
  enumSourceOf,
  headerOf,
  normalizeAmount,
  normalizeDate,
  parseCsv,
  parseImportFile,
  resolveEnumToken,
  splitMulti,
  templateRows,
  VALUE_LIST_SEP,
} from "./import";

/**
 * 模板与枚举的一致性 —— **票面 AC「模板字段与枚举取值一致」的机器可核对形态**。
 *
 * 这一组断言的存在理由：只写在文档里的一致性会漂，而漂的方式很具体 ——
 * `E13` 的 `non_litigation`（非诉）与 `E16` 的 `customer_complaint`（客户投诉）
 * 是**作废但仍在库**的值（枚举表 §5.3 禁止从 CHECK 删值，历史行还要能反查中文名）。
 * 模板一旦照抄注册表全集，就把这两个作废值重新放回了用户手里 ——
 * 而"前端不再展示"这句话在**模板文件**这条链路上原本没有任何东西在守。
 */
const deps: ImportDeps = {
  levels: [
    { code: "high", name: "高" },
    { code: "mid", name: "中" },
    { code: "low", name: "低" },
  ],
  users: [
    { id: "9001", username: "sunyi", displayName: "孙奕" },
    { id: "9002", username: "liwei", displayName: "李伟" },
    // 故意重名：`ambiguous_user` 那条分支要有真夹具才测得到
    { id: "9003", username: "liwei2", displayName: "李伟" },
  ],
};

/** 按模板列顺序拼一行单元格：测试里只写关心的那几格 */
function cellsOf(kind: ImportKind, values: Record<string, string>): string[] {
  return IMPORT_TEMPLATES[kind].map((c) => values[c.field] ?? "");
}

/**
 * 说明行的一格 → 「取值：…」那一段的**取值正文**。
 *
 * 一格可能是拼起来的（`必填；取值：…（可填中文名或英文码）；整行当事人共用；留空按「法人」`），
 * 所以按 `；` 找出那一段，再剥掉前缀与后缀 —— 别在断言里假设"整格就是取值清单"。
 */
function valueSegment(cell: string, suffix: string): string | null {
  const seg = cell.split("；").find((s) => s.startsWith("取值：") && s.endsWith(suffix));
  return seg === undefined ? null : seg.slice("取值：".length, seg.length - suffix.length);
}

const enumColumns = Object.values(IMPORT_TEMPLATES)
  .flat()
  .filter((c) => c.kind === "enum");

describe("模板 ↔ 枚举注册表", () => {
  it("本文件镜像的每个枚举行，与 ENUM_REGISTRY 的值集合和中文名逐字相等", () => {
    // 这条是"两边同时抄错也会红"的那一半：镜像表是手写的（不能 import 注册表，会成环），
    // 所以必须有一条断言把它钉回注册表。
    for (const id of ENUM_IDS_USED) {
      const entry = ENUM_REGISTRY.find((e) => e.id === id);
      expect(entry, `注册表里没有 ${id}`).toBeTruthy();
      const mine = enumSourceOf(id);
      expect(mine, `镜像表里没有 ${id}`).toBeTruthy();
      expect([...(mine?.values ?? [])].sort(), `${id} 值集合与注册表不一致`).toEqual(
        [...(entry?.values ?? [])].map(String).sort(),
      );
      for (const v of mine?.values ?? []) {
        expect(mine?.labels[v], `${id}.${v} 的中文名与注册表不一致`).toBe(entry?.labels[v]);
      }
    }
  });

  it("每个枚举列都指到镜像过的枚举，且可写入子集是全集的一部分", () => {
    expect(enumColumns.length).toBeGreaterThan(0);
    for (const c of enumColumns) {
      expect(ENUM_IDS_USED, `${c.label} 的 enumId=${c.enumId} 不在镜像表里`).toContain(c.enumId);
      const all = enumSourceOf(c.enumId ?? "")?.values ?? [];
      for (const v of c.writable ?? []) {
        expect(all, `${c.label} 的 writable 里有 ${c.enumId} 全集之外的值：${v}`).toContain(v);
      }
      // 可写入子集不能为空：空值域会让模板给出一个"什么都填不了"的列
      expect(enumOptionsOf(c).length, `${c.label} 没有可填取值`).toBeGreaterThan(0);
    }
  });

  it("**作废值不在任何模板的可接受取值里**（E13 非诉 / E16 客户投诉）", () => {
    // 这条是本组最要紧的一条：它证明模板用的是 `*_WRITABLE` 而不是全集。
    const caseType = IMPORT_TEMPLATES.matter.find((c) => c.field === "caseType");
    const source = IMPORT_TEMPLATES.risk_matter.find((c) => c.field === "source");
    expect(caseType && source).toBeTruthy();
    for (const token of ["non_litigation", "非诉"]) {
      expect(resolveEnumToken(caseType!, token), `案件类型仍然收下了作废值 ${token}`).toBeNull();
    }
    for (const token of ["customer_complaint", "客户投诉"]) {
      expect(resolveEnumToken(source!, token), `来源仍然收下了作废值 ${token}`).toBeNull();
    }
    // 反向：新值必须在
    expect(resolveEnumToken(caseType!, "民商事")).toBe("civil_commercial");
    expect(resolveEnumToken(source!, "对外纠纷/投诉")).toBe("external_dispute");
  });

  it("同一列里中文名与码都不重复（否则一个写法会对应两个码）", () => {
    for (const c of enumColumns) {
      const seen = new Map<string, string>();
      for (const opt of enumOptionsOf(c)) {
        for (const token of [opt.value, opt.label]) {
          const prev = seen.get(token);
          expect(
            prev === undefined || prev === opt.value,
            `${c.label} 的「${token}」对应多个码`,
          ).toBe(true);
          seen.set(token, opt.value);
        }
      }
    }
  });

  it("原因码与中文名一一对应（注册表里的登记不是摆设）", () => {
    const struct = STRUCT_REGISTRY.find((s) => s.key === "import_row.issue_code");
    expect(struct?.values).toEqual(IMPORT_ISSUE_CODES);
    for (const code of IMPORT_ISSUE_CODES) {
      expect(struct?.labels[code], `${code} 缺中文名`).toBeTruthy();
    }
  });
});

describe("模板生成", () => {
  it("表头按列规格生成，必填列带星号，且列名不重复", () => {
    for (const kind of Object.keys(IMPORT_TEMPLATES) as ImportKind[]) {
      const columns = IMPORT_TEMPLATES[kind];
      const labels = columns.map((c) => c.label);
      expect(new Set(labels).size, `${kind} 的列名有重复`).toBe(labels.length);
      const [header, hint] = templateRows(kind, deps);
      expect(header).toEqual(columns.map(headerOf));
      expect(hint?.[0]).toBe(IMPORT_HINT_MARKER);
      expect(hint?.length).toBe(header?.length);
    }
  });

  it("说明行里带取值清单与配置取值（模板是自解释的，不必回来查文档）", () => {
    const [, hint] = templateRows("risk_matter", deps);
    const columns = IMPORT_TEMPLATES.risk_matter;
    const at = (field: string) => hint?.[columns.findIndex((c) => c.field === field)] ?? "";
    expect(at("type")).toContain("合同");
    expect(at("type")).toContain("劳动争议");
    expect(at("level")).toContain("高（high）");
    expect(at("discoverDate")).toContain("YYYY-MM-DD");
    // 作废值不能出现在给用户看的清单里 —— 上一条断言只保证"收不下"，这条保证"看不到"
    expect(at("caseType")).not.toContain("非诉");
    expect(at("source")).not.toContain("客户投诉");
  });

  it("说明行的取值清单按分隔符切开，每一段都是真取值（分隔符不许出现在取值里）", () => {
    // 本组唯一能抓住"分隔符与取值相撞"的断言：E16 的「对外纠纷/投诉」**自带 `/`**，
    // 分隔符若退回 `/`，`业务报备/对外纠纷/投诉/收到对方当事人律师函/…` 会切出一个
    // 「投诉」—— 它在用户眼里是个合法的取值，抄下来却换回 `unknown_enum`。
    // 钉住它的办法不是"约定别用 `/`"（约定不报错），而是：**切开之后每一段都必须在注册表取值里**。
    for (const kind of Object.keys(IMPORT_TEMPLATES) as ImportKind[]) {
      const hint = templateRows(kind, deps)[1] ?? [];
      IMPORT_TEMPLATES[kind].forEach((c, i) => {
        const cell = hint[i] ?? "";
        if (c.kind === "enum") {
          const body = valueSegment(cell, "（可填中文名或英文码）");
          expect(
            body,
            `${kind}.${c.field} 的说明行里找不到「取值：…（可填中文名或英文码）」：${cell}`,
          ).not.toBeNull();
          const parts = (body ?? "").split(VALUE_LIST_SEP);
          // ① 每一段都必须是**注册表**里该枚举的取值（不经过本文件的镜像表，独立性更强）
          const entry = ENUM_REGISTRY.find((e) => e.id === c.enumId);
          const registryLabels = (entry?.values ?? []).map(
            (v) => entry?.labels[String(v)] ?? String(v),
          );
          for (const part of parts) {
            expect(
              registryLabels,
              `${kind}.${c.field} 的说明行切出「${part}」，它不是 ${c.enumId} 的取值`,
            ).toContain(part);
          }
          // ② 段数必须恰好等于可写入子集：多出来的段 = 某个取值被分隔符切开了
          expect(parts, `${kind}.${c.field} 的说明行段数与可写入取值不一致`).toEqual(
            enumOptionsOf(c).map((o) => o.label),
          );
        }
        if (c.kind === "config") {
          // 等级名是运营在配置表里改的，同样不许与分隔符相撞（改出个 `/` 不该毁掉说明行）
          const body = valueSegment(cell, "（按配置表启用的等级）");
          expect(body, `${kind}.${c.field} 的等级说明行形状变了：${cell}`).not.toBeNull();
          expect((body ?? "").split(VALUE_LIST_SEP)).toEqual(
            deps.levels.map((l) => `${l.name}（${l.code}）`),
          );
        }
      });
    }
  });

  it("模板不含示例数据行（模板本身就是一份可导入文件）", () => {
    for (const kind of Object.keys(IMPORT_TEMPLATES) as ImportKind[]) {
      expect(templateRows(kind, deps).length).toBe(2);
    }
  });
});

describe("CSV 解析", () => {
  it("引号、转义引号、引号内的逗号与换行", () => {
    const rows = parseCsv('a,b\n"x,1","他说""好"""\n"多\n行",z\n');
    expect(rows.map((r) => r.cells)).toEqual([
      ["a", "b"],
      ["x,1", '他说"好"'],
      ["多\n行", "z"],
    ]);
    // 逻辑行号：引号里的换行不算新的一行 —— 用户在 Excel 里看到的是这个号
    expect(rows.map((r) => r.rowNo)).toEqual([1, 2, 3]);
  });

  it("CRLF、BOM 与末尾换行都不会多出一行", () => {
    const rows = parseCsv("\uFEFFa,b\r\n1,2\r\n");
    expect(rows.map((r) => r.cells)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a,b").length).toBe(1);
    expect(parseCsv("").length).toBe(0);
  });
});

describe("文件级解析（结构错误一次性拒掉）", () => {
  const header = IMPORT_TEMPLATES.risk_matter.map(headerOf).join(",");

  it("表头 + 说明行 + 数据行 → 只回数据行，且列按模板顺序重排", () => {
    const hint = templateRows("risk_matter", deps)[1]?.join(",") ?? "";
    // 只写前 7 列（事项名称/风险类型/风险等级/发现日期/来源/涉及金额/风险描述），
    // 其余 7 列省略 —— 缺的格按空处理，与 Excel 里"右边没填"是同一种情况。
    const csv = `${header}\n${hint}\n某事项,合同,高,,,,描述在这里\n`;
    const r = parseImportFile("risk_matter", csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.rowNo).toBe(3);
    expect(r.rows[0]?.cells[0]).toBe("某事项");
    expect(r.rows[0]?.cells[1]).toBe("合同");
    expect(r.rows[0]?.cells[6]).toBe("描述在这里");
  });

  it("列顺序可以不同（表头认得出就行），空行与说明行不占行号", () => {
    const reordered = "风险描述*,事项名称*,风险等级*,风险类型*";
    const csv = `${reordered}\n\n描述,名称,高,合同\n`;
    const r = parseImportFile("risk_matter", csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.rowNo).toBe(3);
    expect(r.rows[0]?.cells[0]).toBe("名称");
    expect(r.rows[0]?.cells[1]).toBe("合同");
    expect(r.rows[0]?.cells[6]).toBe("描述");
  });

  it("不认识的列 → 400 级问题，且点名是哪一列", () => {
    const r = parseImportFile("risk_matter", `${header},备注\n某事项,合同,高,,,,\n`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe("unknown_column");
    expect(r.problem.message).toContain("备注");
  });

  it("缺必填列 → 400 级问题，且点名缺哪一列", () => {
    const r = parseImportFile("risk_matter", "事项名称*,风险类型*\n某事项,合同\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe("missing_column");
    expect(r.problem.message).toContain("风险描述");
  });

  it("GBK 另存的乱码（U+FFFD）单独一句话，指向保存格式而不是表头", () => {
    const r = parseImportFile("risk_matter", `\uFFFD\uFFFD\uFFFD\n1,2\n`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe("bad_encoding");
    expect(r.problem.message).toContain("UTF-8");
  });

  it("行数超上限 → 拒整份文件（不是静默截断）", () => {
    const body = Array.from({ length: 5 }, (_, i) => `事项${i},合同,高,,,,描述,,,,,,,`).join("\n");
    const r = parseImportFile("risk_matter", `${header}\n${body}\n`, { maxRows: 3 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe("too_many_rows");
    expect(r.problem.message).toContain("5 行");
  });
});

describe("单元格归一", () => {
  it("日期：四种写法归一，形状对但日期不存在要拒", () => {
    expect(normalizeDate("2024-01-05")).toBe("2024-01-05");
    expect(normalizeDate("2024/1/5")).toBe("2024-01-05");
    expect(normalizeDate("2024.1.5")).toBe("2024-01-05");
    expect(normalizeDate("2024年1月5日")).toBe("2024-01-05");
    expect(normalizeDate("2024-02-30")).toBeNull();
    expect(normalizeDate("2024-13-01")).toBeNull();
    expect(normalizeDate("去年")).toBeNull();
  });

  it("金额：千分位/货币符号/「元」都认，但**全程字符串**、超两位小数要拒", () => {
    expect(normalizeAmount("1,234,567.89")).toBe("1234567.89");
    expect(normalizeAmount("¥ 1200 元")).toBe("1200");
    expect(normalizeAmount("0.5")).toBe("0.5");
    expect(normalizeAmount("1.234")).toBeNull();
    expect(normalizeAmount("-5")).toBeNull();
    expect(normalizeAmount("十二万")).toBeNull();
    // 18 位有效数字不许经过 Number：`Number("1234567890123456.78")` 会丢分位
    expect(normalizeAmount("1234567890123456.78")).toBe("1234567890123456.78");
  });

  it("多值分隔：顿号/逗号/分号都认，空段丢掉", () => {
    expect(splitMulti("甲、乙，丙;丁")).toEqual(["甲", "乙", "丙", "丁"]);
    expect(splitMulti("")).toEqual([]);
  });
});

describe("逐行构建", () => {
  it("事项：只填必填列就能过（必填列是够的）", () => {
    const r = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", {
        name: "某合同纠纷",
        type: "合同",
        level: "高",
        description: "对方拖欠货款",
      }),
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({ type: "contract", level: "high", parties: [] });
  });

  it("枚举中文名与英文码等价；等级按配置的 name/code 都认", () => {
    const base = { name: "某事项", description: "描述", type: "contract", level: "mid" };
    const r = buildImportRow("risk_matter", cellsOf("risk_matter", base), deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input).toMatchObject({ type: "contract", level: "mid" });
    const byName = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", { ...base, type: "劳动争议", level: "中" }),
      deps,
    );
    expect(byName.ok).toBe(true);
    if (byName.ok) expect(byName.input).toMatchObject({ type: "labor_dispute", level: "mid" });
  });

  it("一次收齐同一行的多个问题（改 N 遍是最坏的体验）", () => {
    const r = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", { name: "某事项", type: "不存在", level: "超高", description: "" }),
      deps,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code).sort()).toEqual([
      "required",
      "unknown_config",
      "unknown_enum",
    ]);
    expect(r.issues.map((i) => i.field).sort()).toEqual(["description", "level", "type"]);
  });

  it("处理人：姓名与账号都认；查不到与重名是两条不同的码", () => {
    const ok = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", {
        name: "某事项",
        type: "合同",
        level: "高",
        description: "描述",
        ownerId: "孙奕",
      }),
      deps,
    );
    expect(ok.ok && ok.input).toMatchObject({ ownerId: "9001" });

    const byAccount = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", {
        name: "某事项",
        type: "合同",
        level: "高",
        description: "描述",
        ownerId: "sunyi",
      }),
      deps,
    );
    expect(byAccount.ok && byAccount.input).toMatchObject({ ownerId: "9001" });

    const missing = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", {
        name: "某事项",
        type: "合同",
        level: "高",
        description: "描述",
        ownerId: "查无此人",
      }),
      deps,
    );
    expect(!missing.ok && missing.issues[0]?.code).toBe("unknown_user");

    const ambiguous = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", {
        name: "某事项",
        type: "合同",
        level: "高",
        description: "描述",
        ownerId: "李伟",
      }),
      deps,
    );
    expect(!ambiguous.ok && ambiguous.issues[0]?.code).toBe("ambiguous_user");
  });

  it("当事人：多值按位置配证件号；证件号比人多要报错；类型与地位有文档化的默认值", () => {
    const r = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", {
        name: "某事项",
        type: "合同",
        level: "高",
        description: "描述",
        "parties[].name": "甲公司、乙公司",
        "parties[].idNumber": "91110000X、",
        "parties[].partyRole": "被告",
      }),
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.parties).toEqual([
      { name: "甲公司", type: "legal_person", partyRole: "defendant", idNumber: "91110000X" },
      { name: "乙公司", type: "legal_person", partyRole: "defendant" },
    ]);

    const mismatch = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", {
        name: "某事项",
        type: "合同",
        level: "高",
        description: "描述",
        "parties[].name": "甲公司",
        "parties[].idNumber": "91110000X、91330000Y",
      }),
      deps,
    );
    expect(!mismatch.ok && mismatch.issues[0]?.code).toBe("party_mismatch");

    const def = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", {
        name: "某事项",
        type: "合同",
        level: "高",
        description: "描述",
        "parties[].name": "甲公司",
      }),
      deps,
    );
    expect(def.ok && def.input.parties[0]).toMatchObject({
      type: "legal_person",
      partyRole: "other",
    });
  });

  it("案件：处理人必填（缺省回落操作人是**错的**，会把历史案件挂到导数据的人头上）", () => {
    const base = {
      name: "某案件",
      cause: "买卖合同纠纷",
      caseType: "民商事",
      procedure: "一审",
      litigationRole: "原告",
      level: "高",
    };
    const noOwner = buildImportRow("matter", cellsOf("matter", base), deps);
    expect(!noOwner.ok && noOwner.issues.some((i) => i.field === "ownerId")).toBe(true);
    const withOwner = buildImportRow(
      "matter",
      cellsOf("matter", { ...base, ownerId: "孙奕" }),
      deps,
    );
    expect(withOwner.ok).toBe(true);
    if (withOwner.ok) {
      expect(withOwner.input).toMatchObject({
        caseType: "civil_commercial",
        procedure: "first_instance",
        litigationRole: "plaintiff",
        ownerId: "9001",
      });
    }
  });

  it("当事人模板：名称与类型必填，其余选填", () => {
    const r = buildImportRow("party", cellsOf("party", { name: "甲公司", type: "法人" }), deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input).toEqual({ name: "甲公司", type: "legal_person" });
    const bad = buildImportRow("party", cellsOf("party", { name: "甲公司", type: "非诉" }), deps);
    expect(!bad.ok && bad.issues.some((i) => i.code === "unknown_enum")).toBe(true);
  });

  it("日期与金额的非法写法进报告，不是静默丢掉那一格", () => {
    const r = buildImportRow(
      "risk_matter",
      cellsOf("risk_matter", {
        name: "某事项",
        type: "合同",
        level: "高",
        description: "描述",
        discoverDate: "去年三月",
        amount: "十二万",
      }),
      deps,
    );
    expect(!r.ok && r.issues.map((i) => i.field).sort()).toEqual(["amount", "discoverDate"]);
  });
});

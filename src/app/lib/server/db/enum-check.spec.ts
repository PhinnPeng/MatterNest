import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENUM_REGISTRY, STRUCT_REGISTRY, type EnumEntry } from "@/shared/enums";
import { AUDIT_ACTION_MAX_LENGTH } from "@/shared/enums";

/**
 * CHECK ↔ 值数组一致性机制（W0-3 的正主，落地方案 §2 的 M0 退出条件之一）。
 *
 * 三条设计决定，都是踩过之后定下来的：
 *   1. **读迁移 SQL，不读 `schema.ts`。** 禁令④ 规定"迁移文件是唯一事实"，
 *      所以基准必须是迁移；比 TS 只能证明"两份 TS 互相抄对了"，库照样可以不一样。
 *   2. **双向比对。** 只走"注册表 → 迁移"会漏掉反向那半：有人直接在迁移尾部手写一个
 *      `CHECK (col IN (...))` 而没登记，值域就悄悄成了第二事实源。
 *   3. **解析器自己要有单测。** 正则没命中时"零条约束"看起来和"全部一致"一样绿 ——
 *      这是校验类脚本最典型的空转形态（本项目已因此翻过一次车）。
 */
const MIGRATIONS = "src/app/lib/server/db/migrations";

type ParsedCheck = { name: string; column: string; values: string[] };

/** 只认 `CHECK (col IN ('a','b',…))` 这一种字面量集合形态：DDL 里带参数占位符的写法本身非法（禁令②） */
export function parseEnumChecks(sql: string): ParsedCheck[] {
  const out: ParsedCheck[] = [];
  // 约束名**可带引号也可不带**：drizzle 产的是 "ck_x"，而枚举表 §5.2 的手写补丁模板写的是裸名 ck_x。
  // 只认带引号的形态，就等于给"尾部手写 CHECK 不被反向检查发现"留了个洞（本轮实测踩过）。
  const re = /CONSTRAINT\s+"?([a-z0-9_]+)"?\s+CHECK\s*\(\s*([a-z0-9_]+)\s+IN\s*\(([^)]*)\)\s*\)/gs;
  for (const m of sql.matchAll(re)) {
    const [, name, column, inner] = m;
    if (!name || !column || inner === undefined) continue;
    out.push({
      name,
      column,
      values: inner
        .split(",")
        .map((v) => v.trim().replace(/^'|'$/g, ""))
        .filter((v) => v.length > 0),
    });
  }
  return out;
}

const migrationFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
const migrationSql = migrationFiles
  .map((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8"))
  .join("\n");
const checks = parseEnumChecks(migrationSql);
const inDb = ENUM_REGISTRY.filter(
  (e): e is EnumEntry & { constraint: NonNullable<EnumEntry["constraint"]> } =>
    Boolean(e.constraint),
);

describe("枚举注册表自身", () => {
  it("覆盖 E01–E37 全 37 行，不重不漏", () => {
    const ids = ENUM_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      Array.from({ length: 37 }, (_, i) => `E${String(i + 1).padStart(2, "0")}`).sort(),
    );
  });

  it("值数组无重复值、无空数组（not-an-enum 除外）", () => {
    for (const e of ENUM_REGISTRY.filter((x) => x.landing !== "not-an-enum")) {
      expect(new Set(e.values.map(String)).size, `${e.id} 有重复值`).toBe(e.values.length);
      expect(e.values.length, `${e.id} 值数组为空`).toBeGreaterThan(0);
    }
  });

  it("每个取值都有中文名，且中文名里没有多余键", () => {
    for (const e of ENUM_REGISTRY.filter((x) => x.landing !== "not-an-enum")) {
      for (const v of e.values) {
        expect(e.labels[String(v)], `${e.id}.${String(v)} 缺中文名`).toBeTruthy();
      }
      expect(Object.keys(e.labels).sort()).toEqual(e.values.map(String).sort());
    }
  });

  it("非枚举的行（E01 无此列、E07 布尔）各有一句处置说明，防止被当成漏登记", () => {
    const notes = ENUM_REGISTRY.filter((e) => e.landing === "not-an-enum");
    expect(notes.map((e) => e.id)).toEqual(["E01", "E07"]);
    for (const n of notes) expect(n.note, `${n.id} 没写原因`).toBeTruthy();
  });

  it("E28 是 smallint 不是枚举语义，仍登记值域", () => {
    const e28 = ENUM_REGISTRY.find((e) => e.id === "E28");
    expect(e28?.values).toEqual([0, 1]);
    expect(e28?.labels["0"]).toBe("未转案件");
  });

  it("§3/§4 的结构取值另立注册表，不用 37/37 冒充全量登记", () => {
    expect(STRUCT_REGISTRY.length).toBeGreaterThanOrEqual(9);
    for (const s of STRUCT_REGISTRY) expect(s.values.length).toBeGreaterThan(0);
  });

  it("activity_log.action 每条都不超列宽 varchar(40)", () => {
    const actions = STRUCT_REGISTRY.find((s) => s.key === "activity_log.action");
    expect(actions).toBeTruthy();
    for (const a of actions?.values ?? []) {
      expect(a.length, `${a} 超出 ${AUDIT_ACTION_MAX_LENGTH}`).toBeLessThanOrEqual(
        AUDIT_ACTION_MAX_LENGTH,
      );
    }
  });
});

describe("注册表 ↔ 迁移里的 CHECK", () => {
  it("解析器不是空转：能认出字面量集合，也不会误认别的 CHECK", () => {
    const one = parseEnumChecks(`CONSTRAINT "ck_x" CHECK (foo IN ('a','b'))`);
    expect(one).toEqual([{ name: "ck_x", column: "foo", values: ["a", "b"] }]);
    expect(parseEnumChecks(`CONSTRAINT "ck_y" CHECK (a <> 'cancelled' OR b IS NOT NULL)`)).toEqual(
      [],
    );
    expect(parseEnumChecks(`CONSTRAINT "ck_z" CHECK (col IN ('a')::text[])`)).toEqual([]);
    // 裸名（§5.2 手写补丁模板的写法）也必须被认出，否则反向检查形同虚设
    expect(
      parseEnumChecks(`ALTER TABLE matter ADD CONSTRAINT ck_matter_case_type
  CHECK (case_type IN ('civil_commercial','criminal'));`),
    ).toEqual([
      {
        name: "ck_matter_case_type",
        column: "case_type",
        values: ["civil_commercial", "criminal"],
      },
    ]);
    expect(migrationFiles.length, "迁移目录为空？").toBeGreaterThan(0);
  });

  it("注册表说已进库的约束，迁移里必须存在且值集合逐字相等", () => {
    for (const e of inDb) {
      const found = checks.find((c) => c.name === e.constraint.name);
      expect(found, `${e.id} 声明了 ${e.constraint.name}，迁移里找不到`).toBeTruthy();
      expect(found?.column, `${e.constraint.name} 守的不是 ${e.constraint.column}`).toBe(
        e.constraint.column,
      );
      expect([...(found?.values ?? [])].sort()).toEqual([...e.values].map(String).sort());
      expect(found?.values.length, `${e.constraint.name} 值数量不同`).toBe(e.values.length);
    }
  });

  it("反向：迁移里出现的 IN 型 CHECK 必须被注册表认领", () => {
    const claimed = new Set(inDb.map((e) => e.constraint.name));
    const unclaimed = checks.filter((c) => !claimed.has(c.name)).map((c) => c.name);
    expect(
      unclaimed,
      `这些 CHECK 没登记进 ENUM_REGISTRY，会成为第二事实源：${unclaimed.join(", ")}`,
    ).toEqual([]);
  });

  it("约束名与列名对得上命名规范 ck_<表去下划线>_<列>", () => {
    for (const e of inDb) {
      expect(e.constraint.name).toMatch(/^ck_[a-z0-9_]+$/);
      expect(e.constraint.name, `${e.constraint.name} 不含列名片段`).toContain(e.constraint.column);
    }
  });
});

/**
 * **与权威源原文对拉**（枚举表 §1/§2 的「取值」列）。
 *
 * 这一组才是本票验收第 2 条的正解：前面所有断言都只证明"注册表与迁移一致"，
 * 两边同时抄错同一个值时它们全绿。把文档表格变成机器可核对的基准，
 * 才出现"文档改了值、代码没跟"当场变红。
 */
const ENUM_DOC = "docs/PRD-phase1-enums-and-schemas.md";
/** 三行本就不是可比对的字面值列表：E01 无此列、E06 写"见 E12"、E07 是布尔 */
const DOC_ROW_EXCEPTIONS: Record<string, string> = {
  E01: "取值列是 —（无此列）",
  E06: "取值列写「见 E12」，复用 E12 值域",
  E07: "取值列是 true/false 布尔",
};

describe("注册表 ↔ 枚举表原文", () => {
  const doc = readFileSync(ENUM_DOC, "utf8");
  const docRows = new Map<string, string[]>();
  for (const line of doc.split("\n")) {
    const m = /^\|\s*(E\d{2})\s*\|[^|]*\|([^|]*)\|/.exec(line);
    if (!m?.[1] || m[2] === undefined) continue;
    docRows.set(
      m[1],
      [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1] ?? ""),
    );
  }

  it("文档表格里确实解析出 37 行取值（解析器没空转）", () => {
    expect(docRows.size).toBe(37);
    expect(docRows.get("E12")).toContain("respondent_petition");
    expect(docRows.get("E29")?.length).toBe(7);
  });

  it("除三行明确例外，注册表值集合与文档逐字相等", () => {
    for (const e of ENUM_REGISTRY) {
      const fromDoc = docRows.get(e.id);
      expect(fromDoc, `枚举表里找不到 ${e.id} 行（改名或删除要同步本测试）`).toBeTruthy();
      if (e.id in DOC_ROW_EXCEPTIONS) {
        continue;
      }
      expect(
        [...(fromDoc ?? [])].sort(),
        `${e.id} 与枚举表取值不一致：文档 ${(fromDoc ?? []).join(",")} vs 代码 ${e.values.join(",")}`,
      ).toEqual([...e.values].map(String).sort());
    }
  });

  it("E33 与 E32 同值域这条口径由单实现保证（不是两份抄齐）", () => {
    const e32 = ENUM_REGISTRY.find((e) => e.id === "E32");
    const e33 = ENUM_REGISTRY.find((e) => e.id === "E33");
    expect(e32?.values).toEqual(e33?.values);
    expect(e32?.values).toBe(e33?.values); // 同一个数组引用，不是两份相等
  });

  it("E08 与 E10 共用 host_type：同样是单实现", () => {
    const e08 = ENUM_REGISTRY.find((e) => e.id === "E08");
    const e10 = ENUM_REGISTRY.find((e) => e.id === "E10");
    expect(e08?.values).toBe(e10?.values);
  });
});

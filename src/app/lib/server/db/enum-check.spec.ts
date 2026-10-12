import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_MAX_LENGTH,
  claimedChecks,
  ENUM_REGISTRY,
  STRUCT_REGISTRY,
} from "@/shared/enums";

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
  // 可空列的 CHECK 是 `CHECK (col IS NULL OR col IN (…))` 形状，也要能认出来 ——
  // drizzle 把 `sql\`x IS NULL OR \${sqlInList(...)}\`` 原样产出，漏了这形状就等于该列没人守。
  const re =
    /CONSTRAINT\s+"?([a-z0-9_]+)"?\s+CHECK\s*\(\s*(?:([a-z0-9_]+) IS NULL OR )?([a-z0-9_]+)\s+IN\s*\(([^)]*)\)\s*\)/gs;
  for (const m of sql.matchAll(re)) {
    const [, name, , column, inner] = m;
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

/**
 * 迁移文件必须按文件名排：PG 里后一条 DDL 覆盖前一条，文件顺序就是实际生效顺序。
 * `readdirSync` 的返回顺序未定义，直接 join 等于赌文件系统心情——0002 改名扩 CHECK 之后，
 * 赌输了就会拿 0000 的旧值集去比对，失败信息还指向一个"没改过"的约束名，极难自查。
 */
const migrationFiles = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const migrationSql = migrationFiles
  .map((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8"))
  .join("\n");

/**
 * 同名 CHECK 出现多次时**取最后一次**（= PG 的实际生效结果）。
 *
 * 扩值域的正规姿势是新增一条迁移 `DROP CONSTRAINT` + `ADD CONSTRAINT`（禁改历史迁移，
 * 已跑过的库才追得上）。于是同一个约束名会在多个文件里各留一份字面量，而
 * `checks.find(name)` 取到的是**最早**那份——恰好是已作废的旧值集。
 * 不去重的话反向检查还会把后来那条报成"没人认领的第二事实源"，逼人往注册表里塞重复条目。
 */
const parsedChecks = parseEnumChecks(migrationSql);
const checks = [...new Map(parsedChecks.map((c) => [c.name, c])).values()];
const landed = ENUM_REGISTRY.filter((e) => e.landing === "in-db");
const claims = claimedChecks();

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
      expect(String(a).length, `${a} 超出 ${AUDIT_ACTION_MAX_LENGTH}`).toBeLessThanOrEqual(
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

  it("同名 CHECK 取最后一次（扩值域迁移不能被旧值集盖住）", () => {
    const twice = parseEnumChecks(
      `ALTER TABLE t ADD CONSTRAINT "ck_a" CHECK (s IN ('old'));
       ALTER TABLE t DROP CONSTRAINT "ck_a";
       ALTER TABLE t ADD CONSTRAINT "ck_a" CHECK (s IN ('old','new'));`,
    );
    // 两条 ADD CONSTRAINT 都会被认出；中间的 DROP 不产生 IN 型约束，解析器本就看不见它
    expect(twice.length).toBe(2);
    // 去重发生在调用方，这里断言的是"最后一次生效"这个语义本身
    const effective = [...new Map(twice.map((c) => [c.name, c])).values()];
    expect(effective).toEqual([{ name: "ck_a", column: "s", values: ["old", "new"] }]);
  });

  it("迁移文件按文件名排序读入（0002 必须排在 0000 之后）", () => {
    // 不排序的话，readdir 返回顺序由文件系统决定，上面那条去重就会随机取到旧值集。
    // 这条断言是给"忘了 .sort()"留的哨兵。
    const sorted = [...migrationFiles].sort();
    expect(migrationFiles).toEqual(sorted);
  });

  it("注册表说已进库的约束，迁移里必须存在且值集合逐字相等", () => {
    for (const e of landed) {
      for (const [table, column, name] of e.checks) {
        const found = checks.find((c) => c.name === name);
        expect(found, `${e.id} 声明了 ${name}，迁移里找不到（${table}）`).toBeTruthy();
        expect(found?.column, `${name} 守的不是 ${table}.${column}`).toBe(column);
        // ⚠ 这里比的是**子集**，不是相等——而且是有意的。
        //
        // 原断言是「长度相等 + 逐字相等」，它编码了一个假设：同一枚举的每个落点
        // 值域必然相同。MATT-10 打破了这个假设：`mn_comment.target_type` 与
        // `mn_activity_log.target_type` 共用 E03，但**评论只挂业务对象**，
        // 账号维度（app_user，MATT-10 迁移 0006）对评论没有意义也不该有。
        // 让评论表为了"值数量相同"而收下账号，等于为一个没人用的能力放宽约束。
        //
        // 子集判定仍然抓得住两类真错：迁移里多写了注册表没有的值（拼错/漏登记），
        // 以及约束守错了列。下面那条「不得整体收窄」堵住剩下的漏洞——
        // 否则把所有落点统一删成一个值，这条也会绿。
        const declared = new Set(e.values.map(String));
        const extra = (found?.values ?? []).filter((v) => !declared.has(v));
        expect(extra, `${name} 里有注册表 ${e.id} 没登记的值：${extra.join(", ")}`).toEqual([]);
      }
    }
  });

  it("反向加固：每个枚举至少一个落点用满值域（防'整体收窄'蒙混过关）", () => {
    // 子集判定的代价：若某天有人把 E03 的两个落点一起收窄成同一个值，
    // 上面那条仍会绿。所以要求「注册表的每个值至少被一个落点认领」。
    for (const e of landed) {
      const union = new Set<string>();
      for (const [, , name] of e.checks) {
        for (const v of checks.find((c) => c.name === name)?.values ?? []) union.add(v);
      }
      const missing = e.values.map(String).filter((v) => !union.has(v));
      expect(missing, `${e.id} 的值没有任何落点认领：${missing.join(", ")}`).toEqual([]);
    }
  });

  it("`landing` 与映射表不许互相说谎", () => {
    for (const e of ENUM_REGISTRY) {
      if (e.landing === "in-db")
        expect(e.checks.length, `${e.id} 标了 in-db 却没登记落点`).toBeGreaterThan(0);
      else expect(e.checks.length, `${e.id} 有落点却标成 ${e.landing}`).toBe(0);
    }
  });

  it("反向：迁移里出现的 IN 型 CHECK 必须被注册表认领", () => {
    const claimed = new Set(claims.keys());
    const unclaimed = checks.filter((c) => !claimed.has(c.name)).map((c) => c.name);
    expect(
      unclaimed,
      `这些 CHECK 没登记进 ENUM_REGISTRY，会成为第二事实源：${unclaimed.join(", ")}`,
    ).toEqual([]);
  });

  it("迁移里至少落了 20 条值域 CHECK（少于这个数说明大面积没登记）", () => {
    expect(checks.length).toBeGreaterThanOrEqual(20);
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
    // E29 现 8 值（IQ-16 追加 archive_incomplete）。这是"解析器真读到了行内容"的探针值：
    // 只断言行数的话，某一行的值整列丢失也可能照样绿。
    expect(docRows.get("E29")?.length).toBe(8);
    expect(docRows.get("E29")).toContain("archive_incomplete");
  });

  it("作废值按 §5.3 保留在取值列里（E13 非诉 / E16 客户投诉）", () => {
    // 这两条最容易在"改名"时被顺手从文档里删干净——而删了就与 CHECK 不一致，
    // 历史行也就没了中文名可反查。断言写死，别让下一个人重蹈。
    expect(docRows.get("E13")).toContain("non_litigation");
    expect(docRows.get("E16")).toContain("customer_complaint");
    // 新值必须真的进了文档，否则"代码加了值、文档没记"会静默通过
    expect(docRows.get("E16")).toContain("external_dispute");
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

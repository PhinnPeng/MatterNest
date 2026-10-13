import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_MAX_LENGTH,
  claimedChecks,
  ENUM_REGISTRY,
  STRUCT_CHECKS,
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

/**
 * ⚠ **`table` 是 2026-10-13 补的，起因是一个真漏洞**（MATT-43 的检查子代理实测）：
 *
 * 本文件原先的 `ParsedCheck` 只有 `{name, column, values}`，**没有表名** ⇒ 消费方
 * 只能断言「这个约束名存在、且它守的列名对」，**不能断言它在哪张表里**。
 * 于是把一条 `CONSTRAINT` 原样挪进**另一张** `CREATE TABLE`（列名不变）⇒ 门禁全绿，
 * 而那条值域约束已经从它该在的表上消失了。
 *
 * 同一次实测还发现第二个形态：`parseEnumChecks()` 的正则跑在**未剥注释**的原始 SQL 上 ⇒
 * 把整行 `CONSTRAINT … CHECK (…)` 前面加 `-- ` 注释掉，**约束彻底消失而 34 条测试全绿**。
 * 两个形态都是「迁移里写了」这一层唯一的守卫在漏，而 `db-check.mjs` 的 C10「约束实撞」
 * 只探 `mn_status_config`、C15 也不看 CHECK ⇒ 漏了没有任何别的东西兜住。
 */
type ParsedCheck = { name: string; table: string; column: string; values: string[] };

/**
 * 剥掉 SQL 行注释（`-- …` 到行尾）与块注释（`/* … *​/`）。
 *
 * 为什么必须剥：迁移文件里**到处是注释**（本仓的迁移头注很长，且注释里就写着
 * `CONSTRAINT "ck_xxx" CHECK (col IN ('a','b'))` 这种**示例**）。不剥的后果有两个方向：
 * 一是注释掉真实约束后门禁**不红**（实测过），二是注释里的示例会被**误当成真约束**。
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** 只认 `CHECK (col IN ('a','b',…))` 这一种字面量集合形态：DDL 里带参数占位符的写法本身非法（禁令②） */
export function parseEnumChecks(sql: string): ParsedCheck[] {
  const out: ParsedCheck[] = [];
  const clean = stripSqlComments(sql);
  // 约束名**可带引号也可不带**：drizzle 产的是 "ck_x"，而枚举表 §5.2 的手写补丁模板写的是裸名 ck_x。
  // 只认带引号的形态，就等于给"尾部手写 CHECK 不被反向检查发现"留了个洞（本轮实测踩过）。
  // 可空列的 CHECK 是 `CHECK (col IS NULL OR col IN (…))` 形状，也要能认出来 ——
  // drizzle 把 `sql\`x IS NULL OR \${sqlInList(...)}\`` 原样产出，漏了这形状就等于该列没人守。
  const re =
    /CONSTRAINT\s+"?([a-z0-9_]+)"?\s+CHECK\s*\(\s*(?:([a-z0-9_]+) IS NULL OR )?([a-z0-9_]+)\s+IN\s*\(([^)]*)\)\s*\)/gs;
  // 归属表：往**回**找最近的 `CREATE TABLE "x"` 或 `ALTER TABLE "x"`。
  // 两种形态都要认：约束可能写在建表语句里（drizzle 的 `CHECK`），也可能是一条独立的
  // `ALTER TABLE … ADD CONSTRAINT`（扩值域的正规姿势）。找不到归属时给空串，
  // 由消费方那条「声明了就必须在同名表里」的断言把它报出来 —— **不确定要显形，不要默认通过**。
  const tableRe = /(?:CREATE TABLE(?:\s+IF NOT EXISTS)?|ALTER TABLE)\s+"?([a-z0-9_]+)"?/gi;
  const tableAt = (idx: number): string => {
    let last = "";
    for (const t of clean.matchAll(tableRe)) {
      if ((t.index ?? 0) > idx) break;
      last = t[1] ?? "";
    }
    return last;
  };
  for (const m of clean.matchAll(re)) {
    const [, name, , column, inner] = m;
    if (!name || !column || inner === undefined) continue;
    out.push({
      name,
      table: tableAt(m.index ?? 0),
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
    // ⚠ `table` 是 2026-10-13 补的（见 `ParsedCheck` 的注释）。这两条**刻意不写表名**，
    //   于是它们同时钉住了"找不到归属时给空串"这个约定 —— 消费方那条
    //   「声明了就必须在**同名表**里」的断言，就是靠空串把这种情况报出来的。
    //   给空串而不是给某个默认表名，是有意的：**不确定要显形，不要默认通过**。
    const one = parseEnumChecks(`CONSTRAINT "ck_x" CHECK (foo IN ('a','b'))`);
    expect(one).toEqual([{ name: "ck_x", table: "", column: "foo", values: ["a", "b"] }]);
    expect(parseEnumChecks(`CONSTRAINT "ck_y" CHECK (a <> 'cancelled' OR b IS NOT NULL)`)).toEqual(
      [],
    );
    expect(parseEnumChecks(`CONSTRAINT "ck_z" CHECK (col IN ('a')::text[])`)).toEqual([]);
    // 裸名（§5.2 手写补丁模板的写法）也必须被认出，否则反向检查形同虚设。
    // 这一条**带 `ALTER TABLE matter`** ⇒ 归属表必须被填上，否则"挪到别的表"就抓不住。
    expect(
      parseEnumChecks(`ALTER TABLE matter ADD CONSTRAINT ck_matter_case_type
  CHECK (case_type IN ('civil_commercial','criminal'));`),
    ).toEqual([
      {
        name: "ck_matter_case_type",
        table: "matter",
        column: "case_type",
        values: ["civil_commercial", "criminal"],
      },
    ]);
    expect(migrationFiles.length, "迁移目录为空？").toBeGreaterThan(0);
  });

  it("注释掉的约束不算存在（未剥注释 ⇒ 整行 COMMENT 掉也全绿，实测漏洞）", () => {
    // 这是 D1 的第一个形态：`parseEnumChecks` 原先跑在未剥注释的原始 SQL 上。
    const commented = `-- CONSTRAINT "ck_gone" CHECK (col IN ('a','b'))`;
    expect(parseEnumChecks(commented)).toEqual([]);
    // 而注释**旁边**的真约束仍要被认出（剥注释不能误伤邻行）
    const mixed = `-- CONSTRAINT "ck_gone" CHECK (col IN ('a','b'))
CREATE TABLE "t" (
  CONSTRAINT "ck_real" CHECK (col IN ('a','b'))
);`;
    expect(parseEnumChecks(mixed).map((c) => c.name)).toEqual(["ck_real"]);
    // 块注释同理
    expect(parseEnumChecks(`/* CONSTRAINT "ck_gone" CHECK (col IN ('a')) */`)).toEqual([]);
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
    expect(effective).toEqual([{ name: "ck_a", table: "t", column: "s", values: ["old", "new"] }]);
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
        // ⚠ **表名也要断言**（2026-10-13 补，D1 的第二个形态）：把一条 `CONSTRAINT`
        //   原样挪进**另一张** `CREATE TABLE`（列名不变）原先**门禁全绿** ——
        //   因为 `ParsedCheck` 当时没有表名，这里只能比列名。
        expect(found?.table, `${name} 不在 ${table} 里（可能被挪到了别的表）`).toBe(table);
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

  /**
   * **STRUCT 行也要双向核**（MATT-43 补的那半）。
   *
   * 原实现只对 `ENUM_REGISTRY` 里 `landing === "in-db"` 的行做正向比对，
   * 而 `STRUCT_CHECKS`（不占 E 行号的结构取值，如 `activity_log.action`、
   * `automation_rule.trigger_type`）**只被反向检查覆盖**——也就是说：
   * 注册表里写着"`automation_rule.action_type` 有这 5 个值"，
   * 而迁移里那条 CHECK 到底存不存在、守的是不是那一列、值集合是不是被收窄成 1 个，
   * 没有任何断言在管。这与 E 行那半的纪律不一致，而"少一半"是看不出来的。
   *
   * 本票新增的两条规则表约束（host_type / trigger_target_type）正是这么进来的：
   * 没有这条断言，它们只是"我在迁移里写了"，而不是"被机器核过"。
   */
  const structLanded = STRUCT_REGISTRY.flatMap((s) =>
    (STRUCT_CHECKS[s.key] ?? []).map(([table, column, name]) => ({
      key: s.key,
      table,
      column,
      name,
      values: s.values,
    })),
  );

  it("STRUCT 注册表里确实有落点（否则下面两条是空转）", () => {
    expect(structLanded.length).toBeGreaterThanOrEqual(1);
    // 探针：本票新增的那两条必须在里面
    expect(structLanded.map((s) => s.name)).toContain("ck_mn_automation_rule_host_type");
    expect(structLanded.map((s) => s.name)).toContain("ck_mn_automation_rule_trigger_target");
  });

  it("STRUCT 行说已进库的约束，迁移里必须存在、守对列、值集合逐字相等", () => {
    for (const s of structLanded) {
      /**
       * ⚠ **表还没建的落点先跳过**，但这不是"放过它"：
       *
       * 并行流（MATT-44 / 迁移 0013）先把 `import_batch.host_type` 的落点登记进了
       * `STRUCT_CHECKS`，而它的迁移文件当时还没落盘。若这里直接断言"必须找得到"，
       * 红的是**别人的半成品**，而不是本仓的真缺陷——而一条会因为时序变红的门禁，
       * 下一步就是被人加 `if` 绕过。
       *
       * 跳过只在"`CREATE TABLE` 都还没有"时成立，所以它**不会变成永久盲区**：
       * 表一落盘，这条断言立刻开始核它（而那时若 CHECK 没登记，下面的反向检查会红）。
       */
      if (!new RegExp(`CREATE TABLE (IF NOT EXISTS )?"${s.table}"`).test(migrationSql)) continue;
      const found = checks.find((c) => c.name === s.name);
      expect(found, `${s.key} 声明了 ${s.name}，迁移里找不到（${s.table}）`).toBeTruthy();
      expect(found?.column, `${s.name} 守的不是 ${s.table}.${s.column}`).toBe(s.column);
      // 表名同 E 行那处：不加这一条，"约束被挪到别的表"就抓不住（D1 的第二个形态）
      expect(found?.table, `${s.name} 不在 ${s.table} 里（可能被挪到了别的表）`).toBe(s.table);
      const declared = new Set(s.values.map(String));
      const extra = (found?.values ?? []).filter((v) => !declared.has(v));
      expect(extra, `${s.name} 里有注册表 ${s.key} 没登记的值：${extra.join(", ")}`).toEqual([]);
    }
  });

  it("探针：本票（MATT-43）登记的四条规则表约束都被上面那条真核过", () => {
    const mine = structLanded.filter((s) => s.table === "mn_automation_rule");
    expect(mine.map((s) => s.name).sort()).toEqual([
      "ck_mn_automation_rule_action_type",
      "ck_mn_automation_rule_host_type",
      "ck_mn_automation_rule_trigger_target",
      "ck_mn_automation_rule_trigger_type",
    ]);
    // 探针要证明"不是被跳过的"：表已建 ⇒ 每条都在迁移里找得到
    for (const s of mine)
      expect(
        checks.find((c) => c.name === s.name),
        s.name,
      ).toBeTruthy();
  });

  it("STRUCT 反向加固：有落点且表已建的行，每个值至少被一个落点用满（防'整体收窄'）", () => {
    for (const s of STRUCT_REGISTRY) {
      const targets = STRUCT_CHECKS[s.key] ?? [];
      if (targets.length === 0) continue; // 无落点的行（如 extra_condition.op）不参与
      const union = new Set<string>();
      for (const [table, , name] of targets) {
        if (!new RegExp(`CREATE TABLE (IF NOT EXISTS )?"${table}"`).test(migrationSql)) continue;
        for (const v of checks.find((c) => c.name === name)?.values ?? []) union.add(v);
      }
      if (union.size === 0) continue; // 落点的表全都没建：见上一条的说明
      const missing = s.values.map(String).filter((v) => !union.has(v));
      expect(missing, `${s.key} 的值没有任何落点认领：${missing.join(", ")}`).toEqual([]);
    }
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

/**
 * 同构表对「列集合 diff 为空」契约测试（W1-3 收尾 / MATT-8）。
 *
 * ## 为什么需要它（不是"代码保证就够了"）
 *
 * `mn_matter_*` 与 `mn_risk_matter_*` 三对表由 `hosts.ts` 的工厂函数
 * （`staffTable`/`partyLinkTable`/`nodeTable`）产出，结构一致**当下**是代码保证的。
 * 但 spec 里那类「两条 SQL 各扫自己表」的跨宿主查询（如节点到期卡的 UNION）要成立，
 * 靠的是"两张表真的同构"这个前提——而它没有任何东西在改列时当场拦住。
 * 工厂函数只能保证"这一次生成时一致"，保证不了"以后没人只给一侧加列"。
 *
 * ## 为什么读迁移 SQL 而不是读 Drizzle 列定义
 *
 * 与上面 CHECK 比对同一条理由（禁令④：迁移文件是唯一事实）。比 TS 只能证明
 * "两份 TS 互相抄对了"，库照样可以不一样。而且这里复用同一个 `migrationSql`——
 * 本文件已经有"按文件名排序读全部迁移"的逻辑，再建一套就是第四份比对口径。
 *
 * ## 唯一合法的差异：宿主外键列名
 *
 * 实测（三对表逐列对过）：原始差集**恰好只有** `matter_id` ↔ `risk_matter_id` 这一处，
 * 归一化成 `host_id` 之后三对的列集合完全相等（5/5、7/7、25/25）。
 * 所以测试做两件事，缺一不可：
 *   1. 归一化后对称差为空 —— 这才是"同构"的断言；
 *   2. 原始差集**必须恰好等于**那一对宿主列 —— 否则"归一化"会变成一块遮羞布：
 *      有人给一侧加一列、再给另一侧加个不同名的列，归一化后的相等断言照样绿。
 *
 * 将来若出现第二条合法差异，必须写进 `ISO_ALLOWED_DIFFS` 并写明理由——
 * 白名单为空是当前的事实，不是"懒得填"。
 */
const ISO_PAIRS = [
  { a: "mn_matter_staff", b: "mn_risk_matter_staff" },
  { a: "mn_matter_party", b: "mn_risk_matter_party" },
  { a: "mn_matter_node", b: "mn_risk_matter_node" },
  // 第四对（MATT-47 / 迁移 0011）。加进来的理由与本文件上面那段完全一样：
  // 工厂函数只保证"这一次生成时一致"，保证不了"以后没人只给一侧加列"——
  // 而这张表刚建，正是最容易被后来者只补一侧的时候。
  { a: "mn_matter_expense", b: "mn_risk_matter_expense" },
] as const;

/** 宿主外键列：`matter_id` / `risk_matter_id` 都归一成它，这是唯一的合法差异 */
const HOST_FK = /^(?:risk_matter|matter)_id$/;
const HOST_FK_NAMES = ["matter_id", "risk_matter_id"];

/** 显式列白名单：目前为空（宿主列由归一化处理，不算例外）。加条目必须带理由。 */
const ISO_ALLOWED_DIFFS: Record<string, { onlyA?: string[]; onlyB?: string[] }> = {};

/**
 * 抽一张表的列名集合：`CREATE TABLE` 的列行 + 后续迁移里的 `ADD COLUMN` / `DROP COLUMN`。
 *
 * 只读 `CREATE TABLE` 会留一个盲区：以后有人用迁移给一侧加列，基线里看不出来，
 * 测试就成了"只守第一天的同构"。这里把两种 DDL 都算上。
 * `CONSTRAINT` 行不是列，跳过。
 */
function columnsOfTable(table: string): string[] | null {
  const create = new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`).exec(migrationSql);
  if (!create?.[1]) return null;
  const cols = create[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'))
    .map((l) => /^"([^"]+)"/.exec(l)?.[1])
    .filter((c): c is string => typeof c === "string");

  // 后续迁移的列级变更（按语句逐个扫，避免跨语句误配）
  const alter = new RegExp(
    `ALTER TABLE "${table}"[^;]*?\\b(ADD|DROP) COLUMN\\s+"?([a-z0-9_]+)"?`,
    "gi",
  );
  for (const m of migrationSql.matchAll(alter)) {
    const [, op, col] = m;
    if (!op || !col) continue;
    if (op.toUpperCase() === "ADD" && !cols.includes(col)) cols.push(col);
    if (op.toUpperCase() === "DROP") {
      const i = cols.indexOf(col);
      if (i >= 0) cols.splice(i, 1);
    }
  }
  return cols;
}

describe("同构表对：列集合 diff 为空（W1-3 / MATT-8）", () => {
  it("解析器没空转：四对表都解析出了列", () => {
    // 校验类脚本最典型的空转形态是"正则没命中 ⇒ 零条 ⇒ 看起来和全部一致一样绿"
    //（本文件上面那条注释记着同一个教训）。所以先证明真读到了东西。
    for (const { a, b } of ISO_PAIRS) {
      const ca = columnsOfTable(a);
      const cb = columnsOfTable(b);
      expect(ca, `迁移里找不到 CREATE TABLE "${a}"`).toBeTruthy();
      expect(cb, `迁移里找不到 CREATE TABLE "${b}"`).toBeTruthy();
      expect(ca?.length ?? 0).toBeGreaterThan(3);
      expect(cb?.length ?? 0).toBeGreaterThan(3);
      // 探针列：只断行数的话，"整列解析丢了但两侧一起丢"也能绿
      expect(ca).toContain("id");
      expect(cb).toContain("id");
      expect(ca).toContain("created_at");
      expect(cb).toContain("created_at");
    }
  });

  it.each(ISO_PAIRS.map((p) => [p.a, p.b] as const))(
    "%s 与 %s 归一化宿主列后列集合相等",
    (a, b) => {
      const ca = columnsOfTable(a) ?? [];
      const cb = columnsOfTable(b) ?? [];
      const na = ca.map((c) => (HOST_FK.test(c) ? "host_id" : c));
      const nb = cb.map((c) => (HOST_FK.test(c) ? "host_id" : c));
      const onlyA = na.filter((c) => !nb.includes(c));
      const onlyB = nb.filter((c) => !na.includes(c));
      const allowed = ISO_ALLOWED_DIFFS[a] ?? {};
      expect(
        onlyA.filter((c) => !(allowed.onlyA ?? []).includes(c)),
        `${a} 独有而 ${b} 没有的列：${onlyA.join(", ")}`,
      ).toEqual([]);
      expect(
        onlyB.filter((c) => !(allowed.onlyB ?? []).includes(c)),
        `${b} 独有而 ${a} 没有的列：${onlyB.join(", ")}`,
      ).toEqual([]);
    },
  );

  it.each(ISO_PAIRS.map((p) => [p.a, p.b] as const))(
    "%s 与 %s 的**原始**差集恰好只有宿主外键列",
    (a, b) => {
      const ca = columnsOfTable(a) ?? [];
      const cb = columnsOfTable(b) ?? [];
      const rawOnlyA = ca.filter((c) => !cb.includes(c));
      const rawOnlyB = cb.filter((c) => !ca.includes(c));
      // 这条是防"归一化变遮羞布"的：两侧各加一个不同名的列，归一化后的相等断言会绿。
      expect(rawOnlyA.sort(), `${a} 的原始独有列`).toEqual([HOST_FK_NAMES[0]]);
      expect(rawOnlyB.sort(), `${b} 的原始独有列`).toEqual([HOST_FK_NAMES[1]]);
    },
  );

  it("白名单当前为空（有例外就必须写进 ISO_ALLOWED_DIFFS 并写明理由）", () => {
    expect(Object.keys(ISO_ALLOWED_DIFFS)).toEqual([]);
  });
});

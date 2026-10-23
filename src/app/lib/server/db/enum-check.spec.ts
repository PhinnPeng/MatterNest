import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_MAX_LENGTH,
  AUDIT_ACTIONS,
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
 * 剥掉 SQL 行注释（`-- …` 到行尾）与块注释（`/` + `*` 起、`*` + `/` 止）。
 *
 * 为什么必须剥：迁移文件里**到处是注释**（本仓的迁移头注很长，且注释里就写着
 * `CONSTRAINT "ck_xxx" CHECK (col IN ('a','b'))` 这种**示例**）。不剥的后果有两个方向：
 * 一是注释掉真实约束后门禁**不红**（实测过），二是注释里的示例会被**误当成真约束**。
 *
 * ⚠ 注释里**不能出现「星号紧跟斜杠」这个定界符序列** —— 它会让 JSDoc 提前闭合，
 * 后面的文字变成代码，而解析器要到几十行之后才报 `';' expected`，极难定位。
 * 本行原稿里那个零宽空格恰好掩盖了这个缺陷：它让该序列不被认作定界符。
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** 只认 `CHECK (col IN ('a','b',…))` 这一种字面量集合形态：DDL 里带参数占位符的写法本身非法（禁令②） */
export function parseEnumChecks(sql: string): ParsedCheck[] {
  const out: ParsedCheck[] = [];
  /** 每个约束名最后一次出现的 CREATE 位置（用于区分"被删掉的"与"删后重建的"） */
  const created = new Map<string, number>();
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
    created.set(name, m.index ?? 0);
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
  /**
   * 被后续迁移 `DROP CONSTRAINT` 掉的约束**不是现行事实**，不该再要求注册表认领。
   *
   * 触发这一条的实例是迁移 0019（删除两处 `currency`）：`ck_mn_matter_currency` 仍出现在
   * 0000 的建表语句里，但列已经删了。反过来，如果同名约束在 DROP 之后又被重建（扩值域
   * 的正规姿势是 `DROP + ADD`，但名字通常换新的），DROP 早于最后一处 CREATE 就仍算现行。
   */
  const retired = new Set<string>();
  for (const m of clean.matchAll(/DROP\s+CONSTRAINT\s+"?([a-z0-9_]+)"?/gi)) {
    const name = m[1];
    if (name && (m.index ?? 0) > (created.get(name) ?? -1)) retired.add(name);
  }
  return out.filter((c) => !retired.has(c.name));
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

/* ==========================================================================================
 * 审计动作「有没有写入点」——补本文件前半段在结构上就看不见的那一半
 * ========================================================================================== */

/**
 * ## 这一组补的是什么盲区
 *
 * 上面三组核的是「注册表 ↔ CHECK ↔ 文档三方一致」。三方一致只能证明**三份抄的是同一个
 * 值集合**；三份**一起**抄错时它们全绿。而审计动作最要命的错法恰恰就是三方一致地写着一个
 * **没人写得出来的值**：值域里有 `MATTER_DELETED`、CHECK 认它、文档列它、中文名表翻它，
 * 于是"删除案件有留痕"在纸面上成立 —— 而**没有任何一条断言问过：有没有代码真的写出它**。
 *
 * 实测（2026-10-13）：生产 `.ts` 179 个、有字面量的写入点 37 处；清单 46 个动作里
 * **29 个有写入点，17 个没有**。那 17 个不是笔误（逐条出处见 `AUDIT_WITHOUT_WRITESITE`），
 * 这条门禁也不负责消灭它们 —— 它负责**钉住那笔账**：
 *   · 新增一个没人写的动作 → 立刻红（要么补上写入点，要么把理由写进白名单）；
 *   · 某个动作已经写出来了、白名单条目却忘了删 → 也立刻红（那条理由会变成过期承诺）。
 *
 * ⚠ 2026-10-14 起是 **45 个动作 / 29 有写入点 / 16 没有**：`ACCESS_DENIED_WRITE` 被
 * **退役**（从 `AUDIT_ACTIONS` 与 DB CHECK 里物理删掉），不是被"注掉"。理由与裁定见下面
 * `AUDIT_WITHOUT_WRITESITE` 上方那段 ⚠ —— 它是这个文件里唯一一个**从清单里消失**的动作，
 * 所以留了一枚钉子在那儿，防止下一个人照着调查报告把它"补"回来。
 *
 * ⚠ 演示数据不算写入点：`db/seed/0003_demo.sql` 里躺着一行 `'PROGRESS_CREATED'`，
 * 那是 seed 造的，不是任何用户操作产生的。所以本门禁**只读 `.ts`**，不读 SQL。
 */

/**
 * 扫描范围：**生产** `.ts`/`.tsx`。三处刻意的排除，各有各的理由：
 *
 *   1. `*.spec.ts` —— 测试里的造数不是用户操作。`parties.spec.ts:361` 那种
 *      "注释里提一句动作名"更不该算落点。
 *   2. 迁移目录（`MIGRATIONS`）—— 那里今天只有 `.sql`/`.json`，**这条排除本身是空转**，
 *      所以下面专门有一条断言钉住它是条真规则（目录非空 + 谓词对迁移目录里的 `.ts`
 *      确实返回 false），而不是"碰巧没扫到"。
 *   3. `node_modules` / `.next` / `.git` —— 不是源码。
 *
 * ⚠ 第二个根 `worker/`：今天只有一份 README（0 个 `.ts`），列进来是给将来用的 ——
 * 提醒调度与自动化执行器（MATT-61 / MATT-73/74）真落地时很可能落在 `worker/` 里，
 * 门禁不该因为"我只看 src"而看不见那边的写入点。
 */
const SCAN_ROOTS = ["src", "worker"] as const;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkTsFiles(path, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * 范围谓词**单独成函数**：下面那条契约断言要能直接调它，才能证明排除规则还活着
 * （只断言"被扫文件里没有迁移目录的东西"的话，删掉排除那半句测试照样绿 —— 因为
 * 迁移目录里今天根本没有 `.ts`，排除与否结果一样）。
 */
function isScannable(file: string): boolean {
  return !file.endsWith(".spec.ts") && !file.startsWith(MIGRATIONS);
}

const scanFiles = SCAN_ROOTS.flatMap((root) => walkTsFiles(root))
  .filter(isScannable)
  .sort();

/**
 * 剥掉 TS 注释：行注释与块注释都换成**等长空格**。
 *
 * 等长 + 留换行是关键：行号是从剥完的文本上数的，替换成 `""` 会让后面所有位置的行号偏掉，
 * 报错指到一个不相干的行 —— 而这份报错是本门禁唯一的沟通手段。
 *
 * 为什么必须剥：本仓注释里**到处**是动作名（`db/schema/outbox.ts:10` 提
 * `AUTO_RULE_SKIPPED`、`import.ts:551` 提 `PARTY_MERGED`）。把注释掉的写入点算成真落点，
 * 就是给"这个动作有出处"打假条 —— 而那正是本门禁要防的事。
 *
 * ⚠ 已知窄口（说清楚而不是藏起来）：正则分不清字符串里的 `//` 与 `/*`。实测 2026-10-13，
 * 179 个生产文件里字符串字面量含 `//` 的有 **0 处**，所以今天剥与不剥结果完全一致。
 * 真出现时的后果是**少报**（多一条"没有写入点"）⇒ 当场红，不是静悄悄的假通过。
 */
function stripTsComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

const OPEN_CHARS = new Set(["{", "(", "["]);
const CLOSE_CHARS = new Set(["}", ")", "]"]);
const QUOTE_CHARS = new Set(['"', "'", "`"]);
const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** 从 `i`（引号本体）走到闭合引号。模板串的 `${…}` 插值递归吃掉，否则插值里的括号会打乱配平 */
function endOfString(code: string, i: number): number {
  const quote = code[i];
  if (quote === undefined) return i;
  for (i++; i < code.length; i++) {
    const c = code[i] ?? "";
    if (c === "\\") i++;
    else if (c === quote) return i;
    else if (quote === "`" && c === "$" && code[i + 1] === "{") i = endOfBlock(code, i + 1);
  }
  return i;
}

/** 从 `i`（`{`）走到配平的 `}` */
function endOfBlock(code: string, i: number): number {
  let depth = 0;
  for (; i < code.length; i++) {
    const c = code[i] ?? "";
    if (QUOTE_CHARS.has(c)) i = endOfString(code, i);
    else if (OPEN_CHARS.has(c)) depth++;
    else if (CLOSE_CHARS.has(c) && --depth === 0) return i;
  }
  return i;
}

/**
 * `i` 处是不是裸键 `key`（其后跟空白与 `:`，其前不是 `.` 或标识符字符）。
 * `activityLog.action` 与 `actionLog:` 都得被排除，否则认错字段。
 */
function isKeyAt(code: string, i: number, key: string): boolean {
  if (!code.startsWith(key, i)) return false;
  if (IDENT_CHAR.test(code[i + key.length] ?? "")) return false;
  let j = i + key.length;
  while (j < code.length && /\s/.test(code[j] ?? "")) j++;
  if (code[j] !== ":") return false;
  for (let k = i - 1; k >= 0 && /\s/.test(code[k] ?? ""); k--) {
    const prev = code[k] ?? "";
    if (prev === "." || IDENT_CHAR.test(prev)) return false;
  }
  return true;
}

/** 调用的实参区间：按 depth-0 的逗号切 */
function callArgs(code: string, openParen: number): [number, number][] {
  const args: [number, number][] = [];
  let depth = 0;
  let start = openParen + 1;
  for (let i = openParen; i <= code.length; i++) {
    const c = code[i] ?? "";
    if (QUOTE_CHARS.has(c)) i = endOfString(code, i);
    else if (OPEN_CHARS.has(c)) depth++;
    else if (CLOSE_CHARS.has(c) && --depth === 0) {
      args.push([start, i]);
      break;
    } else if (c === "," && depth === 1) {
      args.push([start, i]);
      start = i + 1;
    }
  }
  return args;
}

/**
 * 对象字面量里 **depth-0** 的 `action:` 字段：行号 + 其中的字符串字面量。
 *
 * 只认 depth-0 —— `payload` / `diffs` 这些嵌套对象里的 `action` 不是审计动作字段。
 * 值读到 depth-0 的逗号为止，于是
 * `action: archiving ? "ARCHIVED" : "STATUS_CHANGED"`（`matters.ts:509` / `risks.ts:1032`）
 * 与跨行的节点三选一（`matters.ts:685` / `risks.ts:1459`）被**整段**收下，不会只收前半截。
 *
 * 字面量按引号成对取，**不做子串匹配**：`"ARCHIVED"` 不可能从 `"UNARCHIVED"` 里长出来，
 * `"ARCHIVED"` 也不会被 `ARCHIVED` 这种裸词匹配上。
 */
function actionFields(code: string, objOpen: number): { line: number; values: string[] }[] {
  const objClose = endOfBlock(code, objOpen);
  const out: { line: number; values: string[] }[] = [];
  let depth = 0;
  for (let i = objOpen + 1; i < objClose; i++) {
    const c = code[i] ?? "";
    if (QUOTE_CHARS.has(c)) {
      i = endOfString(code, i);
      continue;
    }
    if (OPEN_CHARS.has(c)) depth++;
    else if (CLOSE_CHARS.has(c)) depth--;
    else if (depth === 0 && isKeyAt(code, i, "action")) {
      const from = code.indexOf(":", i) + 1;
      let inner = 0;
      let j = from;
      for (; j < objClose; j++) {
        const cc = code[j] ?? "";
        if (QUOTE_CHARS.has(cc)) j = endOfString(code, j);
        else if (OPEN_CHARS.has(cc)) inner++;
        else if (CLOSE_CHARS.has(cc)) inner--;
        else if (cc === "," && inner === 0) break;
      }
      out.push({
        line: code.slice(0, from).split("\n").length,
        values: [...code.slice(from, j).matchAll(/"([^"]*)"|'([^']*)'/g)].map(
          (m) => m[1] ?? m[2] ?? "",
        ),
      });
      i = j;
    }
  }
  return out;
}

/** 一处审计写入点：哪个文件第几行的 `action:` 字段里出现了哪些字面量 */
type WriteSite = { file: string; line: number; values: string[] };

/**
 * 两个产出形态（`activity.ts` 的文件头已把"唯一入口"写死，所以只有这两种）：
 *   1. `logActivity(tx, actor, { … })`
 *   2. `tx.insert(activityLog).values({ … })` —— `users.ts` 的账号类动作自己直写
 *
 * **实参必须是对象字面量**这一条，同时挡掉三样东西：
 *   · `logActivity` 自己的函数声明（第三实参是 `e: { … }`，不是字面量）；
 *   · `select({ action: activityLog.action })` 这种**读形态**（`matters.ts:238` /
 *     `overview.ts:89` / `risks.ts:873`）—— 它们压根不是实参；
 *   · 顺带把 `activity.ts:28` 那句 `action: e.action`（透传，不是字面量）也筛掉了。
 */
const PRODUCER_RE = /(?:\blogActivity\s*\(|\.insert\(\s*activityLog\s*\)\s*\.values\s*\()/g;

export function scanSource(file: string, source: string): WriteSite[] {
  const code = stripTsComments(source);
  const sites: WriteSite[] = [];
  for (const m of code.matchAll(PRODUCER_RE)) {
    // 匹配串**以 `(` 结尾**，实参起点是它的最后一位。
    // 用 `indexOf("(", m.index)` 会落到 `insert(` 的那个括号上 —— 那是 `.values(` 的实参，
    // 于是 `users.ts` 的 5 个直写点会全部消失（本轮真踩过：少扫 5 处仍"看起来对"）。
    for (const [start, end] of callArgs(code, (m.index ?? 0) + m[0].length - 1)) {
      const arg = code.slice(start, end);
      const lead = /^\s*/.exec(arg)?.[0].length ?? 0;
      if (arg[lead] !== "{" || !arg.trimEnd().endsWith("}")) continue;
      for (const field of actionFields(code, start + lead)) {
        // 只有**含字符串字面量**的 `action:` 才算写入点：`activity.ts:28` 那句 `action: e.action`
        // 是入口的搬运（把上游的值原样塞进行里），它不产出任何动作名，不该占一个"落点"。
        if (field.values.length === 0) continue;
        sites.push({ file, ...field });
      }
    }
  }
  return sites;
}

const writeSites = scanFiles.flatMap((f) => scanSource(f, readFileSync(f, "utf8")));

/**
 * 只认清单里的真值。节点三选一的条件串（`status === "completed"` / `"cancelled"`）
 * 也落在 `action:` 的值里，但它们不是动作名 —— 按清单过滤掉，而不是让它们混进"已产出"。
 */
const ALL_ACTIONS: readonly string[] = AUDIT_ACTIONS;
const produced = new Set(
  writeSites.flatMap((s) => s.values).filter((v) => ALL_ACTIONS.includes(v)),
);
/** 清单里有、但全仓没有任何写入点产出的动作 */
const deadActions = ALL_ACTIONS.filter((a) => !produced.has(a));
/** 产出某个动作的全部文件（去重排序） */
const filesProducing = (action: string): string[] =>
  [...new Set(writeSites.filter((s) => s.values.includes(action)).map((s) => s.file))].sort();

/**
 * 没有写入点的动作，**逐条**写明理由。键 = 动作值，值 = 为什么它现在没有落点。
 *
 * 纪律（同本文件其它白名单一致）：
 *   · **一条理由都不许是占位符**（下面那条断言要求理由里带票号或 file:line 出处）；
 *   · 每条都要说清它是「等某张票」「已作废」还是「真缺口」—— 三种状态的处置完全不同，
 *     混在一起写就会有人拿"等票"去解释一个根本没排期的洞；
 *   · ⚠ 开头的几条**特别标了"MATT-62 只在顺带核对那节提到它"**：那张票会关掉，
 *     但关掉它**不会**顺带给出写入点。把票号当落点承诺，是这份白名单最容易犯的错。
 *
 * 顺序与 `AUDIT_ACTIONS` 一致，方便逐行 diff。
 *
 * ## ⚠ 这份白名单不是「待补清单」：从清单里消失的动作去了哪里
 *
 * 2026-10-14，`ACCESS_DENIED_WRITE` 从这里**删掉了一条**，同时也从 `AUDIT_ACTIONS`、
 * `AUDIT_ACTION_LABELS` 与 `ck_mn_activity_action` 里删掉了这个值（迁移 0014）。
 * 两半必须同批，缺一半就是本文件开头写的那种"三方一致地写着没人写得出的值"。
 *
 * 为什么是删除而不是本文件里 `SENSITIVE_FIELD_READ` 那种「保留 + @deprecated」：
 * §5.3 那条禁令的前提是**历史行存在**，而这一条从来没落进过一行——本文件扫了
 * `src/**` 的全部写入点（零命中），`db/seed/*.sql` 也零命中。更硬的理由是它**记不进去**：
 * `mn_activity_log.target_id` 是 `NOT NULL`、`target_type` 只有 E03 那 7 个取值，
 * "没有权限的人要建账号"这类拒绝既没有 `target_id` 也没有合法 `target_type`。
 *
 * ⚠ **要把 `ACCESS_DENIED_WRITE` 加回来的人，先读这一段**：它不是一个"还没排期的缺口"，
 *   而是**被裁掉的**。`docs/survey-missing-seams.md` §5.2 把它列成"先退役（路 B）"，
 *   同一节也写明了路 A 的前置是"一次 `activity_log` 表结构迁移 + 一条 spec 修订"。
 *   那笔迁移（`target_id` 可空 / `target_type` 扩域）落地之前，加回来只会得到
 *   第二条"声明了、但谁也写不出来"的动作 —— 正是本门禁要抓的那种洞。
 */
const AUDIT_WITHOUT_WRITESITE: Record<string, string> = {
  // ⚠ `MATTER_DELETED` 原在这里登记"等 MATT-62"，2026-10-15 随该票交付**整条删除**
  //   （规矩同上：有写入点的条目不许留着）。
  //   写入点：`services/matters.ts` 的 `deleteMatter`（软删 `is_deleted` + `deleted_at`，
  //   不硬删 —— 修订稿 §12.4，FK 一律 RESTRICT），审计与 `RISK_DELETED` 同形。
  //   裁定：**已归档案件允许删除**（材料缺项已由 `ARCHIVED` 审计结清；
  //   删除要的是归属，不该与 `can_unarchive` 绑在一起）。判据：`agent-work/smoke-delete.mjs`。
  // ⚠ `NODE_DELETED` 原在这里登记"暂无票"，2026-10-23 随节点删除一起落地，整条删除
  //   （写入点：`deleteMatterNode` / `deleteRiskNode`）。
  PROGRESS_UPDATED:
    "**MATT-59 只交付了创建路径**（`services/matters.ts` 的 `addProgress`），进展的编辑与删除没有端点。⚠ 演示库里已经有 `PROGRESS_CREATED` 一行（`db/seed/0003_demo.sql`）—— 那正是本门禁坚持只读 `.ts` 的理由：演示数据写进去过，不等于任何用户操作产生过它。",
  PROGRESS_DELETED:
    "同 `PROGRESS_UPDATED`：MATT-59 给了创建，删除仍无端点。判定口径已定：**软删不算投入**（不刷新 `last_progress_at`），否则删一条进展就能让规则 4 以为有人刚处理过。",
  PARTY_DELETED:
    "`parties/[id]/route.ts` 只有 `GET` 与 `PATCH`。**删除当事人走合并**：同一条留痕是 `PARTY_MERGED`（`party-merge.ts`，载荷含「谁活下来、谁被并走」）。当事人是费用/进展的引用源，硬删与 FK RESTRICT 冲突，这条大概率**永远不会单独出现** —— 若将来真要物理删除，先在这里写明理由再删本条。⚠ 同上：MATT-62 只在「顺带核对（只报告、不改）」那节提到它，不构成落点承诺。",
  COMMENT_DELETED:
    "评论只有发表与编辑：`matters/[id]/comments/route.ts` 仅导出 `POST`（对应 `COMMENT_CREATED` / `COMMENT_UPDATED`）。一期不做删除，**暂无票**。⚠ 同上：MATT-62 只在「顺带核对（只报告、不改）」那节提到它，不构成落点承诺。",
  // ⚠ `ATTACHMENT_UPLOADED` / `ATTACHMENT_DELETED` 原在这里登记"等 MATT-15"，
  //   2026-10-22 随附件通道交付**整条删除**（写入点：`attachments.ts` 的
  //   `attachToComment` 与 `deleteAttachment`）。
  // ⚠ `UNARCHIVED` 原在这里登记"等 MATT-60"，2026-10-15 随该票交付**整条删除**
  //   （本门禁的规矩：已经有写入点的条目不许留着 —— 留着会让下一轮读者以为它还是缺口）。
  //   写入点是 `changeStatus` 的三档动作名：
  //   `archiving ? "ARCHIVED" : unarchiving ? "UNARCHIVED" : "STATUS_CHANGED"`，
  //   `unarchiving = cur.isArchived && target.semantics !== "archived"`
  //   （`matters.ts` / `risks.ts` 两处同改）。
  //   顺带第一次让 `REASON_REQUIRED_ACTIONS` 里"原因恒必填"那条真的生效
  //   （原先只按"偏离推荐路径"判，顺着推荐路径撤归档一个原因都不要）。
  //   判据：`agent-work/smoke-unarchive.mjs` + `agent-work/revred-unarchive.mjs`。
  SENSITIVE_FIELD_READ:
    "**已作废，不是缺口** —— 本组 16 条里唯一一条「白名单本来就是对的」而非「欠一张票」的。裁定：IQ-12 / Q46′（2026-10-10）取消「显示明文」按钮与逐次读取审计，展示层改为全明文；明文外流改由 `EXPORT` 承接、并由 `can_read_plain` 把关。裁定原文写在 `src/shared/enums/audit.ts:14` 的文件头与枚举表 §3.3。本值按 §5.3 废弃流程**保留**在清单、CHECK 与中文名表里，**只为让历史行仍能反查**，不得再写入。它全仓仅有的两处出现都是**反面教材**：`crypto/field-crypto.ts:9` 与 `parties.spec.ts:361` 的注释都在说「别把这东西重新发明一遍」。⚠ 将来若有人正式推翻 IQ-12 恢复逐次审计，先删本条再写代码；在裁定被推翻之前，本条**不该**被当成待补缺口报出来。",
  // ⚠⚠ 原先这里有一条 `ACCESS_DENIED_WRITE`，2026-10-14 已**整条删除**，不再登记。
  //    它不是"补上写入点就行"的那种缺口，是**被裁定退役**的：§5.3 那条"禁止从 CHECK 删值"
  //    的前提（历史行存在）不成立——它从没有过写入点（见本文件上方那段 ⚠），
  //    而 `mn_activity_log.target_id NOT NULL` + 7 值 `target_type` 让它根本写不进去。
  //    要它回来：先做 `activity_log` 的表结构迁移（迁移 0014 的头注与
  //    `docs/survey-missing-seams.md` §5.2「路 A」都写了这件事的前置），再谈动作值。
  // ⚠⚠ 下面五条 2026-10-16 **只改了理由文字，条目本身仍成立**（写入点确实不存在，门禁照旧绿）。
  //    过期的是那两句「等 MATT-61」「等 MATT-73/74」——**两张票都已 Done，而写入点一个都没出现**。
  //    这正是本文件开头点名的错法：把票号当落点承诺。所以状态从「等票」改判成「真缺口、暂无票」。
  AUTO_RULE_EXECUTED:
    "**真缺口、暂无票** —— 原文写「等 MATT-61」，2026-10-16 核对：**#61 已 Done**（提交 `77c5170`），但它交付的是**规则 4 的扫描器**（`stale_30d` 的生产者），不是自动化规则执行器；执行器至今不存在，写入点自然没出现。规则表与预置种子已进库（`db/seed/0006_automation_rules.sql`），去重语义写在 `db/schema/outbox.ts:10` 与迁移 0003 的注释里 —— 但**注释不算写入点**，这正是本门禁存在的理由。⚠ 原文那句预测「它该跟着 MATT-61 变成有写入点」**已被证伪**：票关了、洞还在，且票面上搜不到任何一张覆盖执行器的票（2026-10-16 `search_tasks` 查「执行器」零命中）。⚠ 与 `SENSITIVE_FIELD_READ` 区分开：那一类是**已作废**，这一类是**未实现**。",
  AUTO_RULE_SKIPPED:
    "**真缺口、暂无票**（原「等 MATT-61」已被证伪，同 `AUTO_RULE_EXECUTED`）。三种跳过原因里已有两种以**别的形态**落地、只是不落审计动作：「重复」走 `mn_notification_event.dedupe_key` 唯一键合并并累加 `merge_count`（`notifications.ts:333`），「收件人不可见」走占位 / `void` 投递行（`notifications.ts:361`）—— 两条都写的是投递行，不是本动作。「冷却期」至今无人实现。`skip_reason` 的三个取值见 `docs/PRD-phase1-enums-and-schemas.md:130`。",
  AUTO_RULE_FAILED:
    "**真缺口、暂无票**（原「等 MATT-61」已被证伪，同 `AUTO_RULE_EXECUTED`）。失败态以前置存在执行器为条件：`error` 载荷见 `docs/PRD-phase1-enums-and-schemas.md:131`，而执行器与覆盖它的票都还没有。",
  REMINDER_SENT:
    "**真缺口、暂无票** —— 原文写「等 MATT-73/74」，2026-10-16 核对：**#73（pump 端点）与 #74（应用内定时器）都已 Done**，后一句「调度器还没跑起来」整句过期。调度跑起来了，但投递结果记在**表**里而不是审计里：`mn_notification_delivery` 全项目唯一写入点是 `notifications.ts:365`，状态取 E31 的 `sent` / `void`（`0010_notification_pipeline.sql:126`）⇒ 这个动作名留还是退，取决于一次口径裁定（补写入点，或按 §5.3 走退役流程），现在两者都没排期。",
  REMINDER_FAILED:
    "**真缺口、暂无票**（原「等 MATT-73/74」已被证伪，同 `REMINDER_SENT`）。重试相关列（`attempt` / `error`）已随 `0010_notification_pipeline.sql` 进表，但没有任何代码产出本动作；站内渠道现在是一行写入即终态（`notifications.ts:365`），失败重试尚无生产者。",
};

describe("审计动作 ↔ 写入点：清单里每个值都得有代码真写得出来（白名单那 16 条除外）", () => {
  it("扫描器不是空转：扫到的文件、写入点、已产出动作都在预期量级（2026-10-13 实测 179 / 37 / 29）", () => {
    // 校验类脚本最典型的空转形态是"什么都没扫到 ⇒ 零命中 ⇒ 看起来和全部一致一样绿"
    // （本文件上面三处记着同一个教训）。所以先证明它真读到了东西。
    expect(scanFiles.length, "扫到的生产文件太少（walk 空转或范围写错）").toBeGreaterThan(100);
    expect(writeSites.length, "带字面量的写入点太少（剥注释或括号配平炸了）").toBeGreaterThan(30);
    expect(produced.size, "有写入点的动作太少（判定规则收得太紧）").toBeGreaterThan(25);
    // 只断总数的话，"范围悄悄缩到一个子目录"也可能照样过 ⇒ 再断一下**有多少个文件**在产出
    expect(
      new Set(writeSites.map((s) => s.file)).size,
      "产出动作的文件太少",
    ).toBeGreaterThanOrEqual(8);
    // 清单本身也不能被截断：它是本门禁的输入，输入短了是"核得少"而不是"核得对"
    // （45 = 2026-10-14 退役 `ACCESS_DENIED_WRITE` 之后的现值数；下调这个下限等于放宽"被截短"）
    expect(ALL_ACTIONS.length, "AUDIT_ACTIONS 被截短了？").toBeGreaterThanOrEqual(45);
  });

  it("范围与判定规则各有反例钉住：迁移目录被排除、读形态不算写入点、注释里的值不算", () => {
    // (1) 迁移排除**在生效**，而不是碰巧：目录非空（前提成立）+ 被扫文件全在谓词内 +
    //     谓词对迁移目录里的 `.ts` 确实返回 false。把 `!file.startsWith(MIGRATIONS)`
    //     那半句删掉，这三条里最后一条立刻红。
    expect(readdirSync(MIGRATIONS).length, "迁移目录空了？").toBeGreaterThan(0);
    expect(scanFiles.every(isScannable)).toBe(true);
    expect(isScannable(`${MIGRATIONS}/0001_probe.ts`)).toBe(false);
    expect(isScannable("src/app/lib/server/services/risks.ts")).toBe(true);

    // (2) 读形态不算：`select({ action: activityLog.action })` 不是实参（`matters.ts:238` 等三处）
    expect(
      scanSource("inline.ts", `await db.select({ action: activityLog.action }).from(activityLog);`),
    ).toEqual([]);

    // (3) 注释掉的生产点不算 —— 剥注释真的在干活。
    //     ⚠ 实测当前仓库剥与不剥结果一致（0 处差异），所以这条只能靠构造反例来证明；
    //     等哪天真出现"注释掉的写入点"，它会当场把这条打红。
    expect(
      scanSource(
        "inline.ts",
        [
          "await logActivity(tx, actor, {",
          '  // action: "MATTER_CREATED",',
          '  action: "MATTER_UPDATED",',
          "});",
        ].join("\n"),
      ).map((s) => s.values),
    ).toEqual([["MATTER_UPDATED"]]);

    // (4) 字面量按引号成对取，不做子串匹配：`UNARCHIVED` 不可能从 `UNARCHIVED_PENDING` 里长出来
    expect(
      scanSource("inline.ts", `logActivity(tx, actor, { action: "UNARCHIVED_PENDING" })`).map(
        (s) => s.values,
      ),
    ).toEqual([["UNARCHIVED_PENDING"]]);

    // (5) 两个**假通过**的坑，逐个钉住：
    //     · `PARTY_MERGED` 只有一个产出文件 `party-merge.ts`；`import.ts:551` 那句
    //       "与 `PARTY_MERGED` 同一种落点"是 `//` 注释，**不算写入点**；
    //       哪天有人把注释当证据（或漏剥注释），`import.ts` 会冒出来，这条立刻红。
    expect(filesProducing("PARTY_MERGED")).toEqual(["src/app/lib/server/services/party-merge.ts"]);
    //     · `UNCONVERT` 同理：`expenses.ts:394` 提它是为了说明"所以不硬删"，也在注释里。
    expect(filesProducing("UNCONVERT")).toEqual(["src/app/lib/server/services/risks.ts"]);
  });

  it("双向：没写入点的动作必须逐条登记理由，登记过的也必须还真的没写入点", () => {
    // 两个方向**分开报**是刻意的：合成一条 `toEqual` 时，diff 会把"白名单里多出来的过期条目"
    // 报成"清单里有你没登记的动作" —— 方向反了，读报错的人会去删错的那一边。
    const undeclared = deadActions.filter((a) => !Object.hasOwn(AUDIT_WITHOUT_WRITESITE, a));
    const stale = Object.keys(AUDIT_WITHOUT_WRITESITE).filter((a) => produced.has(a));
    expect(
      undeclared,
      "这些动作没有任何代码写得出来，却没写进 AUDIT_WITHOUT_WRITESITE：补写入点，或写明理由后登记",
    ).toEqual([]);
    expect(
      stale,
      "AUDIT_WITHOUT_WRITESITE 里的这些动作已经有写入点了：该删条目（别让过期承诺留着）",
    ).toEqual([]);
    // 正向相等：两边必须**逐项相等**，不多不少。上面两条各自为空还不够 ——
    // 万一将来有人把 `produced` 算错成空集，这里会同时把两条方向打红（这正是我们要的）
    expect([...deadActions].sort()).toEqual(Object.keys(AUDIT_WITHOUT_WRITESITE).sort());
  });

  it("白名单自身完整：取值都是清单里的真值、理由非空且带出处、无重复", () => {
    const keys = Object.keys(AUDIT_WITHOUT_WRITESITE);
    // 重复键在对象字面量里本来就是 `no-dupe-keys` 报错（lint 会拦），这里再钉一次是因为
    // 白名单将来可能改成从别处拼出来的 —— 那时 lint 就拦不住了
    expect(new Set(keys).size, "白名单里有重复动作").toBe(keys.length);
    for (const [action, reason] of Object.entries(AUDIT_WITHOUT_WRITESITE)) {
      expect(ALL_ACTIONS, `白名单里的 ${action} 不在 AUDIT_ACTIONS 里（拼错了？）`).toContain(
        action,
      );
      expect(reason.trim().length, `${action} 没写理由`).toBeGreaterThan(0);
      // 防"等某某票"式占位符：理由必须带**可核的出处**（票号或 file:line），
      // 否则白名单就退化成一张"先挂着"的表，而那正是它要防的事
      expect(reason, `${action} 的理由里既没有票号也没有文件出处`).toMatch(
        /MATT-\d+|[\w./[\]-]+\.(?:ts|tsx|sql)/,
      );
    }
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `status_config` 的**结构**断言。
 *
 * 值域一致性（E08/E09 与 CHECK）不在这里 —— 那条已经泛化成注册表驱动的通用机制，
 * 见 `./enum-check.spec.ts`。本文件只守"这张表最容易被静默改坏的四件结构"。
 *
 * 基准同样是**迁移 SQL 而不是 `schema.ts`**：禁令④ 规定迁移是唯一事实。
 */
const MIGRATION_DIR = "src/app/lib/server/db/migrations";
/** 整目录读，不硬编码文件名：重命名或重基线时这条结构断言不该跟着炸 */
const migrationSql = readdirSync(MIGRATION_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => `${MIGRATION_DIR}/${f}`)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

describe("status_config 迁移的结构", () => {
  it("三个条件唯一索引都还带 WHERE（丢了就等于权限骨架失效）", () => {
    for (const name of ["ux_status_initial", "ux_status_archived", "ux_status_closed"]) {
      const stmt = migrationSql.split(/;\s*(?=CREATE|--)/).find((s) => s.includes(`"${name}"`));
      expect(stmt, `${name} 不在迁移里`).toBeTruthy();
      expect(stmt).toMatch(/WHERE /);
    }
  });

  it("第四个索引是无条件的 (host_type, code) —— seed 的 ON CONFLICT 目标靠它", () => {
    const stmt = migrationSql
      .split(/;\s*(?=CREATE|--)/)
      .find((s) => s.includes(`"ux_status_code"`));
    expect(stmt).toBeTruthy();
    expect(stmt).not.toMatch(/WHERE /);
    expect(stmt).toMatch(/\("host_type","code"\)/);
  });

  it("生成列写法合法：STORED 且没被塞进任何索引/约束（禁令③）", () => {
    const col = migrationSql.match(/"is_archive_status"[^,\n]*/);
    expect(col?.[0]).toMatch(/GENERATED ALWAYS AS \(semantics = 'archived'\) STORED/);
    expect(migrationSql).not.toMatch(/\(\s*"is_archive_status"\s*[,)]/);
  });

  it("时间列一律带时区；日历日期一律 date（§12.2）", () => {
    // 守的是 spike 抓到的静默坑：`withTimezone` 拼错时 drizzle 不报错，直接产出无时区列。
    const bare = migrationSql.match(/"[a-z_]+"\s+timestamp(?! with time zone)\b/g) ?? [];
    expect(bare, `出现无时区 timestamp 列：${bare.join(" | ")}`).toEqual([]);
    // 日历日期必须是 `date`：写成 timestamp 会因会话时区在跨零点漂一天（§12.2 点名"最容易忽略"）
    expect(migrationSql).toMatch(/"day_key" date NOT NULL/);
    expect(migrationSql).toMatch(/"filing_date" date/);
    expect(migrationSql).toMatch(/"progress_date" date NOT NULL/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 事项侧 `closed` 的显示名：**已处理**（2026-10-14 裁定，取代此前的「了结」）
 *
 * 为什么这件事要钉在测试里：显示名只改 `name` 一列，而 `name` 不参与任何判定，
 * 所以改名**不会让任何代码红**。它只在 seed 重放到已有库时才会发生，而那条 UPDATE
 * 带着 WHERE 守卫（"只改旧显示名，不覆写管理员的定制"）—— 守卫一旦漏了旧值，
 * 已经跑过一轮的库会永远停在「了结」，而新库看起来是对的。**两侧不一致，且不报错。**
 *
 * 所以断言分两半：①新库插入的值；②改名 UPDATE 的 WHERE 仍认旧值。
 * ──────────────────────────────────────────────────────────────────────────── */
const SEED = "src/app/lib/server/db/seed/0000_mn_status_config.sql";
const seedSql = readFileSync(SEED, "utf8");

describe("状态显示名：事项侧 closed =「已处理」，案件侧仍是「已结案」", () => {
  /** INSERT 八行的 (code, name, color, host_type)。只认本仓 seed 的字面量写法。 */
  const seeded = [
    ...seedSql.matchAll(
      /\(\s*\d+\s*,\s*'([a-z_]+)'\s*,\s*'([^']+)'\s*,\s*'([a-z]+)'\s*,\s*'(matter|risk_matter)'/g,
    ),
  ].map((m) => ({ code: m[1]!, name: m[2]!, color: m[3]!, host: m[4]! }));

  it("解析器没空转：八行全抽出来了", () => {
    // 抽不到行时"没有一行叫了结"这类断言会恒真。先证明解析器是活的。
    expect(seeded.map((r) => `${r.host}/${r.code}=${r.name}`)).toEqual([
      "matter/pending=已登记",
      "matter/in_progress=进行中",
      "matter/closed=已结案",
      "matter/archived=已归档",
      "risk_matter/pending=已登记",
      "risk_matter/in_progress=进行中",
      "risk_matter/closed=已处理",
      "risk_matter/archived=已归档",
    ]);
  });

  it("两侧的 closed 显示名**刻意不同**：事项已处理 / 案件已结案", () => {
    // 「结案」是诉讼词，事项尚未进入法律程序。这条分叉是裁定（IQ-5/6），不是漂移。
    const closed = seeded.filter((r) => r.code === "closed");
    expect(closed.map((r) => `${r.host}=${r.name}`).sort()).toEqual([
      "matter=已结案",
      "risk_matter=已处理",
    ]);
  });

  it("`code` 一个都没动 —— 它是接口与规则的引用键，改的只是给人看的那一列", () => {
    expect(seeded.map((r) => `${r.host}/${r.code}`)).toEqual([
      "matter/pending",
      "matter/in_progress",
      "matter/closed",
      "matter/archived",
      "risk_matter/pending",
      "risk_matter/in_progress",
      "risk_matter/closed",
      "risk_matter/archived",
    ]);
  });

  it("改名 UPDATE 仍认旧显示名「了结」—— 否则跑过一轮的库永远改不到", () => {
    // seed 是幂等重放的：上面的 INSERT 带 `ON CONFLICT DO NOTHING`，对老库的八行不生效，
    // 真正改老库的是这条 UPDATE，而它的 WHERE 只在"当前值还是旧名"时才动手。
    // 把旧名从 WHERE 里去掉 ⇒ 新库正确、老库永远停在「了结」，而没有任何一处会报错
    // （`name` 不参与任何判定）。这正是"改名这件事没有任何门禁"的失败形态。
    const guard = seedSql.slice(seedSql.indexOf('WHERE "is_system"'));
    expect(seedSql.indexOf('WHERE "is_system"'), "改名语句里没有 WHERE 守卫").toBeGreaterThan(-1);
    expect(guard).toContain("'已结案'");
    expect(guard, "守卫没认「了结」：已跑过上一轮 seed 的库改不到").toContain("'了结'");
  });

  it("改名 UPDATE 的目标值是「已处理」，不是「了结」", () => {
    const rename = seedSql.slice(seedSql.indexOf('SET "name" = CASE'));
    expect(rename).toMatch(/"host_type" = 'risk_matter' AND "code" = 'closed'\s+THEN '已处理'/);
    expect(rename).not.toMatch(/THEN '了结'/);
  });
});

describe("「了结」只允许留在 seed 的守卫里，不许出现在任何别的地方", () => {
  /** 递归读一个目录下的全部文件（够用的最小实现：同步、只认文本扩展名） */
  function readAll(dir: string, out: { file: string; text: string }[] = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) readAll(p, out);
      else if (/\.(ts|tsx|sql|md)$/.test(e.name))
        out.push({ file: p, text: readFileSync(p, "utf8") });
    }
    return out;
  }

  it("`src/**`（除 seed）里一处都没有 —— 连注释里都不许", () => {
    // 「了结」曾是事项侧 closed 的显示名。它留在任何会被渲染的文本里，等于用户看到的
    // 那一列还是旧词；它留在注释里也危险，因为注释是下一个改这里的人**直接抄**的东西。
    //
    // 唯一豁免：那条改名 UPDATE 的 WHERE 守卫必须列出旧值才改得到老库（上一组断言盯着它）。
    const files = readAll("src");
    expect(files.length).toBeGreaterThan(50); // 解析器没空转
    const hits = files
      .filter((f) => f.file !== SEED.replace(/\\/g, "/"))
      .filter((f) => !f.file.endsWith("status-config.spec.ts")) // 本文件自己引用旧词是必要的
      .filter((f) => f.text.includes("了结"))
      .map((f) => f.file);
    expect(hits, `仍写着「了结」：${hits.join(" | ")}`).toEqual([]);
  });

  it("seed 里「了结」只出现在 WHERE 守卫的旧值列表中，且不是目标值", () => {
    // 豁免不能变成放任：旧词在 seed 里只能活成"要被替换掉的那个旧值"。
    const setCase = seedSql.slice(
      seedSql.indexOf('SET "name" = CASE'),
      seedSql.indexOf('WHERE "is_system"'),
    );
    const insert = seedSql.slice(0, seedSql.indexOf('SET "name" = CASE'));
    expect(insert, "INSERT 的八行里不该再出现旧词").not.toContain("'了结'");
    expect(setCase, "改名的目标值不该是旧词").not.toContain("了结");
  });

  it("GLOSSARY 的词条头是「已处理」，且不再有「了结」这一条", () => {
    // GLOSSARY 是词汇权威源（AGENTS.md 明写），它留着旧词条就会被下次直接抄回代码。
    // `_Avoid_` 里点名旧词是有意的（那是"这些词别再用"的告示），所以只查**词条头**。
    const glossary = readFileSync("GLOSSARY.md", "utf8");
    expect(glossary).not.toMatch(/^\*\*了结\*\*/m);
    expect(glossary).toMatch(/^\*\*已处理\*\*（事项）:/m);
  });
});

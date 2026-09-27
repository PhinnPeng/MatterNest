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

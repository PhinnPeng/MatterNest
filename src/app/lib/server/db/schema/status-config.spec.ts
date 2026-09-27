import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `status_config` 的**结构**断言。
 *
 * 值域一致性（E08/E09 与 CHECK）不在这里 —— 那条已经泛化成注册表驱动的通用机制，
 * 见 `./enum-check.spec.ts`。本文件只守"这张表最容易被静默改坏的四件结构"。
 *
 * 基准同样是**迁移 SQL 而不是 `schema.ts`**：禁令④ 规定迁移是唯一事实。
 */
const migrationSql = readFileSync(
  "src/app/lib/server/db/migrations/0000_status_config.sql",
  "utf8",
);

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

  it("时间列一律带时区（§12.2；spike 抓到过 `withTimeZone` 拼错会静默产出无时区列）", () => {
    expect(migrationSql).not.toMatch(/\btimestamp\b(?!\s+with\s+time\s+zone)/i);
  });
});

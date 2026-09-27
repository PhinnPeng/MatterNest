import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOST_TYPES, STATUS_SEMANTICS } from "@/shared/enums/status";

/**
 * CHECK ↔ 值数组一致性测试（W0-3 要求的"这条错了后面全错"的第一块落地）。
 *
 * 为什么拿迁移 SQL 比而不是比 `schema.ts`：迁移文件是**唯一事实**（禁令④），
 * 而 schema 只是它的生成来源。将来有人直接在迁移尾部手写补丁改了 CHECK，
 * 这份测试会立刻红 —— 比"两边都读 TS"更能抓住漂移。
 */
const migrationSql = readFileSync(
  "src/app/lib/server/db/migrations/0000_status_config.sql",
  "utf8",
);

function checkValues(constraint: string): string[] {
  const line = migrationSql.split("\n").find((l) => l.includes(`CONSTRAINT "${constraint}" CHECK`));
  if (!line) throw new Error(`迁移里找不到 ${constraint} —— CHECK 被删了或改了名`);
  const inner = line.match(/IN \(([^)]*)\)/);
  if (!inner?.[1]) throw new Error(`${constraint} 不是 IN (…) 形态，解析器要跟着改`);
  return inner[1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
}

describe("枚举单一事实源 ↔ 迁移里的 CHECK", () => {
  it("E08 host_type 值域逐字相等，顺序也要求一致", () => {
    expect(checkValues("ck_status_host_type")).toEqual([...HOST_TYPES]);
  });

  it("E09 semantics 值域逐字相等（含 custom 这个 DDL 兜底值）", () => {
    checkValues("ck_status_semantics").forEach((v, i) => expect(v).toBe(STATUS_SEMANTICS[i]));
    expect(checkValues("ck_status_semantics")).toEqual([...STATUS_SEMANTICS]);
  });

  it("partial unique 的 WHERE 都还在（被静默丢掉就等于权限骨架失效）", () => {
    for (const name of ["ux_status_initial", "ux_status_archived", "ux_status_closed"]) {
      const stmt = migrationSql.split(/;\s*(?=CREATE|--)/).find((s) => s.includes(`"${name}"`));
      expect(stmt, `${name} 不在迁移里`).toBeTruthy();
      expect(stmt).toMatch(/WHERE /);
    }
  });

  it("生成列写法合法：STORED 且没被塞进任何索引/约束", () => {
    const col = migrationSql.match(/"is_archive_status"[^,\n]*/);
    expect(col?.[0]).toMatch(/GENERATED ALWAYS AS \(semantics = 'archived'\) STORED/);
    expect(migrationSql).not.toMatch(/\(\s*"is_archive_status"\s*[,)]/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROGRESS_TYPES, PROGRESS_TYPE_LABELS } from "@/shared/enums/business";
import { progressSchema } from "@/shared/schema/hosts";

/**
 * 进展写入（MATT-59）的载荷校验。
 *
 * ## 为什么枚举要跟迁移文件对
 *
 * `mn_matter_progress.progress_type` 的值域由**库里的 CHECK 约束**说了算
 * （`ck_mn_matter_progress_type`），而界面能选什么由 zod 说了算。
 * 两处各写一份，迟早漂移 —— 而漂移的后果是**接口收下一个值、库直接拒**，
 * 报错发生在事务里、看起来像并发问题，不像值域问题。
 *
 * 所以这里把迁移 SQL 当**独立事实源**读出来逐字比对。它不是同义反复：
 * 期望值来自 `.sql` 文件，不是来自被测代码。
 */

/** 与 `enum-check.spec.ts` 同一个口径：相对仓根的路径，vitest 在仓根跑 */
const BASELINE = "src/app/lib/server/db/migrations/0000_mn_baseline.sql";

/** 从 CHECK 约束里把值域抠出来 —— 抠不到就当场红，不许悄悄当成空集通过 */
function progressTypesFromMigration(): string[] {
  const sql = readFileSync(BASELINE, "utf8");
  const m = /ck_mn_matter_progress_type"\s*CHECK\s*\(\s*progress_type IN \(([^)]*)\)\s*\)/.exec(
    sql,
  );
  // 抠不到就抛：**不许**回一个空数组 —— 那会让下面每条断言因为「两边都空」而假绿
  if (!m) throw new Error(`在 ${BASELINE} 里找不到 ck_mn_matter_progress_type 的值域`);
  const list = m[1];
  if (!list) throw new Error("CHECK 约束里没有值域，这是迁移被改坏了");
  return list
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter((s) => s.length > 0);
}

describe("PROGRESS_TYPES ⇔ 库里的 CHECK 约束", () => {
  it("**逐字相等** —— 顺序与集合都算", () => {
    expect([...PROGRESS_TYPES].sort()).toEqual(progressTypesFromMigration().sort());
  });

  it("抠出来的值域不是空的（否则上一条会因为两边都空而假绿）", () => {
    expect(progressTypesFromMigration().length).toBe(6);
  });

  it("每个取值都有中文名，界面不必自己再翻一次", () => {
    for (const t of PROGRESS_TYPES) {
      expect(PROGRESS_TYPE_LABELS[t]).toBeTruthy();
      // 中文名里不许混进下划线 —— 那是「没人写标签」的形态
      expect(PROGRESS_TYPE_LABELS[t]).not.toContain("_");
    }
  });
});

describe("progressSchema：载荷", () => {
  const ok = {
    progressType: "court_action",
    content: "开庭一次，对方缺席，延期 14 天。",
    progressDate: "2026-10-15",
    nextPlan: "补交证据目录",
  };

  it("最小可用载荷通过", () => {
    const r = progressSchema.safeParse(ok);
    expect(r.success).toBe(true);
  });

  it("每个合法 progress_type 都通过", () => {
    for (const t of PROGRESS_TYPES) {
      expect(progressSchema.safeParse({ ...ok, progressType: t }).success).toBe(true);
    }
  });

  it("**非法 progress_type 被拒**，且说清错在哪", () => {
    const r = progressSchema.safeParse({ ...ok, progressType: "whatever" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("progressType");
  });

  it("content 不能为空（空进展会让 last_progress_at 说谎）", () => {
    expect(progressSchema.safeParse({ ...ok, content: "" }).success).toBe(false);
    expect(progressSchema.safeParse({ ...ok, content: "   " }).success).toBe(false);
  });

  it("progressDate 必填，且必须是 ISO 日期 —— 它是 date 列，传瞬时会静默截断", () => {
    expect(progressSchema.safeParse({ ...ok, progressDate: undefined }).success).toBe(false);
    expect(progressSchema.safeParse({ ...ok, progressDate: "" }).success).toBe(false);
    expect(progressSchema.safeParse({ ...ok, progressDate: "2026/10/15" }).success).toBe(false);
    expect(progressSchema.safeParse({ ...ok, progressDate: "2026-10-15" }).success).toBe(true);
  });

  it("nextPlan 可选（没有下一步也是合法进展）", () => {
    const { nextPlan, ...noNext } = ok;
    expect(nextPlan).toBeTruthy();
    expect(progressSchema.safeParse(noNext).success).toBe(true);
  });

  it("nodeId 可选，**给了就必须像 id** —— 它是 matter_node 的外键", () => {
    expect(progressSchema.safeParse({ ...ok, nodeId: undefined }).success).toBe(true);
    expect(progressSchema.safeParse({ ...ok, nodeId: "12" }).success).toBe(true);
    expect(progressSchema.safeParse({ ...ok, nodeId: "abc" }).success).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `rule-config.ts` 这一层的**契约**。
 *
 * ## 为什么不测库
 *
 * 本仓没有离线可跑的库（`pnpm verify` 不许连真库）。而这一层真正会写错的地方不是
 * SQL 本身（它是一次主键/唯一索引查表），是**两件事**：
 *   1. 它有没有把 `is_enabled` 带出来（补执行体那两张票全靠这个字段早退）；
 *   2. 启用集有没有按 `priority` 排序（状态变更分发器按它决定执行次序）。
 *
 * 两件都能在**源码层**钉住，且钉的是"口径在不在"，不是"SQL 拼得对不对"。
 * 后者写错会当场报错，不会静默。
 *
 * ## ⚠ 这份断言的第一版是**假门禁**（反向红当场揭发）
 *
 * 第一版写的是 `expect(SRC).toContain("isEnabled: automationRule.isEnabled")`。
 * 而这句话在本文件里出现 **两次**（两个读出口各一次）—— 于是摘掉**其中一个**，
 * 断言照样通过：注入的是"某个读出口不再带 is_enabled"，门禁却报绿。
 *
 * 教训与本仓 `retro-2026-10-18` 候选 1 同形：**`toContain` 度量的是"存在"，
 * 不是"每一处都在"**。所以下面一律用 `countOf()` 数**次数**，把"两处都要有"
 * 变成断言的一部分。这也是为什么这一档断言必须先反向红再信。
 *
 * ⚠ 已知天花板：它仍证明不了运行时行为（`archive-reminder.spec.ts` 那一档跑纯函数，
 * 那才是行为测试）。这里只放**必须在源码里成立**的口径。
 */
const SRC = readFileSync("src/app/lib/server/services/rule-config.ts", "utf8");

/** 数出现次数。`toContain` 只回答"有没有"，本文件需要"每一处都有" */
function countOf(needle: string): number {
  return SRC.split(needle).length - 1;
}

describe("rule-config：读规则行这一层的四条口径", () => {
  it("**两个**读出口都带 `isEnabled` —— 早退全靠它，少一处就是一个读出口不受开关约束", () => {
    expect(countOf("isEnabled: automationRule.isEnabled")).toBe(2);
    // 类型上也要有（漏了字段类型会退化成 any 而 TS 不报）
    expect(SRC).toMatch(/isEnabled:\s*boolean/);
  });

  it("两个读出口都存在，且**两处的 where 都**排掉软删行", () => {
    expect(countOf("export async function loadRuleByCode")).toBe(1);
    expect(countOf("export async function loadEnabledRules")).toBe(1);
    // 1 处定义 + 2 处引用 = 3
    expect(countOf("notDeleted")).toBe(3);
  });

  it("`loadEnabledRules` 按 `priority` 排序 —— 分发器把顺序当语义", () => {
    expect(SRC).toContain(".orderBy(automationRule.priority, automationRule.id)");
  });

  it("**读不到行返回 null，不抛也不回落常量**（fail-closed）", () => {
    // 回落常量会让"有人删了行"与"规则被停用"得到两种相反的结果（文件头有论证）
    expect(countOf("if (!row) return null;")).toBe(1);
    // 两个读出口各要把两个 jsonb 列以 `{}` 兜底取回（`?? {}` 共 4 处）
    expect(countOf("?? {}) as Record<string, unknown>")).toBe(4);
  });
});

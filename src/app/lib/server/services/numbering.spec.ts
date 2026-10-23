import { describe, expect, it } from "vitest";

import { formatCode } from "./numbering";

/**
 * 编号拼接的纯函数判据（2026-10-23 用户裁定）。
 *
 * 取号本身靠 `mn_code_seq` 的原子 UPSERT，需要真库；这里只守"拿到 dayKey 与 serial
 * 之后怎么拼"——恰恰是 2026-10-15 出过事的那一段（PG `lpad` 会把超长串截断）。
 */
describe("编号拼接", () => {
  it("案件：A + YYYYMMDD + 4 位顺序号", () => {
    expect(formatCode("matter", "20261021", 1)).toBe("A202610210001");
    expect(formatCode("matter", "20261021", 42)).toBe("A202610210042");
    expect(formatCode("matter", "20261021", 9999)).toBe("A202610219999");
  });

  it("事项保持 FX-YYYYMMDD-3 位，不跟着案件改", () => {
    expect(formatCode("riskMatter", "20260922", 1)).toBe("FX-20260922-001");
    expect(formatCode("riskMatter", "20260922", 999)).toBe("FX-20260922-999");
  });

  it("序号溢出后原样加宽，不截断（PG lpad 的坑）", () => {
    expect(formatCode("matter", "20261015", 10000)).toBe("A2026101510000");
    expect(formatCode("riskMatter", "20261015", 1000)).toBe("FX-20261015-1000");
  });
});

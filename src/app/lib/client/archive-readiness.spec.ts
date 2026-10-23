import { describe, expect, it } from "vitest";

import {
  READINESS_TAB,
  STATE_PILL,
  readinessNote,
  type CheckState,
  type ReadinessCheck,
  type ReadinessKey,
} from "./archive-readiness";

const check = (
  over: Partial<ReadinessCheck> & { key: ReadinessKey; state: CheckState },
): ReadinessCheck => ({ ...over });

/**
 * 详情页「归档就绪」表格的说明列。它上一版把"点此去补录"挂在了**已具备**的行上
 * （2026-10-21），三行里两行叫用户去做一件不需要做的事——这几条断言钉的就是那一格。
 */
describe("readinessNote（归档就绪 · 说明列）", () => {
  it("已具备的行不说话：既不引导补录，也不留空字符串", () => {
    expect(readinessNote(check({ key: "closingDate", state: "ok" }), "basic")).toBe("—");
    expect(readinessNote(check({ key: "openNodes", state: "ok", count: 0 }), "nodes")).toBe("—");
  });

  it("缺项且有页签可去 → 说清缺什么、去哪儿补", () => {
    expect(readinessNote(check({ key: "openNodes", state: "missing", count: 2 }), "nodes")).toBe(
      "还有 2 个未决节点 · 点此去补录",
    );
  });

  it("缺项但没有可去的页签 → 不许诺一个点了没反应的动作，也不留空格子", () => {
    expect(readinessNote(check({ key: "judgment", state: "missing" }), null)).toBe("—");
  });

  it("没有数据源的那一档：说原因，且不借用缺项色与齐备色", () => {
    const c = check({ key: "judgment", state: "unavailable", reason: "attachment_not_built" });
    expect(readinessNote(c, READINESS_TAB.judgment)).toContain("还没有给附件分类的入口");
    expect(STATE_PILL[c.state]).toBe("pill gray");
  });

  it("三个状态各有药丸档，且没有一档落进期限色以外的语义", () => {
    expect(Object.keys(STATE_PILL).sort()).toEqual(["missing", "ok", "unavailable"]);
    expect(STATE_PILL.missing).toBe("pill over");
    expect(STATE_PILL.ok).toBe("pill ok");
  });
});

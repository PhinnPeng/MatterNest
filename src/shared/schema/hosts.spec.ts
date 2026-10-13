import { describe, expect, it } from "vitest";
import {
  CONVERT_CARD_COPYABLE_FIELDS,
  CONVERT_CARD_NON_COPYABLE_FIELDS,
  convertCardSchema,
  copyConvertCard,
} from "./hosts";

/**
 * 跨卡复制的白名单纪律（MATT-19 / 矩阵 §3 / 前端 spec 的表格）。
 *
 * 三条断言，缺一条都会留下一个"静默决定"的口子：
 *  1. 白名单 ∩ 黑名单 = ∅ —— 两边都写了同一个字段时，结果会按实现顺序决定，
 *     而"按顺序"这种事没人会去读代码确认。
 *  2. **卡上的每个字段都必须被归类** —— 这条才是白名单纪律的真正价值：
 *     将来给 `convertCardSchema` 加一个字段，若没同步决定它可不可复制，
 *     本测试当场红。少了它，"新字段默认怎样"就取决于实现写的是白名单还是黑名单。
 *  3. 行为断言：复制搬走案由、**不搬案号**，且目标卡自己的案号不被清空。
 */

/** 读 ZodObject 的字段名（与 `zod-rules.ts` 同一套内部形状：`_zod.def.shape`） */
function fieldNamesOf(schema: unknown): string[] {
  const shape = (schema as { _zod?: { def?: { shape?: Record<string, unknown> } } })?._zod?.def
    ?.shape;
  return Object.keys(shape ?? {});
}

describe("转案件卡：跨卡复制的字段白名单", () => {
  it("卡上确实有字段（解析器没空转）", () => {
    const fields = fieldNamesOf(convertCardSchema);
    // 防"shape 取不到 ⇒ 空数组 ⇒ 后面所有断言都真空通过"
    expect(fields.length).toBeGreaterThan(5);
    expect(fields).toContain("caseNo");
    expect(fields).toContain("cause");
  });

  it("白名单 ∩ 黑名单 = ∅", () => {
    const overlap = CONVERT_CARD_COPYABLE_FIELDS.filter((f) =>
      (CONVERT_CARD_NON_COPYABLE_FIELDS as readonly string[]).includes(f),
    );
    expect(overlap, `这些字段同时出现在两边：${overlap.join(", ")}`).toEqual([]);
  });

  it("**卡上每个字段都被归类**（新字段不归类就红）", () => {
    const decided = new Set<string>([
      ...CONVERT_CARD_COPYABLE_FIELDS,
      ...CONVERT_CARD_NON_COPYABLE_FIELDS,
    ]);
    const undecided = fieldNamesOf(convertCardSchema).filter((f) => !decided.has(f));
    expect(
      undecided,
      `这些字段既不在白名单也不在黑名单里：${undecided.join(", ")}。` +
        `加字段时必须同时决定它可不可复制——白名单默认不复制，但"默认"要写下来才算数。`,
    ).toEqual([]);
  });

  it("归类里没有已不存在的字段（防改名后留下孤儿）", () => {
    const fields = new Set(fieldNamesOf(convertCardSchema));
    const orphans = [...CONVERT_CARD_COPYABLE_FIELDS, ...CONVERT_CARD_NON_COPYABLE_FIELDS].filter(
      (f) => !fields.has(f),
    );
    expect(orphans, `这些字段在卡 schema 里已不存在：${orphans.join(", ")}`).toEqual([]);
  });

  it("复制搬走案由与等级，**不搬案号**，且不清空目标卡自己的案号", () => {
    const source = {
      name: "甲案",
      cause: "建设工程施工合同纠纷",
      level: "high",
      caseNo: "COPY-ME",
    };
    const target = { name: "乙案", cause: "买卖合同纠纷", level: "low", caseNo: "KEEP-ME" };
    const out = copyConvertCard(source, target);
    expect(out.cause).toBe("建设工程施工合同纠纷");
    expect(out.level).toBe("high");
    expect(out.name).toBe("甲案");
    // 关键：案号没被抄过去，目标卡自己的也没被抹掉
    expect(out.caseNo).toBe("KEEP-ME");
  });
});

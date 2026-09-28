import { describe, expect, it } from "vitest";

import { alpha, BRAND, INK, PAPER } from "./brand";

/**
 * `alpha()` 的回归 + 唯一源的"一个语义只有一个值"。
 *
 * 为什么给常量文件写测试：lint 只能证明"别处没写色值字面量"，证明不了
 * "同一个语义在这里被抄了两遍"——`sider.accent` 与 `primary` 同值那次就是这样，
 * 改了主色只改到一半，症状要过几屏才看得见。这里把它钉住。
 * （这个文件落在 `src/app/theme/**`，禁令⑦ 的色值规则对它豁免——它就是允许写颜色的地方。）
 */
describe("theme/brand 唯一色值源", () => {
  it("alpha() 把十六进制换成 rgba，通道值不靠人肉换算", () => {
    expect(alpha("#2f5fe0", 0.5)).toBe("rgba(47,95,224,0.5)");
    expect(alpha(BRAND.sider.item, 0.62)).toBe("rgba(195,204,221,0.62)");
  });

  it("alpha() 只吃 6 位十六进制，坏输入立刻抛", () => {
    expect(() => alpha("#fff", 0.5)).toThrow(/6 位十六进制/);
    expect(() => alpha("red", 0.5)).toThrow(/6 位十六进制/);
  });

  it("同一语义不出现两份：墨阶与品牌色互不相同", () => {
    const values = [...Object.values(INK), BRAND.primary, BRAND.overdue, BRAND.soon, PAPER];
    expect(new Set(values).size).toBe(values.length);
  });

  it("导航栏的强调色就是主色本身（不是「差不多蓝」）", () => {
    expect(BRAND.sider.accent).toBe(BRAND.primary);
  });

  it("DEADLINE_TONE 的四档确实分得开：逾期 < 临期 < 主色 < 平静", () => {
    expect(BRAND.overdue).not.toBe(BRAND.soon);
    expect(INK.secondary).not.toBe(INK.muted);
    expect(INK.muted).not.toBe(INK.faint);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { alpha, BRAND, CSS_SCALE, ELEVATION, INK, PAPER, TOKENS, tokensCss } from "./brand";

/**
 * 令牌契约的闸门（MATT-98 / ADR-0006）。
 *
 * 断言的是**同源**，不是好看：明暗两组键集合相等，且每个键能在
 * `.impeccable/mocks/pages/canon.css` 的 `:root` / `body.dark` 两侧找到同值。
 * 颜色好不好看、对比度够不够是 `agent-work/_chk/token-contrast.mjs` 与
 * `contrast-all.mjs` 的事——那种判据依赖本地运行态，按 `.trellis` 的口径不进 CI。
 *
 * 为什么不手抄常量：手抄的那份会在下一次改色时先腐掉，而它腐掉的样子与
 * "两边确实同值"逐字相同。所以这里**读文件解析**，canon.css 是独立的那一边。
 *
 * 这个文件落在 `src/app/theme/**`，禁令⑦ 的"色值只在 brand.ts"对它豁免——
 * 它就是允许写颜色的地方，但**它自己不写色值**：期望值全部来自 canon.css。
 */
const canonCss = readFileSync(
  fileURLToPath(new URL("../../../.impeccable/mocks/pages/canon.css", import.meta.url)),
  "utf8",
);
const globalsCss = readFileSync(fileURLToPath(new URL("../globals.css", import.meta.url)), "utf8");

/** 从一段 CSS 里取 `选择器{…}` 块内的 `--名: 值`（先把注释剥掉，注释里也会出现 `--`）。 */
function readBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector}{`);
  if (start < 0) throw new Error(`CSS 里找不到 ${selector}{ 块`);
  const body = css
    .slice(start + selector.length + 1, css.indexOf("}", start))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1] ?? ""] = m[2]?.trim() ?? "";
  return out;
}

/**
 * 值与写法无关的比较：大小写、空白、行尾分号都不算差异。
 * 取不到的那一侧给空串——"少一个键"于是表现为与真值不等，而不是测试自己崩掉。
 */
const norm = (v: string | undefined) =>
  (v ?? "").replace(/\s+/g, " ").replace(/;$/, "").trim().toLowerCase();
const keysOf = (o: object) => Object.keys(o).sort();

/**
 * canon.css 的 `:root` 与 `body.dark` **本来就不是逐键对齐的**，差在形状/层级两处，
 * 都不该硬凑（也不能改 canon.css —— 它是契约的参考实现）：
 *   · `--radius` 只在 `:root`：形状令牌，深色不改圆角 ⇒ `CSS_SCALE`；
 *   · `--shadow` 两侧都有、但深色那侧是 `none`：形状/层级令牌不是色 ⇒ `ELEVATION`。
 * 剩下的 26 个键是**颜色**，两组必须集合相等——少一个键就是深色下某个面用回浅色值。
 * 跳过面只有这两个名字；多出第三个键就必须成对出现。
 */
const SHAPE_ONLY = ["radius", "shadow"];

describe("theme/brand 令牌同源（canon.css 是另一半）", () => {
  const canonLight = readBlock(canonCss, ":root");
  const canonDark = readBlock(canonCss, "body.dark");
  const canonLightColors = keysOf(canonLight).filter((k) => !SHAPE_ONLY.includes(k));
  const canonDarkColors = keysOf(canonDark).filter((k) => !SHAPE_ONLY.includes(k));

  it("明暗两组同名：颜色键集合相等", () => {
    expect(keysOf(TOKENS.dark)).toEqual(keysOf(TOKENS.light));
    expect(keysOf(TOKENS.light)).toEqual(canonLightColors);
    expect(canonLightColors.length).toBeGreaterThan(20);
  });

  it("brand.ts 没有漏掉 canon.css 的任何一个色（少一个键就红）", () => {
    expect(keysOf(TOKENS.light)).toEqual(canonLightColors);
    expect(keysOf(TOKENS.dark)).toEqual(canonDarkColors);
  });

  it("每个颜色键在 canon.css 的明暗两侧都能找到同值", () => {
    for (const key of keysOf(TOKENS.light)) {
      expect(norm(TOKENS.light[key as keyof typeof TOKENS.light]), `浅色 ${key}`).toBe(
        norm(canonLight[key]),
      );
      expect(norm(TOKENS.dark[key as keyof typeof TOKENS.dark]), `深色 ${key}`).toBe(
        norm(canonDark[key]),
      );
    }
  });

  it("形状/层级令牌也逐值同源，且各归各的段（radius 只进 :root）", () => {
    expect(norm(ELEVATION.light)).toBe(norm(canonLight.shadow));
    expect(norm(ELEVATION.dark)).toBe(norm(canonDark.shadow));
    expect(norm(CSS_SCALE.radius)).toBe(norm(canonLight.radius));
    expect(canonDark.radius).toBeUndefined();
  });

  it("注入的 CSS 两段与两组值逐字相等", () => {
    const css = tokensCss();
    const injectedLight = readBlock(css, ":root");
    const injectedDark = readBlock(css, "html.dark");
    expect(keysOf(injectedLight)).toEqual(
      [...keysOf(TOKENS.light), "shadow", ...keysOf(CSS_SCALE)].sort(),
    );
    expect(keysOf(injectedDark)).toEqual([...keysOf(TOKENS.dark), "shadow"].sort());
    for (const key of keysOf(TOKENS.light)) {
      expect(injectedLight[key], `浅色 ${key}`).toBe(
        TOKENS.light[key as keyof typeof TOKENS.light],
      );
      expect(injectedDark[key], `深色 ${key}`).toBe(TOKENS.dark[key as keyof typeof TOKENS.dark]);
    }
  });

  it("globals.css 只引令牌变量：写错一个名字就红", () => {
    const referenced = [...globalsCss.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(2);
    const defined = [...keysOf(TOKENS.light), ...keysOf(CSS_SCALE), "shadow"];
    for (const name of referenced) {
      expect(defined, `globals.css 引了未定义的 --${name}`).toContain(name);
    }
  });

  it("alpha() 把十六进制换成 rgba，通道值不靠人肉换算", () => {
    expect(alpha(TOKENS.light.accent, 0.5)).toBe("rgba(37,99,235,0.5)");
    expect(alpha(TOKENS.light["nav-ink"], 0.62)).toBe("rgba(55,65,81,0.62)");
  });

  it("alpha() 只吃 6 位十六进制，坏输入立刻抛", () => {
    expect(() => alpha("#fff", 0.5)).toThrow(/6 位十六进制/);
    expect(() => alpha("red", 0.5)).toThrow(/6 位十六进制/);
  });

  /**
   * 迁移期别名（`BRAND` / `INK` / `PAPER`）只是 TOKENS.light 的**视图**：
   * 它们不持有自己的十六进制。批量二把页面搬完就删掉这一层，
   * 这里守着"别名不会变成第二份色值源"——那正是这次转写要消灭的东西。
   */
  it("迁移期别名是浅色令牌的视图，不是第二份色值", () => {
    const light = new Set(Object.values(TOKENS.light));
    const aliased = [
      PAPER,
      ...Object.values(INK),
      BRAND.primary,
      BRAND.success,
      BRAND.overdue,
      BRAND.soon,
      ...Object.values(BRAND.sider),
    ];
    for (const value of aliased) expect(light, `别名 ${value} 不在浅色令牌里`).toContain(value);
  });
});

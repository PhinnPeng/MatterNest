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

  /**
   * `var(--…)` 走 `color-mix`（2026-10-18）。
   *
   * 别名改成令牌引用之后，`alpha(INK.muted, .1)`（提及 chip 的底色）拿到的是一个
   * `var(…)` 而不是十六进制。若在这里抛错，就等于逼调用点退回写死颜色。
   * 百分比而不是小数：`color-mix` 只收百分比，写 `.1` 进去是**无效值**（整条声明被丢，
   * 表现成"底色没了"而不是报错）。
   */
  it("alpha() 收到令牌引用时走 color-mix（不是抛错、也不是小数）", () => {
    expect(alpha("var(--ink3)", 0.1)).toBe("color-mix(in srgb, var(--ink3) 10%, transparent)");
    expect(alpha("var(--accent)", 0.5)).toBe("color-mix(in srgb, var(--accent) 50%, transparent)");
    expect(alpha("var(--ink3)", 0.1)).not.toContain("0.1");
  });

  it("alpha() 只吃 6 位十六进制或 var(--名字)，坏输入立刻抛", () => {
    expect(() => alpha("#fff", 0.5)).toThrow(/6 位十六进制/);
    expect(() => alpha("red", 0.5)).toThrow(/6 位十六进制/);
    // 半个 var（少了右括号 / 名字里有空格）也拒掉：那种值进了 CSS 会被整条丢掉
    expect(() => alpha("var(--ink3", 0.5)).toThrow(/6 位十六进制/);
    expect(() => alpha("var( --ink3 )", 0.5)).toThrow(/6 位十六进制/);
  });

  /**
   * 迁移期别名（`BRAND` / `INK` / `PAPER`）是**令牌引用**，不是第二份色值。
   *
   * 这一条替代了原先的"别名是浅色令牌的视图"。换掉的理由是实测出来的
   * （2026-10-18，`smoke-visual.mjs` 量真页）：别名被当**行内样式**用，而行内样式里
   * 一个十六进制是死的 —— 深色下它们仍旧渲染浅色值，`/roles` 的计数只有 3.08、
   * `/matters` 的逾期红只有 3.62。`pnpm verify` 全绿也照样存在，因为它测量的是渲染结果。
   *
   * 现在守的是更强的一条：每个别名都必须是 `var(--某令牌)`，且那个令牌**真的定义过**。
   * 于是"别名指向一个不存在的令牌"（= 浏览器把整条声明丢掉、文字回落到继承色）会当场红，
   * 而不是等到某个页面在某个外观下变难看。
   */
  it("迁移期别名是**令牌引用**，且每个指向的令牌都真的定义过", () => {
    const defined = new Set([...keysOf(TOKENS.light), ...keysOf(CSS_SCALE), "shadow"]);
    const aliased: Record<string, string> = {
      PAPER,
      ...Object.fromEntries(Object.entries(INK).map(([k, v]) => [`INK.${k}`, v])),
      "BRAND.primary": BRAND.primary,
      "BRAND.success": BRAND.success,
      "BRAND.overdue": BRAND.overdue,
      "BRAND.soon": BRAND.soon,
      ...Object.fromEntries(Object.entries(BRAND.sider).map(([k, v]) => [`BRAND.sider.${k}`, v])),
    };
    for (const [name, value] of Object.entries(aliased)) {
      const m = /^var\(--([\w-]+)\)$/.exec(value);
      expect(m, `${name} = "${value}" 不是 var(--令牌) 形状`).not.toBeNull();
      expect(defined, `${name} 指向未定义的 --${m?.[1]}`).toContain(m?.[1]);
    }
  });
});

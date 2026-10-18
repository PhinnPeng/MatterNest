/**
 * 全站颜色的**唯一色值源**（禁令⑦ 的另一半：一套体系不只是"用一个库"，还包括"一个色只定义一次"）。
 *
 * 这个文件刻意**不 import antd、不 import react**：登录页是 Server Component，只能渲染纯 HTML +
 * 内联样式，一旦引到 `antd.ts` 就会把组件库拖进服务端 bundle（那条约束写在
 * `src/app/(auth)/login/page.tsx`）。所以令牌放这儿，antd 的 token 映射放 `./antd.ts`，
 * 依赖方向只有一个。
 *
 * ## 从"一组色"到"明暗两组同名色"（MATT-98 / ADR-0006）
 *
 * 深色内容区升为一等外观之后，色值不再是一组常量，而是**两组同键名的令牌**：
 * `TOKENS.light` / `TOKENS.dark` 逐键对齐 `.impeccable/mocks/pages/canon.css` 的
 * `:root` / `body.dark`。键名**就是** canon 的变量名去掉 `--` 前缀——不另起一套
 * 转换表（有转换表就有两处会各自演化，`--card-2` 会变成 `cardSunken` 再变成别的）。
 * 于是 `brand.spec.ts` 能逐键比对，`tokensCss()` 也能直接生成 `--键: 值`。
 *
 * canon.css 的 `:root` 与 `body.dark` **本来就不是逐键对齐的**，差在两处，都不该硬凑：
 *   · `--radius` 只在 `:root`（形状令牌，深色不改圆角）⇒ 收进 `CSS_SCALE`，只注入一次；
 *   · `--shadow` 是形状/层级令牌而不是色（深色那侧的值是 `none`）⇒ 收进 `ELEVATION`，
 *     两侧各有一值但**不进"两组同键"的色集合**。
 * 于是 `TOKENS` 两组各 26 个**颜色**键、集合相等；`--tag-edge-*` 三个键明暗同值是刻意的
 * （描边色不随外观变），不是漏改。canon.css **不许改**：它是契约的参考实现，不是草稿。
 *
 * ## 注入方式
 *
 * CSS 侧 import 不到 TS 常量，所以令牌由 `tokensCss()` 生成两段（`:root` 与 `html.dark`）
 * 注入 `<head>`（见 `app/layout.tsx`），`globals.css` 只写 `var(--…)`。
 * 深色类打在 `<html>` 而不是 canon 原型的 `body.dark`：首帧脚本在 `<head>` 里跑，
 * 那一刻 `<body>` 还不存在，只有 `documentElement` 可写。
 *
 * ## 下面的 `BRAND` / `INK` / `PAPER` 是迁移期别名
 *
 * 批量二（MATT-99）逐页搬完之前，老页面还在用它们。它们**只是 `TOKENS.light` 的视图**，
 * 不持有自己的十六进制——`brand.spec.ts` 守着这一条。搬完就该整块删掉。
 */

/** 明暗两台外观。SSR 一律先按浅色渲染，客户端首帧前由 `<head>` 脚本改成已存值。 */
export const APPEARANCES = ["light", "dark"] as const;
export type Appearance = (typeof APPEARANCES)[number];

/** 深色外观的类名，打在 `<html>` 上（CSS 侧的选择器是 `html.dark`）。 */
export const DARK_CLASS = "dark";

/**
 * 浅色（canon.css `:root`）。键名 = canon 的变量名去掉 `--`。
 *
 * 三档墨色的下限是**对比度**而不是好看：`ink` / `ink2` / `ink3` 都在列表里承载要读的词
 * （占位、分组名、"没有值"的 `—`），三档都要过 WCAG AA 正文线 4.5:1。改色前先跑
 * `agent-work/_chk/token-contrast.mjs`（令牌配对）与 `contrast-all.mjs`（渲染实测），别凭肉眼。
 */
const LIGHT = {
  bg: "#F5F6F8",
  card: "#FFFFFF",
  "card-2": "#FAFBFC",
  ink: "#111827",
  ink2: "#4B5563",
  ink3: "#6A717D",
  line: "#E5E7EB",
  line2: "#F0F1F3",
  hover: "#F7F8FA",
  th: "#FAFBFC",
  /**
   * 控件描边是**交互控件的边界**（勾选框 / 开关），WCAG 1.4.11 要求 3:1；
   * `line` 是分隔线（1.24:1，本来就该若有若无）。两者不是一个刻度，所以是两个令牌。
   */
  "control-line": "#90959D",
  "switch-off": "#D7DBE0",
  accent: "#2563EB",
  "accent-ink": "#FFFFFF",
  "accent-weak": "#EFF4FF",
  "accent-line": "#BFD3FA",
  "nav-bg": "#FFFFFF",
  "nav-ink": "#374151",
  "nav-on": "#EFF4FF",
  "nav-on-ink": "#1D4ED8",
  red: "#DC2626",
  amber: "#B55300",
  green: "#008053",
  "tag-edge-green": "#A7E3C7",
  "tag-edge-red": "#F3C2C2",
  "tag-edge-amber": "#F2D6A8",
} as const;

/** 令牌名。两组共用它，所以"明暗同键"在类型上也是硬约束。 */
export type TokenName = keyof typeof LIGHT;

/**
 * 深色（canon.css `body.dark`）。深色不是浅色的机械反转：强调色提亮到 `#4087FB`
 * 以在深底上保持 4.5:1，`shadow` 归零（投影在黑底上不可见，层级改由描边与面色差承担）。
 */
const DARK = {
  bg: "#101317",
  card: "#161A1F",
  "card-2": "#191D22",
  ink: "#E7E9EC",
  ink2: "#A6ADB6",
  ink3: "#8B929C",
  line: "#232830",
  line2: "#1C2126",
  hover: "#1B2026",
  th: "#191D22",
  "control-line": "#60666E",
  "switch-off": "#3A4048",
  accent: "#4087FB",
  "accent-ink": "#0B1220",
  "accent-weak": "#17233A",
  "accent-line": "#2B4670",
  "nav-bg": "#12161A",
  "nav-ink": "#C3C8CE",
  "nav-on": "#1B2735",
  "nav-on-ink": "#8AB4F8",
  red: "#F87171",
  amber: "#FBBF24",
  green: "#34D399",
  "tag-edge-green": "#A7E3C7",
  "tag-edge-red": "#F3C2C2",
  "tag-edge-amber": "#F2D6A8",
  /**
   * `satisfies Record<TokenName, string>` 是这里唯一一处想让编译器替人记事的地方：
   * 漏一个键（浅色有、深色没有）当场编译不过，多一个键也过不了（对象字面量会被检查多余属性）。
   */
} satisfies Record<TokenName, string>;

export const TOKENS = { light: LIGHT, dark: DARK } as const;

/**
 * 尺寸刻度：canon.css 里与颜色并列在 `:root` 的那一项。
 *
 * 它**不分明暗**——撤销 P1-17 撤的只是"只要亮色"，尺寸刻度一律不变（`theme.components.*`
 * 的刻度同理）。所以它不进两组（进了就破坏"两组同键"），只在 `:root` 注入一次。
 */
export const CSS_SCALE = { radius: "6px" } as const;

/**
 * 层级令牌：投影。**不是色**，但两侧各有一值，所以它既不进 `TOKENS`（那是颜色集合），
 * 也不进 `CSS_SCALE`（那是不分明暗的刻度）。
 *
 * 深色下没有投影（`none`）：投影在黑底上不可见，层级改由描边与面色差承担——
 * canon 对深色的这条判断与"深色不是浅色的机械反转"是同一件事。
 */
export const ELEVATION: Record<Appearance, string> = {
  light: "0 1px 2px rgba(16,24,40,.06)",
  dark: "none",
};

/** 取一台外观的令牌表。调用点只该用它，不要自己拼 `TOKENS[mode]` 的分支。 */
export function tokensOf(appearance: Appearance): Readonly<Record<TokenName, string>> {
  return TOKENS[appearance];
}

/**
 * 令牌 → CSS 自定义属性，两段一次给全（`globals.css` 只引 `var(--…)`，不抄值）。
 *
 * 生成的文本由 `app/layout.tsx` 注入 `<head>`；改动这里就等于改动全站色。
 * 两段各自带上该外观的层级令牌，`--radius` 只进 `:root`（见 `CSS_SCALE`）。
 */
export function tokensCss(): string {
  /** 每条声明都带分号（含末条）：少一个分号在拼接时会把两条声明并成一条坏值。 */
  const block = (selector: string, tokens: Record<string, string>) =>
    `${selector}{${Object.entries(tokens)
      .map(([name, value]) => `--${name}:${value};`)
      .join("")}}`;
  return (
    block(":root", { ...LIGHT, shadow: ELEVATION.light, ...CSS_SCALE }) +
    block("html.dark", { ...DARK, shadow: ELEVATION.dark })
  );
}

/* ------------------------------------------------------------------ *
 * 迁移期别名（批量二删）。以下每个值都只是上面 `LIGHT` 里某一项的视图，
 * 这里**不出现第二个十六进制**——`brand.spec.ts` 的"别名是视图"一条守着它。
 * ------------------------------------------------------------------ */

/** 纸色底：长时间读表，纯白的对比噪声更累。 */
export const PAPER = LIGHT.bg;

/**
 * 墨阶（文字与分隔线的四档 + 分隔线/描边与进度轨道）。
 *
 * 之前这些值散在 40 多处内联样式里当字面量用——换库时那种"灰得各不相同"就是回归的源头。
 * 收敛成几个名字之后，"次要信息有多次要"是一个可以被一处改动的决定。
 * （`faint` 与 `rail` 在 canon 里没有单独刻度：占位符归 `ink3`、描边轨道归 `control-line`。）
 */
export const INK = {
  /** 正文 */
  body: LIGHT.ink,
  /** 次级：表头、金额、需要读但不抢焦点的词 */
  secondary: LIGHT.ink2,
  /** 弱级：时间戳、备注、页头/页脚说明文案 —— 也承载 `—` 这种"这个字段没有值"的事实 */
  muted: LIGHT.ink3,
  /** 最弱：占位符、`—`、搜索图标这类引导 */
  faint: LIGHT.ink3,
  /** 分隔线 / 描边 */
  line: LIGHT.line,
  /** 进度轨道、引文竖线：比线更实，但仍不是内容 */
  rail: LIGHT["control-line"],
} as const;

/**
 * 品牌与语义色的迁移期别名。`sider.*` 是老深色导航壳与登录页墨蓝面板那组名字，
 * canon 里没有第二个深色壳（导航改由 `nav-*` 令牌承担），所以它现在指向浅色导航令牌。
 */
export const BRAND = {
  primary: LIGHT.accent,
  /** 达成/完成：只在"数字完成了"这种前景上用，不做整块底色 */
  success: LIGHT.green,
  /** 逾期 / 高风险 / 不可逆操作 */
  overdue: LIGHT.red,
  /** 临期 / 待开通 / 缺材料 */
  soon: LIGHT.amber,
  sider: {
    bg: LIGHT["nav-bg"],
    gradient: LIGHT["nav-on"],
    item: LIGHT["nav-ink"],
    active: LIGHT["nav-on-ink"],
    accent: LIGHT.accent,
  },
} as const;

/**
 * 给一个十六进制色加透明度。
 *
 * 为什么不直接写 `rgba(195,204,221,.62)`：那等于把某个令牌色用另一种记法
 * 再抄一遍，改主色时只会改到一半——"同一颜色三档透明度"正是最容易漏的地方。
 * 只支持 6 位十六进制（本文件里的色都是），传错立刻抛，不静默返回 NaN 串。
 */
export function alpha(color: string, opacity: number): string {
  const hex = color.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`alpha() 只接受 6 位十六进制，收到 "${color}"`);
  }
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${opacity})`;
}

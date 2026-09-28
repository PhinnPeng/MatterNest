/**
 * 全站颜色的**唯一色值源**（禁令⑦ 的另一半：一套体系不只是"用一个库"，还包括"一个色只定义一次"）。
 *
 * 这个文件刻意**不 import antd**：登录页是 Server Component，只能渲染纯 HTML + 内联样式，
 * 一旦引到 `antd.ts` 就会把组件库拖进服务端 bundle（那条约束写在 `src/app/(auth)/login/page.tsx`）。
 * 所以品牌色/墨阶放这儿，antd 的 token 映射放 `./antd.ts`，依赖方向只有一个。
 */

/** 与 v5 那版"电蓝"同一色相：`oklch(0.556 .217 265)` ≈ `#2f5fe0` */
export const BRAND = {
  primary: "#2f5fe0",
  primaryHover: "#4473f0",
  primaryActive: "#234ac2",
  /** 达成/完成：只在"数字完成了"这种前景上用，不做整块底色 */
  success: "#1a9c6b",
  /** 临期 / 逾期：同样只给前景与描边 */
  overdue: "#c2363b",
  soon: "#b76e00",
  /** 深色导航底（antd 的 dark Menu 自带色太紫，这里换成中性墨蓝） */
  sider: {
    bg: "#1d2433",
    /** 登录页那道渐变的终点，比导航底略亮——同一块墨色，不是第三种颜色 */
    gradient: "#22304a",
    item: "#c3ccdd",
    active: "#ffffff",
    accent: "#2f5fe0",
  },
} as const;

/** 纸色底：长时间读表，纯白的对比噪声更累 */
export const PAPER = "#f7f8fa" as const;

/**
 * 墨阶（文字与分隔线的四档）。
 *
 * 之前这些值散在 40 多处内联样式里当字面量用——换库时那种"灰得各不相同"就是回归的源头。
 * 收敛成四个名字之后，"次要信息有多次要"是一个可以被一处改动的决定。
 */
export const INK = {
  /** 正文 */
  body: "#1d2433",
  /** 次级：表头、金额、需要读但不抢焦点的词 */
  secondary: "#5a6478",
  /** 弱级：时间戳、备注、说明文案 */
  muted: "#7a828f",
  /** 最弱：占位符、"—"、搜索图标这类纯装饰的引导 */
  faint: "#a4abb8",
  /** 分隔线 / 描边 */
  line: "#eceef3",
  /** 进度轨道：比线更实，但仍然不是内容 */
  rail: "#c8ccd4",
} as const;

/**
 * 给一个十六进制色加透明度。
 *
 * 为什么不直接写 `rgba(195,204,221,.62)`：那等于把 `BRAND.sider.item` 用另一种记法
 * 再抄一遍，改主色时只会改到一半——深色导航栏那种"同一颜色三档透明度"正是最容易漏的地方。
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

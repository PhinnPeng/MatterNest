/**
 * 错误页插图（2026-10-24）。
 *
 * ## 为什么是内联 SVG，而不是 iconfont 的插图
 *
 * 找过 iconfont 的缺省页插画：下载要登录、授权状态不透明，且多数是彩色/3D 风格。
 * 本仓的视觉是「中性灰阶 + 单一强调色」（PRODUCT.md），彩色插画进来会变成页面里
 * 唯一一块"世界材料"。所以按同一类**线性缺省页插画**的构图自己画：
 *   · 线稿只用 `--ink3` / `--line2`，语气色只落在 `--accent` / `--red` 一处；
 *   · `currentColor` 不参与——直接引用令牌，明暗主题自动跟随；
 *   · 打包进仓库，内网部署不依赖任何外链与字体。
 *
 * 两个变体与 `StateBlock` 的语气一一对应：
 *   · `not-found`（denied，琥珀）：一张缺页的文档 + 放大镜；
 *   · `error`（error，红）：断开的连线 + 警示。
 */
export function ErrorArt({ variant }: { variant: "not-found" | "error" }) {
  return variant === "not-found" ? <NotFoundArt /> : <ErrorArtwork />;
}

function NotFoundArt() {
  return (
    <svg
      width="132"
      height="112"
      viewBox="0 0 132 112"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* 文档：右上角折角，底部缺一截——"这一页不在了" */}
      <path
        d="M38 14h40l18 18v40l-18 18H38a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6Z"
        stroke="var(--ink3)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M78 14v18h18" stroke="var(--ink3)" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M48 48h28M48 58h16" stroke="var(--line2)" strokeWidth="1.5" strokeLinecap="round" />
      {/* 放大镜：语气色只给这一处 */}
      <circle cx="88" cy="74" r="15" stroke="var(--amber)" strokeWidth="1.5" />
      <path d="m99 85 11 11" stroke="var(--amber)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ErrorArtwork() {
  return (
    <svg
      width="132"
      height="112"
      viewBox="0 0 132 112"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* 两边断开的连线 */}
      <path
        d="M10 58h26m10 0h10m14 0h10m10 0h26"
        stroke="var(--line2)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* 中间的警示：一个环 + 感叹号 */}
      <circle cx="66" cy="58" r="26" stroke="var(--red)" strokeWidth="1.5" />
      <path d="M66 44v18" stroke="var(--red)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="66" cy="70" r="1.7" fill="var(--red)" />
      {/* 断口：四个方向的小短线 */}
      <path
        d="m48 40-7-7m51 7 7-7M41 76l-7 7m61-7 7 7"
        stroke="var(--line2)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

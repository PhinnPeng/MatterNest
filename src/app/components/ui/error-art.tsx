import Image from "next/image";

/**
 * 错误页插图（2026-10-24）。
 *
 * 来源：iconfont 矢量插画库的预览图（用户在内置浏览器选中后下载）。
 *   · `not-found`：灰白 3D「404」+ 找东西的人（`error-404.png`）
 *   · `error`：被插头绊倒的宇航员，寓意断电/故障（`error-system.png`）
 *
 * 为什么是 PNG 而不是内联 SVG：用户明确要求用 iconfont 的插图。两张都是
 * 500px 预览图（透明底），已下载进 `public/illustrations/`，不依赖外链与账号。
 *
 * ⚠ 授权：素材版权归 iconfont 作者。企业内网自用一般可用；对外分发或商用前，
 * 需在 iconfont 的素材页确认该作者的授权范围。
 */
export function ErrorArt({ variant }: { variant: "not-found" | "error" }) {
  if (variant === "not-found") {
    return (
      <Image
        src="/illustrations/error-404.png"
        alt=""
        aria-hidden="true"
        width={220}
        height={120}
      />
    );
  }
  return (
    <Image
      src="/illustrations/error-system.png"
      alt=""
      aria-hidden="true"
      width={160}
      height={160}
    />
  );
}

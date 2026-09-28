/**
 * 合法：颜色从唯一源取，半透明用 alpha()。
 * 这条 fixture 同时是两条白名单的证明：`#fff` 放行（没有刻度可言），
 * 而 `alpha()` 生成的 `rgba(...)` 是**模板**里的插值结果，不是字面量。
 */
import { alpha, BRAND, INK } from "@/app/theme/brand";

export const panel = {
  background: BRAND.sider.bg,
  color: alpha(BRAND.sider.item, 0.62),
  borderTop: `1px solid ${alpha(BRAND.sider.active, 0.07)}`,
};
export const onPaper = { color: INK.muted, background: "#fff" };

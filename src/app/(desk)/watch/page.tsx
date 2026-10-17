import { FavoritesView } from "./favorites-view";

export const metadata = { title: "我收藏的 · MatterNest" };

/**
 * 我收藏的（F1-13 的页面面）。
 *
 * 页面壳只挂 metadata 与客户端视图，**一个业务请求都不发**（禁令⑥）。
 */
export default function FavoritesPage() {
  return <FavoritesView />;
}

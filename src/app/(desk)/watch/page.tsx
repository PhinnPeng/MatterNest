import { FavoritesView } from "./favorites-view";

export const metadata = { title: "我关注的 · MatterNest" };

/**
 * 我关注的（F1-13 的页面面）。
 *
 * 页面壳只挂 metadata 与客户端视图，**一个业务请求都不发**（禁令⑥）。
 *
 * ⚠ 词是**界面词**：`/watch` 查的是 `WATCH_TYPES.favorite` 那一支，而
 * `WATCH_TYPE_LABELS.favorite` 的中文今天仍是「收藏」（勘误第 7 条：本票**不动**字典，
 * 它同时被通知与筛选消费，面更大）。页名与入口改「我关注的」，字典留待裁定。
 */
export default function FavoritesPage() {
  return <FavoritesView />;
}

/**
 * 合法：页面壳只挂客户端组件。数据由 `/api/**` 在鉴权后取（禁令⑤/⑥）。
 */
import { MattersView } from "./matters-view";
import { Card } from "@/app/components/ui/card";

export default function Page() {
  return [MattersView, Card];
}

/**
 * 合法：页面壳只挂客户端组件。数据由 `/api/**` 在鉴权后取（禁令⑤/⑥）。
 * 这条 fixture 同时证明"shell 块把 ⑦ 一起挂上"没有过宽：antd 与我们的约定层都得放行。
 */
import { MatterCreateDialog } from "./matter-create-dialog";
import { MattersView } from "./matters-view";

export default function Page() {
  return [MattersView, MatterCreateDialog];
}

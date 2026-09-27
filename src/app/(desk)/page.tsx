import type { Metadata } from "next";
import { Workbench } from "./workbench";

export const metadata: Metadata = { title: "工作台 · MatterNest" };

/** 页面壳：不取数据（禁令⑥），渲染与读取都在 `workbench.tsx` 里经 `/api/**` 完成。 */
export default function DeskPage() {
  return <Workbench />;
}

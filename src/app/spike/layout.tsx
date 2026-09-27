import type { ReactNode } from "react";
import { SpikeProviders } from "@/app/components/spike/providers";

/** spike 区段的布局：只挂 QueryClientProvider，不取任何业务数据（禁令⑥）。 */
export default function SpikeLayout({ children }: { children: ReactNode }) {
  return <SpikeProviders>{children}</SpikeProviders>;
}

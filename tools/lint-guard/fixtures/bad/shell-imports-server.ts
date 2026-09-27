/**
 * 故意写坏：禁令⑥/⑤ —— 页面壳直连服务端数据层。
 * 会被以 `src/app/(desk)/matters/__guard_bad__/page.tsx` 的虚拟路径喂进仓库 config。
 */
import { getDb } from "@/app/lib/server/db/client";
import { listMatters } from "@/app/lib/server/services/matters";
import { matter } from "@/app/lib/server/db/schema";

export async function Page() {
  const db = await getDb();
  return [db, listMatters, matter];
}

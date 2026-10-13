import type { NextResponse } from "next/server";
import type { ExpenseWriteRejection } from "./services/expenses";
import { fail, notFound } from "./http";

/**
 * 费用写失败的 HTTP 答复（四个端点共用一处）。
 *
 * 为什么不写在路由里：`/api/matters/[id]/expenses` 与事项侧同构，加上两条单条端点
 * 一共四处都要做同一张映射表 —— 各写一遍的失败形态是"同一件事在四个端点给出四种说法"，
 * 而它不会报错（用户只是看到四种文案）。
 *
 * 也不能从路由文件里 export 出去复用：Next.js 的 Route 只接受 HTTP 方法等固定导出，
 * 多一个函数就是构建期类型错误。
 *
 * 三种答复的分工：
 *   · `not_found` —— 宿主不可见 / 这条费用不存在或已软删 → **404**（元规则 3：
 *     不可见与不存在同一个响应，措辞也不区分）；
 *   · `archived`  —— 宿主已归档（§5.2 只读终态）→ **403**：这条你看得见，只是不能改。
 *     与 404 的分工是"能不能看见"与"能不能改"，与归属护栏那两条 4xx 同一口径；
 *   · `item_unavailable` —— 费用项目不存在或已停用 → **422**：请求没写错，
 *     是那个配置项不能用了。给下一步动作（换一个启用的项目），不给"请重试"。
 */
export function expenseWriteFailure(r: ExpenseWriteRejection): NextResponse {
  if (r.why === "not_found") return notFound();
  if (r.why === "archived")
    return fail(403, "archived", "归档是终态：这条记录只读，费用不能再增删改。");
  return fail(
    422,
    "item_unavailable",
    "这个费用项目不存在或已停用。费用项目是配置项，换一个启用的项目再提交。",
  );
}

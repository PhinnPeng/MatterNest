import { json, withActor } from "@/app/lib/server/http";
import { listRules, ruleSummary } from "@/app/lib/server/services/rule-admin";

/**
 * 自动化规则列表（P12 / F5-7，2026-10-18）。
 *
 * ## 为什么只有 GET
 *
 * 一期只有预置规则（F5-8/F5-9 新建随 IQ-9 移出），且 `is_system = true` 不可删
 * （F5-10）。所以集合上没有 POST（不新建）、没有 DELETE。
 * 改一条走 `/api/rules/[code]` 的 PATCH —— `code` 是 seed 的幂等锚，不是 id。
 *
 * ## 读不设门
 *
 * 与 `/api/meta`、`/api/config/[kind]` 的 GET 同档：知道"系统会自动做什么"
 * 影响人怎么操作，不该有权限门槛。写才是特权（`canManageConfig`）。
 */
export async function GET() {
  return withActor(async () => {
    const [items, summary] = await Promise.all([listRules(), ruleSummary()]);
    return json({ items, summary });
  });
}

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { statusConfig } from "../db/schema";
import type { HostKind } from "../scope/visibility";

/**
 * 取某个宿主的**初始状态 code**（`mn_status_config.is_initial_status` 那一行）。
 *
 * 三个新建入口（建案、建事项、事项转案件）都从这里拿，理由有两条：
 *   · 写 `"pending"` 字面量会让配置表上那一列变成摆设 —— 运营把初始态改成别的 code，
 *     新建的记录还在往 pending 落，而 seed 里恰好也叫 pending，所以**线上看不出问题**；
 *   · 三处各写一遍，改一处漏两处。
 *
 * 查不到就抛，不兜底给 "pending"：那等于把"seed 没跑/配置被删"这种部署故障
 * 变成一批状态值不合规的脏数据。
 */
export async function initialStatusCode(host: HostKind): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .select({ code: statusConfig.code })
    .from(statusConfig)
    .where(and(eq(statusConfig.hostType, host), eq(statusConfig.isInitialStatus, true)))
    .limit(1);
  if (!row) {
    throw new Error(
      `mn_status_config 缺少 host_type=${host} 的 is_initial_status 行（seed 未跑？）`,
    );
  }
  return row.code;
}

/**
 * 宿主的状态字典（详情页要拿语义判断"要不要填原因"，列表筛选也用它）。
 *
 * 带上 `next_status_codes` 是为了让**前端与服务层跑同一个谓词**
 * （`shared/schema/status-transition.ts`）：不带上就只能"永远显示原因框"或"永远不显示"，
 * 两种都比后端真实判定差 —— 前者让人给正常流转编原因，后者让人在提交时才被撞。
 */
export async function hostStatusRows(host: HostKind) {
  const db = await getDb();
  return db
    .select({
      code: statusConfig.code,
      name: statusConfig.name,
      semantics: statusConfig.semantics,
      nextStatusCodes: statusConfig.nextStatusCodes,
      sortOrder: statusConfig.sortOrder,
    })
    .from(statusConfig)
    .where(and(eq(statusConfig.hostType, host), eq(statusConfig.isEnabled, true)))
    .orderBy(statusConfig.sortOrder);
}

import type { Actor } from "../auth/auth";
import { activityLog } from "../db/schema";
import { nextId } from "@/shared/ids/snowflake";
import { getDb } from "../db/client";

type Db = Awaited<ReturnType<typeof getDb>>;
/** 事务句柄：从 `transaction` 的回调参数上取，比自己拼 PgTransaction 泛型稳（drizzle 小版本改过形状） */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 活动日志写入的**唯一入口**：所有动作都要经它。
 * 留两个入口（这里 + 各服务自己 insert）迟早会有一处忘了写 `reason` 或漏了 `matter_id` 双列。
 */
export async function logActivity(
  tx: Tx,
  actor: Actor,
  e: {
    matterId?: bigint | null;
    riskMatterId?: bigint | null;
    targetType: string;
    targetId: bigint;
    action: string;
    reason?: string | null;
    diffs?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  },
) {
  await tx.insert(activityLog).values({
    id: BigInt(nextId()),
    targetType: e.targetType,
    targetId: e.targetId,
    matterId: e.matterId ?? null,
    riskMatterId: e.riskMatterId ?? null,
    operatorId: BigInt(actor.userId),
    action: e.action,
    reason: e.reason ?? null,
    fieldDiffs: e.diffs ?? null,
    payload: e.payload ?? null,
  });
}

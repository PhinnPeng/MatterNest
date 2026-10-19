import type { Actor } from "../auth/auth";
import { activityLog } from "../db/schema";
import { nextId } from "@/shared/ids/snowflake";
import { getDb } from "../db/client";

type Db = Awaited<ReturnType<typeof getDb>>;
/** 事务句柄：从 `transaction` 的回调参数上取，比自己拼 PgTransaction 泛型稳（drizzle 小版本改过形状） */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 两条写入路径共用的载荷形状（`operatorId` 由各自的入口决定，不在调用方） */
type ActivityEntry = {
  matterId?: bigint | null;
  riskMatterId?: bigint | null;
  targetType: string;
  targetId: bigint;
  action: string;
  reason?: string | null;
  diffs?: Record<string, unknown>;
  payload?: Record<string, unknown>;
};

/**
 * 活动日志写入的**唯一入口**：所有动作都要经它。
 * 留两个入口（这里 + 各服务自己 insert）迟早会有一处忘了写 `reason` 或漏了 `matter_id` 双列。
 *
 * ## `actor` 是必填的，这是刻意的
 *
 * 系统自动动作走**并列的另一个函数** `logSystemActivity`，不是往这里传一个假 actor。
 * 若让 `actor` 可空、由调用方决定传不传，那么「忘了传」与「系统动作」在代码上长得一样，
 * 而它们的后果完全不同（前者是丢主体，后者是本来就没有主体）——审计最不该有这种歧义。
 *
 * ## `operator_id` 可空之后（迁移 0016）本函数的非空语义没有变
 *
 * 列放宽了，但**这条路只写人类主体**：`actor.userId` 直接进 `BigInt()`。
 * 放宽是为了让「系统动作」有落点，不是为了在这里也能省掉 actor。
 */
export async function logActivity(tx: Tx, actor: Actor, e: ActivityEntry) {
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

/**
 * 系统自动动作的审计写入（`operator_id` 写 **NULL**）。
 *
 * ## 为什么与 `logActivity` 并列而不是给它加个可选参数
 *
 * 见 `logActivity` 的注：可空参数会让「忘了传 actor」与「系统动作」在代码上不可分。
 * 两个函数名把事情说清楚，且**这个函数拿不到 `Actor` 类型** —— 调用方想借人都借不到。
 *
 * ## 规格出处
 *
 * 权限草案 §3 末行：系统内部身份（`operator = SYSTEM`）**不建 `app_user` 行**。
 * 而该行原本撞 `operator_id NOT NULL`（MATT-72 阻塞 1），迁移 0016 放开 NOT NULL 之后
 * 这条路径才成立。为什么不建用户行、为什么不是「借用触发人」，见
 * `docs/research-system-identity.md` —— 其中 OWASP NHI10:2025 把「人与自动化的动作
 * 不可区分」直接列为风险（危害写作 "obscuring accountability"）。
 *
 * ## ⚠ 调用方的义务：`payload` 里必须留下「是谁触发的」足够线索
 *
 * `operator_id = NULL` 只说了「没有人类主体」，它**不足以**回答「那是哪条规则、
 * 由什么触发的」。所以系统动作写审计时**必须**在 `payload` 带上 `rule_id` /
 * `rule_name` / `trigger` 这类字段（`AUTO_RULE_*` 的载荷形状见
 * `docs/PRD-phase1-enums-and-schemas.md:129`）。这一条不是风格：
 * 只写 NULL 而不写线索，等于把「谁干的」这个问题从「某个人」换成了「不知道」，
 * 那比借用触发人更没有可追责性。
 */
export async function logSystemActivity(tx: Tx, e: ActivityEntry) {
  await tx.insert(activityLog).values({
    id: BigInt(nextId()),
    targetType: e.targetType,
    targetId: e.targetId,
    matterId: e.matterId ?? null,
    riskMatterId: e.riskMatterId ?? null,
    // NULL = 无人类主体。**只放开 NOT NULL，FK 仍在**（见迁移 0016 的末段注）。
    operatorId: null,
    action: e.action,
    reason: e.reason ?? null,
    fieldDiffs: e.diffs ?? null,
    payload: e.payload ?? null,
  });
}

import { sql } from "drizzle-orm";
import { bigint, check, pgTable, timestamp } from "drizzle-orm/pg-core";
import { id } from "./common";
import { sqlRaw } from "./ddl";

/**
 * `mn_timer_heartbeat`：定时器心跳表（迁移 0015，MATT-83）。
 *
 * ## 为什么新建一张单行表（MATT-74 裁定评论，2026-10-13，方案 A）
 *
 * 定时器（croner，见 MATT-74 / `docs/research-croner-status-heartbeat.md`）的整个状态面
 * 是**进程内存字段**：进程一死全部归零，而「进程内的观察者无法报告自己进程的死亡」
 * 是逻辑必然。能突破它的只有进程外的见证者 —— 这张表就是那个见证者：
 * 定时器每 5 分钟成功 pump 后回写一行，`db:check` 的 C18 探针读这行判断它是否还活着。
 *
 * 否决「复用现有系统配置表」：那要先论证哪张表语义合适，等于把一件确定的事拖成待查的事。
 *
 * ## 三种状态靠「行存在 + 可空时间戳」表达（形状约束 1，已裁不可重开）
 *
 * | 状态 | 怎么看 |
 * |---|---|
 * | 从未跑过 | 行存在但 `created_at IS NULL`（seed 落的初始行就是这个态） |
 * | 跑过且新鲜 | `now() - created_at < 15 分钟` |
 * | 跑过但停摆 | `now() - created_at >= 15 分钟`（3 个周期） |
 *
 * ⚠ 只有「有行 / 没行」两种态的表，探针只能报「有行/没行」，那就退回
 * 「静默零事件与没人该收同形」那个坑 —— 那个坑正是这张表存在的理由。
 * 所以 `created_at` **故意可空、故意没有 DEFAULT**：NULL 携带语义（从未跑过），
 * 不是"还没填"。列名沿用 MATT-83 票面裁定里的检测口径（`created_at IS NULL`）。
 *
 * ## 单行由约束钉住（形状约束 4，已裁不可重开）
 *
 * `ck_mn_timer_heartbeat_id` 是 `CHECK (id = 1)`：任何行的 id 都必须是 1，
 * 而 `id` 又是主键 ⇒ **这张表物理上不可能出现第二行**。
 * 不能靠「代码只写一行」的自觉：两行 = 两个心跳 = 探针读到较新那行，
 * 掩盖掉真正在停摆的那条。
 *
 * ## 为什么没有 `updated_at` / 软删 / 审计列
 *
 * 它不是业务表，是 instrumentation 物（与 `mn_activity_log` 同类但不写审计）：
 * 单行、原地 UPDATE，`created_at` 每次心跳都会被覆写，再放一个 `updated_at`
 * 与它永远同值，是纯冗余。
 *
 * ## 为什么计数列叫 `pump_count` 而不是 `merge_count`
 *
 * 它记的是**成功的 pump 次数**（MATT-74 票面 AC 的「时间 + 计数」里的计数）。
 * ⚠ 不能叫 `merge_count`：本仓已有一个**同名不同义**的列 —— `mn_notification_event.merge_count`
 * 是「同一窗口内这条通知被合并了几次」。两列同名会让「合并计数」在库里出现两种口径，
 * 而 MATT-74 描述里那句「`merge_count = merge_count + 1` 是单语句原子操作」
 * 说的正是**事件表**那一列，不是本表。自增写法照旧：单语句原子自增，不"先查再加"。
 */
export const timerHeartbeat = pgTable(
  "mn_timer_heartbeat",
  {
    id: id(),
    /**
     * 上次**成功** pump 的时刻（MATT-74 只在成功后回写，失败不动这行）。
     * NULL = 从未跑过。可空是语义的一部分，见文件头。
     */
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }),
    /**
     * 累计**成功** pump 次数（失败不增，与 croner 的 `previousRun()` 恰好相反）。
     *
     * ⚠ 默认值必须写成 `sql` 字面量，不能用 `.default(0n)`：`mode: "bigint"` 的 TS 类型
     * 要求 BigInt，而 `drizzle-kit@0.31.10` **序列化不了 BigInt** —— `.default(0n)` 会让
     * `db:generate` 直接抛 `TypeError: Do not know how to serialize a BigInt`（本轮实测，
     * 落盘见 `agent-work/tmp-hb/`）。`.default(sql\`0\`)` 产出的 `"pump_count" bigint DEFAULT 0 NOT NULL`
     * 与迁移 0015 逐字相同。
     */
    pumpCount: bigint("pump_count", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
  },
  // 这里不接 `(t)`：唯一的约束是 `CHECK (id = 1)`，表达式全是字面量（DDL 里不能有参数占位符，
  // 见 `ddl.ts`），拿不到任何列引用可用。
  () => [
    /** 单行钉：任何行的 id 都必须是 1，配合主键 ⇒ 全表至多一行 */
    check("ck_mn_timer_heartbeat_id", sqlRaw("id = 1")),
  ],
);

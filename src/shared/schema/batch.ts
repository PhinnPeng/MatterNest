import { z } from "zod";

/**
 * 批量动作的请求体（MATT-45：改状态 / 归档 / 加标签）—— 前后端同一份（禁令⑧）。
 *
 * ## 三条口径写在这里，因为它们同时约束服务层、路由与两个视图
 *
 * 1. **不可见的行静默排除**。批量请求的语义是"我提交 N 个 id，其中我看得见的那些被执行"，
 *    看不见的**既不计入成功、也不计入跳过**——把"看不见"混进跳过数，等于告诉调用方
 *    "你提交的 id 里有几个存在但你看不见"，那正是元规则 3（不可见一律 404，不给可区分信号）
 *    要防的案号枚举探测。所以 `BatchSummary` 里**没有**"未处理条数"这一栏：
 *    `applied + skipped.length` 允许小于 `ids.length`，这是刻意的，不是漏统计。
 * 2. **跳过只算"看得见但没做成"**：护栏 1 拒绝（不是负责人）、这一步要原因、
 *    目标与现状相同、撤销归档缺特权、归档终态不可写、已转案件的事项已冻结（只有事项侧）。
 *    每条跳过都要能读出一句人话（`BATCH_SKIP_REASON_LABELS`），否则"跳过 3 条"与
 *    "什么都没发生"分不开。
 * 3. **上限 50 在 schema 层拦**，不只在界面上拦：界面拦得住手滑，拦不住手写的 POST。
 *    50 是"一次看得完、也改得完"的量级，同时把"一次请求写 N 条审计"压到可接受的规模。
 *
 * ## 做三个，**明确不做**两个（票面 AC：排除项要写进实现与测试）
 *
 * 做：改状态 / 归档 / 加标签。三者的共同点是**每一行的目标都是同一个标量**——
 * 一个状态码、或一组标签，所以"这一批要变成什么"一句话说得完。
 *
 * · **不做批量转案件**：转案件是 N 张卡片的表单（每张卡的案由/审级/诉讼地位/法院/金额
 *   逐案不同，见 `shared/schema/convert-form.ts`），批量做会让"哪张卡对应哪个事项"
 *   无从表达——一次请求里塞 N 套互不相同的字段，等于把表单搬进 JSON 再让服务端反解。
 * · **不做批量删除**：删除不可逆（`mn_*` 是软删 + FK RESTRICT，界面上也没有回收站），
 *   而批量场景把"选错了"的代价放大 N 倍——一次点错删掉一整页。
 *
 * 两条都**不留占位动作值**：占位会被后来的人读成"还没实现"，而不是"决定不做"。
 * `agent-work/smoke-batch.mjs` 各有一条断言守着它们（`action:"convert"` / `"delete"` → 400）。
 */

/** 一次批量动作最多作用多少行（schema 层拦，见文件头第 3 条） */
export const MAX_BATCH_IDS = 50 as const;

/** 动作值域。**只有三个**——为什么不加 `convert` / `delete` 见文件头。 */
export const BATCH_ACTIONS = ["status", "archive", "tag"] as const;
export type BatchAction = (typeof BATCH_ACTIONS)[number];

/**
 * 跳过原因 → 中文。**一份字典**，服务层产出的值、两个视图渲染的文案都从这里取。
 *
 * 放进 shared 而不是各视图自己写：两个列表页各抄一份必然漂，而漂了的形态是
 * "案件页说'没有权限'、事项页说'跳过'"——同一件事两种说法，用户只会怀疑哪个是真的。
 */
export const BATCH_SKIP_REASON_LABELS = {
  forbidden: "不是这条的负责人（也没有全局范围）",
  reason_required: "这一步必须填原因",
  unchanged: "目标与现状相同",
  privilege_required: "已归档：撤销归档需要「撤销归档」权限",
  archived: "已归档：归档是只读终态，标签也改不了",
  /**
   * 已转案件、事项已冻结（2026-10-14 裁定）。**只有事项侧会出现**——案件侧没有
   * `conversion_status`，也就没有"冻结"这个概念，两侧刻意不对称。
   *
   * 与 `archived` 分开而不是合并：归档有 `can_unarchive` 这条特权出口，冻结没有。
   * 合并成一条的话，批量摘要会把"找持特权的人撤销归档"与"这件事本身不能改"说成同一句，
   * 用户照着做第一件发现没用，第二件事的真正出口（去案件上做）就没人告诉他了。
   */
  frozen: "已转案件：事项已冻结，状态与字段都不能再改（要推进请在案件上做）",
} as const;
export type BatchSkipReason = keyof typeof BATCH_SKIP_REASON_LABELS;

/**
 * 结果摘要（票面 AC：成功 N / 跳过 M）。
 *
 * `skipped` 带 id 而不是只带一个计数：用户要能把"哪几条没成、各自为什么"对回列表，
 * 只有一个数字时他只能整页重试一遍。**不带"未处理条数"**——理由见文件头第 1 条。
 */
export type BatchSummary = {
  applied: number;
  skipped: { id: string; reason: BatchSkipReason }[];
};

/**
 * 数字字符串 id。与 `hosts.ts` / `users.ts` 的 `idField` 同形（那两处也是各写一行，
 * 因为每个 shared schema 模块只依赖 zod，不互相 import）。
 *
 * 上界 19 位与 `http.ts` 的 `pathId` 一致：batch 的 id 走 body 而不是路径，`pathId` 用不上，
 * 但**同一个上界要跟着**——否则一个 40 位的 id 会以 PG 的 `value out of range` 形态变成 500，
 * 而那是"URL/请求体写法不对"，应该是 400。
 */
const idField = (label: string) => z.string().regex(/^\d{1,19}$/, `${label}必须是数字字符串`);

/** 批量动作的公共部分：一次至少一行、最多 `MAX_BATCH_IDS` 行。 */
const idsField = z
  .array(idField("记录"))
  .min(1, "至少要选一行")
  .max(MAX_BATCH_IDS, `一次最多 ${MAX_BATCH_IDS} 行`);

/** 改状态：目标状态 + 可选原因（要不要原因由 `needsChangeReason` 逐行判，见下） */
export const batchStatusSchema = z
  .object({
    action: z.literal("status"),
    ids: idsField,
    to: z.string().trim().min(1, "请选择目标状态").max(32),
    /**
     * 「什么时候必须填」与单条路径**同一个谓词**（`shared/schema/status-transition.ts`
     * 的 `needsChangeReason`）：服务层逐行判，前端据此决定要不要把原因框亮出来。
     * 这里只管长度——配置表可以随时改 `next_status_codes`，写死在 DTO 里就是第二遍定义配置。
     */
    reason: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .strict();

/**
 * 归档：原因**在 schema 就必填**，不是留给服务层兜。
 *
 * 枚举表 §3.2 把 `ARCHIVED` 列为原因必填，而 schema 是前后端共用的同一道门——
 * 放服务层就意味着前端能让用户空着提交、再靠一次逐行 `reason_required` 跳过才发现
 * （"跳过 N 条"里混着一条"其实是你没填原因"，是最难读的一种摘要）。
 * 目标状态**不由调用方给**：归档态是配置驱动的（`mn_status_config.semantics='archived'`），
 * 服务层自己去查，少一个前端能填错、又只能靠 422 才发现的字段。
 */
export const batchArchiveSchema = z
  .object({
    action: z.literal("archive"),
    ids: idsField,
    reason: z.string().trim().min(1, "归档必须填原因").max(500, "原因别超过 500 字"),
  })
  .strict();

/** 加标签：追加（不是替换），已归档的行会被逐行跳过（§5.2 归档是只读终态） */
export const batchTagSchema = z
  .object({
    action: z.literal("tag"),
    ids: idsField,
    tagIds: z.array(idField("标签")).min(1, "至少选一个标签").max(20, "一次最多加 20 个标签"),
  })
  .strict();

/**
 * `.strict()` 不是洁癖（与 `convertSchema` 同一条理由）：zod 默认**静默剥离**未声明字段，
 * 而批量动作里最危险的一种客户端 bug 就是把 `tagIds` 写成 `tags`——默认形态会把它悄悄丢掉，
 * 请求照样回 200 + `applied: N`，用户以为标签加上了。显式拒才能让它在联调时就红。
 */
export const batchSchema = z.discriminatedUnion("action", [
  batchStatusSchema,
  batchArchiveSchema,
  batchTagSchema,
]);

/** 表单侧一律用 `z.input`（见 `hosts.ts` 顶部第三条约定：不用 `.default()`，避免 input/output 分裂） */
export type BatchInput = z.input<typeof batchSchema>;

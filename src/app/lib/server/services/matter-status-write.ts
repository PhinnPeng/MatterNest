/**
 * 案件状态列的**唯一写入口**（人工路径与规则路径共用）。
 *
 * ## 为什么单独一个文件
 *
 * 它本来住在 `matters.ts` 里，但自动归档（`auto-archive.ts`）也要用它，
 * 而 `matters.ts` 又要调 `applyCloseAutoArchive` —— 两个模块互相 import 会成环。
 * 把这一小块搬到独立模块，环就断了，而且**它本来就该独立**：这是一段
 * 「写哪几列」的约定，与案件服务的其余部分（列表、建案、节点、评论）没有耦合。
 *
 * ## 为什么必须共享
 *
 * 自动归档与人工归档要写**同一组列**：`status` / `closing_date` / `is_archived` /
 * `archived_at` / `updated_*`。两处各写一遍的后果不是编译错，而是某天只在一处补了新列，
 * 另一条路静默漏掉 —— 而两条路产出的行在库上长得一样，查不出来。
 *
 * 权限草案 §8 要求规则动作「必须走与人工相同的状态变更服务」；本函数就是那句话里
 * 「相同」所辖的写侧部分。**护栏部分不共享**：护栏 1（只有经办人能改状态）对规则不适用
 * （§8 明写规则是代理动作），所以它留在 `changeStatus` 里。
 */
import { eq } from "drizzle-orm";
import { businessDateKey } from "@/shared/time/zh-cn";
import { getDb } from "../db/client";
import { matter } from "../db/schema";

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 把一个案件的状态列写到目标态。
 *
 * `updatedBy` 可空（迁移 0016）：系统动作没有人类主体，写 `null` 而不是借触发人 ——
 * 借人会让 `updated_by` 这一列开始说谎，而它的定义是「谁最后动过这条记录」。
 */
/**
 * 目标语义 + 当前结案日期 ⇒ `closing_date` 该写成什么（MATT-69）。
 *
 * 它和 `writeMatterStatus` 在同一个文件，理由相同：`status-change.ts` 要用它算、再用
 * `writeMatterStatus` 写，而它原来住在 `matters.ts` 里 —— 那边 import 状态模块就成环。
 *
 * 抽出来的另一个理由是**可测**：状态变更一进去就连库、开事务，而 `pnpm verify`
 * 的口径是离线可跑（与 `risks.spec.ts` 里"为什么不测 `convertToCase` 本体"同一条理由）。
 * 判定逻辑与抽出来之前逐字相同，唯一的变化是签名把"现在"作为**入参**——
 * 于是测试能钉住一个具体的瞬时，而不必去改机器时钟（改全局时钟的测试会与并行用例互相污染）。
 *
 * ## 写入规则（F2-26 第②项的前提，也是 `SEMANTICS_RULES.closed.effect`
 * 那句"视为结案，closing_date 自动写入"的落地）
 *
 * ⚠ MATT-42 之前**没有任何路径能写这一列**：建案 schema 里没有它、案件侧也没有字段编辑接口。
 *   结果是 `closing_date` 恒为 NULL ⇒ 详情页的「已结案」标记永不出现、
 *   归档完备性的第②项恒判"缺"。那一条属于"声明了效果但没实现"，
 *   不是"没人用所以先不做"——声明在 `shared/enums/status.ts` 里，是可读的承诺。
 *
 * 进入 `closed` 语义时若为空则写今天；**离开 `closed` 时清空**
 * （不结案了，"结案日期"就不该留着——留着会让第②项在办案件上恒绿）。
 * 已有的日期不覆盖：重复进入 closed 不改第一次的结案日。
 *
 * ## 为什么"今天"必须过 `businessDateKey` 而不是切 UTC 串
 *
 * ⚠ `closing_date` 是 `date` 列、业务日语义的（"结案那天是哪天"），
 *   详情页与导出都把它当纸面事实读。`now.slice(0, 10)` 切的是 **UTC 日**，
 *   上海 00:00–08:00 之间结案的案件因此落成**前一天**——而用户当天点的是"结案"，
 *   界面上没有任何东西提示它错了。连带后果：规则 9 的 14 天原点取自这一列，
 *   于是那一批案件提前一天收到"材料不全"提醒（方向是"宁可提醒"，但仍是错的）。
 *
 * 本仓的纪律是"同一件事只有一个取数口径"（业务日 = `businessDateKey`，
 * `shared/time/zh-cn.ts`），`archive-reminder.ts` 与 `notifications.ts` 都走它；
 * 这里曾是离群者。
 */
export function resolveClosingDate(
  targetSemantics: string,
  currentClosingDate: string | null,
  now: string,
): string | null {
  if (targetSemantics === "closed") return currentClosingDate ?? businessDateKey(now);
  // ⚠ 归档**保留**结案日期。初版写成"离开 closed 就清空"，而 `closed → archived`
  //   恰好命中（seed 里 `closed` 的推荐后继就是 `archived`）⇒ 归档时把日期抹掉。
  //   后果不是一条断言红，而是三件事同时发生：①判定在 `tx.update` **之前**跑，
  //   读到旧值 ⇒ 审计记 `missing_at_archive: []`（齐备），而列表筛选读归档后的行
  //   （已被抹成 NULL）⇒ 判它"缺材料"——**两个出口互相打架**，正是本票 AC 第 1 条
  //   要防的；②G4 指标"归档材料完整率"的唯一数据源变成**假的空数组**；
  //   ③「已结案缺材料」筛选退化成"全部归档案件"（因为主路径每条都缺）。
  if (targetSemantics === "archived") return currentClosingDate;
  return null;
}

export async function writeMatterStatus(
  tx: Tx,
  args: {
    id: bigint;
    to: string;
    closingDate: string | null;
    archiving: boolean;
    now: string;
    /** 人类主体用 `BigInt(actor.userId)`；系统动作用 `null` */
    updatedBy: bigint | null;
  },
): Promise<void> {
  await tx
    .update(matter)
    .set({
      status: args.to,
      closingDate: args.closingDate,
      isArchived: args.archiving,
      archivedAt: args.archiving ? args.now : null,
      updatedBy: args.updatedBy,
      updatedAt: args.now,
    })
    .where(eq(matter.id, args.id));
}

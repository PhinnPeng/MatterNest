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

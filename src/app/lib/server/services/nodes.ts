import { and, asc, eq } from "drizzle-orm";
import { nextId } from "@/shared/ids/snowflake";
import { NODE_REMIND_DEFAULT } from "@/shared/node-reminder";
import { getDb } from "../db/client";
import { matterNode, nodeTypeConfig, riskMatterNode } from "../db/schema";
import type { HostKind } from "../scope/visibility";

type Db = Awaited<ReturnType<typeof getDb>>;
/** 事务句柄：与 `services/activity.ts` 同一取法（从回调参数上取，别自己拼泛型） */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * P1「创建时预设」节点生成（修订稿 §4）。
 *
 * 规格里两条互斥路径的 P1 那一半：宿主创建成功后，按 `node_type_config` 里
 * `is_enabled AND host_type = 宿主 AND preset_on_create` 的行、以 `sort_order` 实例化。
 * `start_time` **留 null**、`is_time_confirmed=false` —— 这是 §4 明写的：建案时没人知道开庭日，
 * 而"时间待定"的节点不参与提醒扫描、也不自动转进行中（§6.1），所以留 null 是功能而不是偷懒。
 *
 * P2（状态变更时按 `template_code` 批量生成）走自动化规则，属 M5，这里**故意不做**：
 * 两条路径的时机不同、互斥，先做 P2 会让案件既有预设节点又被规则再补一套。
 */

/**
 * 节点提醒的默认提前天数 —— **单一来源已挪到 `@/shared/node-reminder`**：
 * 新增节点时按"是否落在窗口内"决定档位的规则与它共用一份常量。
 * 这里保留 re-export，调用点不必全改。
 */
export { NODE_REMIND_DEFAULT } from "@/shared/node-reminder";

/** `node_type_config` 里参与 P1 的那几列（也用于单测构造，所以取窄） */
export type PresetNodeTypeRow = {
  /** 雪花 id 在库上是 `bigint`（`mode: "bigint"`），所以这里就是 bigint 而不是 number */
  id: bigint;
  code: string;
  name: string;
  timeType: string;
  presetOnCreate: boolean;
  isEnabled: boolean;
  defaultRemindDays: number[];
  sortOrder: number;
};

/** 一条待写入的节点（列名与两张节点表逐一对应） */
export type PlannedNode = {
  nodeTypeId: bigint;
  name: string;
  timeType: "point" | "range";
  remindDays: number[];
  sortOrder: number;
};

/**
 * 纯函数：过滤 → 排序 → 展开成待写入的行。
 *
 * 单测盯四件事，都是"写了看不出来、跑一次才知道"的那类：
 *   1. 顺序来自 `sort_order` **而不是传入数组的顺序**（DB 一 `ORDER BY` 就把它盖过去的写法很常见）；
 *   2. `preset_on_create=false` 与 `is_enabled=false` 都不生成（后者漏了会把运营停用的类型继续塞进新案卷）；
 *   3. 写入序号从 1 开始连续，不留空洞（详情页时间线按它排）；
 *   4. `default_remind_days` 为空才回落到 `{7,3,1}`。
 */
export function planPresetNodes(rows: readonly PresetNodeTypeRow[]): PlannedNode[] {
  return rows
    .filter((r) => r.presetOnCreate && r.isEnabled)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r, i) => ({
      nodeTypeId: r.id,
      name: r.name,
      // CHECK `ck_mn_*_node_time_shape` 只认这两个值；配置页写进别的值要在**这里**红，
      // 而不是等到 insert 撞 DB 约束、报一条和 node_type 八竿子打不着的 500。
      timeType: r.timeType === "range" ? "range" : "point",
      remindDays:
        r.defaultRemindDays.length > 0 ? [...r.defaultRemindDays] : [...NODE_REMIND_DEFAULT],
      sortOrder: i + 1,
    }));
}

/**
 * 取该宿主的预设节点类型。
 *
 * **必须在进入事务前调用**：事务里再向池子要一条连接查配置，池子满时建案事务与配置查询
 * 会互等成死锁 —— 这条口径与本文件 `createRiskMatter` 里取初始态的注释同源（W1 实测过）。
 */
export async function planPresetNodesFor(host: HostKind): Promise<PlannedNode[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: nodeTypeConfig.id,
      code: nodeTypeConfig.code,
      name: nodeTypeConfig.name,
      timeType: nodeTypeConfig.timeType,
      presetOnCreate: nodeTypeConfig.presetOnCreate,
      isEnabled: nodeTypeConfig.isEnabled,
      defaultRemindDays: nodeTypeConfig.defaultRemindDays,
      sortOrder: nodeTypeConfig.sortOrder,
    })
    .from(nodeTypeConfig)
    .where(and(eq(nodeTypeConfig.hostType, host), eq(nodeTypeConfig.isEnabled, true)))
    .orderBy(asc(nodeTypeConfig.sortOrder));
  return planPresetNodes(rows);
}

/**
 * 写入预设节点。与宿主插入同一个 `tx` ⇒ 预设生成失败就整单回滚，
 * 不会出现"案子建好了、节点 Tab 空着"这种静默半态（修订稿 §12.4 的从属级联口径）。
 */
export async function insertPlannedNodes(
  tx: Tx,
  host: HostKind,
  hostId: bigint,
  planned: readonly PlannedNode[],
  actorUserId: bigint,
): Promise<void> {
  if (planned.length === 0) return;
  const values = planned.map((p) => ({
    id: BigInt(nextId()),
    hostId,
    nodeTypeId: p.nodeTypeId,
    name: p.name,
    timeType: p.timeType,
    // start_time / end_time 留 null：时间待定（§4 P1 生成规则）
    isTimeConfirmed: false,
    status: "in_progress" as const,
    sourceKind: "preset" as const,
    remindDays: p.remindDays,
    sortOrder: p.sortOrder,
    createdBy: actorUserId,
    updatedBy: actorUserId,
  }));
  if (host === "matter") await tx.insert(matterNode).values(values);
  else await tx.insert(riskMatterNode).values(values);
}

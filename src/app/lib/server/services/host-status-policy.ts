import { eq } from "drizzle-orm";
import type { Actor } from "../auth/auth";
import { getDb } from "../db/client";
import { matter, riskMatter } from "../db/schema";
import { ownsAttribution } from "../scope/guards";
import { scopedWhere, type HostKind } from "../scope/visibility";
import { judgeArchiveReadiness, type ArchiveReadiness } from "./archive-readiness";
import { applyCloseAutoArchive } from "./auto-archive";
import { resolveClosingDate, writeMatterStatus } from "./matter-status-write";
import { isRiskFrozen } from "./risk-freeze";

/**
 * **两个宿主在状态变更上的全部差异，只写在这一个文件里。**
 *
 * `status-change.ts` 拥有判定顺序与整笔事务；宿主之间的不同只有这几项：
 *
 * | 差异 | 案件 | 事项 |
 * |---|---|---|
 * | 冻结 | 无此概念（案件不可被转出） | `conversion_status = 1` |
 * | 经办人 | 必填，只认经办人本人 / L1 / `is_admin` | **可空**，无主时可推（否则永久卡死） |
 * | `closing_date` | 进 `closed` 写今天、进 `archived` 保留、离开清空 | 没有这一列 |
 * | 归档就绪 | 判定并记进审计 payload | 没有数据源，不判（`null`） |
 * | 结案自动归档（规则 1） | 同事务执行 | 显式不做（见 `rule-admin.ts`） |
 * | 审计外键 | `matter_id` | `risk_matter_id` |
 *
 * ## 为什么是适配器而不是 `if (host === "matter")`
 *
 * 这六项是**语义差**不是数据差：写成分支，`status-change.ts` 会长成第二个
 * `exports.ts` 的 `exportHostFile`；而下一个人加第三个宿主时，会继承一门它不该有的
 * 冻结门（ADR-0005 明写冻结是「事项的属性」）。
 *
 * ## 为什么 `read` 是一整个函数而不是几列引用
 *
 * `HOSTS`（`scope/visibility.ts`）只给表、经办人与参与人，没有 `status` /
 * `is_archived` / `closing_date` / `conversion_status`。那六列往里塞会让一个被 20 处
 * 调用的**范围谓词**同时承担状态读取；而差异在这里读、在这里归一，模块就不必认识 drizzle 的列。
 */

export type HostStatusRow = {
  status: string;
  isArchived: boolean;
  /** 案件侧必填、事项侧可空（`null` = 未指派），统一成字符串免得模块里再判 bigint */
  ownerId: string | null;
  closingDate: string | null;
  conversionStatus: number | null;
};

export type StatusWriteArgs = {
  id: bigint;
  to: string;
  archiving: boolean;
  closingDate: string | null;
  now: string;
  updatedBy: bigint;
};

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type HostStatusPolicy = {
  host: HostKind;
  /** 可见性由 `scopedWhere` 单点保证：不可见与已软删一律查不到（→ 404，元规则 3） */
  read: (actor: Actor, id: string) => Promise<HostStatusRow | undefined>;
  frozen: (row: HostStatusRow) => boolean;
  ownerAllowed: (actor: Actor, row: HostStatusRow) => boolean;
  closingDate: (targetSemantics: string, current: string | null, now: string) => string | null;
  /** `null` = 这个宿主不判归档就绪（事项没有那三项的数据源） */
  readiness: (tx: Tx, id: string) => Promise<ArchiveReadiness | null>;
  writeStatus: (tx: Tx, args: StatusWriteArgs) => Promise<void>;
  /** 状态写完之后、同一事务之内的后续动作（只有案件侧有：规则 1） */
  afterStatusWritten: (tx: Tx, args: { id: bigint; to: string; now: string }) => Promise<void>;
  /** 审计行的宿主外键：`ck_mn_activity_host` 要求二者恰有其一 */
  auditHost: (id: bigint) => { matterId?: bigint; riskMatterId?: bigint };
};

const matterPolicy: HostStatusPolicy = {
  host: "matter",
  async read(actor, id) {
    const db = await getDb();
    const [row] = await db
      .select({
        status: matter.status,
        isArchived: matter.isArchived,
        ownerId: matter.ownerId,
        // 进 closed 要不要写、离开要不要清，都靠它 —— 见 `resolveClosingDate`
        closingDate: matter.closingDate,
      })
      .from(matter)
      .where(scopedWhere("matter", actor, eq(matter.id, BigInt(id))))
      .limit(1);
    return row ? { ...row, ownerId: String(row.ownerId), conversionStatus: null } : undefined;
  },
  // 案件不可被转出，因此没有「冻结」这个概念 —— 与 ADR-0005 的刻意不对称
  frozen: () => false,
  ownerAllowed: (actor, row) => ownsAttribution(actor, row.ownerId ?? ""),
  closingDate: resolveClosingDate,
  readiness: judgeArchiveReadiness,
  writeStatus: writeMatterStatus,
  async afterStatusWritten(tx, { id, to, now }) {
    await applyCloseAutoArchive(tx, { hostId: id, toStatusCode: to, now });
  },
  auditHost: (id) => ({ matterId: id }),
};

const riskMatterPolicy: HostStatusPolicy = {
  host: "risk_matter",
  async read(actor, id) {
    const db = await getDb();
    const [row] = await db
      .select({
        status: riskMatter.status,
        isArchived: riskMatter.isArchived,
        ownerId: riskMatter.ownerId,
        conversionStatus: riskMatter.conversionStatus,
      })
      .from(riskMatter)
      .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(id))))
      .limit(1);
    return row
      ? { ...row, ownerId: row.ownerId === null ? null : String(row.ownerId), closingDate: null }
      : undefined;
  },
  frozen: (row) => isRiskFrozen(row.conversionStatus),
  // 无主事项谁都可以推它 —— 否则它会永久卡在初始态无人能动（IQ-5）
  ownerAllowed: (actor, row) => row.ownerId === null || ownsAttribution(actor, row.ownerId),
  // 事项没有 `closing_date` 这一列：「已处理」不是诉讼词，没有结案日
  closingDate: () => null,
  // 归档就绪的三项（判决书 / 结案日期 / 未决节点）在事项上都没有数据源。
  // ⚠ 不要兜一个空判定：`missing_at_archive: []` 会被读成「齐备」，
  //   而真相是「没判」—— 同一个教训写在 `archive-readiness` 的 unavailable 口径里。
  readiness: async () => null,
  async writeStatus(tx, args) {
    await tx
      .update(riskMatter)
      .set({
        status: args.to,
        isArchived: args.archiving,
        archivedAt: args.archiving ? args.now : null,
        updatedBy: args.updatedBy,
        updatedAt: args.now,
      })
      .where(eq(riskMatter.id, args.id));
  },
  // 规则 1「结案自动归档」只对案件：`risk-admin.ts` 已写「对事项显式跳过」，
  // 在事项侧落一个空实现是**要说出来**的，不是留个坑
  async afterStatusWritten() {},
  auditHost: (id) => ({ riskMatterId: id }),
};

export const HOST_STATUS_POLICIES = {
  matter: matterPolicy,
  risk_matter: riskMatterPolicy,
} as const satisfies Record<HostKind, HostStatusPolicy>;

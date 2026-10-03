import { and, asc, eq, exists, or, sql } from "drizzle-orm";
import { nextId } from "@/shared/ids/snowflake";
import { getDb } from "../db/client";
import { party } from "../db/schema";
import { scopedWhere } from "../scope/visibility";
import type { Actor } from "../auth/auth";

/** 下拉一次给 20 条（与 §4.1 `selectable-users` 的"分页上限 + 不接受批量列举"同一口径） */
export const PARTY_SEARCH_LIMIT = 20;

/**
 * 当事人：建案/转案件时「引用既有」优先于「再建一份」（master F2-15「关联 + 快速新增」）。
 *
 * 为什么值得单独一处：`mn_party` 是**跨案件共享实体**（权限草案 §7.2）。同一家公司在库里出现两次
 * 之后，当事人详情页的「涉及案件」就永远只剩一半，而且没有任何一处会报错。
 *
 * 判定本身抽成纯函数 `pickPartyLink`（下面那三条口径在那儿讲），本文件只留"查哪几样"的 IO。
 * 这么拆不是为了好看：`planPartyLinks` 整体要连库，而 `pnpm verify` 的口径是**离线可跑**，
 * 于是最容易写错的那四条分支反而没有回归 —— 而它们错了的表现是"当事人的案子少一半"，
 * 上线很久都不会有人发现。
 */

export type PartyLinkInput = {
  /** 已登记当事人的 id，`string` 形态来自 DTO（master P1-19：bigint 不出服务层） */
  partyId?: string | null;
  name?: string | null;
  type?: string | null;
  idType?: string | null;
  idNumber?: string | null;
  partyRole: string;
  represented: boolean;
};

/** 三样探测的查询结果，全部可缺省（缺 = 没命中） */
export type PartyLookups = {
  /** 按 `partyId` 取的既有行 */
  byId?: bigint | null;
  /** 按 `(type, id_number)` 精确命中的既有行 —— 与 `uk_mn_party_identity` 同一口径 */
  byIdentity?: bigint | null;
  /** 精确同名的既有行（最多取几条，用于提示，不用于自动合并） */
  sameName?: readonly { id: bigint; name: string }[];
  /** 同一批次里前面某行刚新建出来的 id（键由 `batchKeyOf` 给出） */
  inBatch?: bigint | null;
};

export type PartyLinkDecision =
  | { kind: "link"; partyId: bigint }
  | { kind: "create"; partyId: bigint; name: string; type: string };

export type PartyNameConflict = { partyId: string; name: string; row: number };

/** 引用了库里不存在（或已软删）的当事人 —— 必须硬失败，静默新建等于把选错的人写进案卷 */
export class UnknownPartyError extends Error {
  constructor(readonly partyId: string) {
    super(`当事人 ${partyId} 不存在或已被删除，无法引用`);
    this.name = "UnknownPartyError";
  }
}

/** 批次内去重的键：只有带证件号的行才可能撞 `uk_mn_party_identity`，无证件号的不去重 */
export function batchKeyOf(type: string, idNumber: string | null): string | null {
  return idNumber ? `${type}|${idNumber}` : null;
}

/**
 * 一条当事人入参 → 「引用既有」还是「新建」，四条分支：
 *   1. 给了 `partyId` → 直接引用；库里没有就抛 `UnknownPartyError`（不降级成新建）；
 *   2. `(type, id_number)` 精确命中 → 自动复用。证件号唯一确定主体，与 DB 唯一索引同口径；
 *   3. 本批次前面已经为同一证件号建过一行 → 复用那一行的 id，否则第二行会撞唯一索引；
 *   4. 只有**同名**命中 → 新建，并把命中行作为提示回给用户。"北京某某公司"出现两次可能是两家，
 *      自动合并是覆盖既有案卷的写操作，得由人决定（F3-3 的"查重"到一期就是这个形状）。
 */
export function pickPartyLink(
  input: PartyLinkInput,
  lookups: PartyLookups,
  newId: bigint,
): { decision: PartyLinkDecision; conflicts: PartyNameConflict[] } {
  const conflicts: PartyNameConflict[] = (lookups.sameName ?? []).map((s) => ({
    partyId: String(s.id),
    name: s.name,
    row: 0,
  }));

  if (input.partyId) {
    if (!lookups.byId) throw new UnknownPartyError(input.partyId);
    return { decision: { kind: "link", partyId: lookups.byId }, conflicts };
  }

  const name = (input.name ?? "").trim();
  const type = (input.type ?? "").trim();
  const idNumber = input.idNumber?.trim() || null;

  if (idNumber) {
    if (lookups.byIdentity)
      return { decision: { kind: "link", partyId: lookups.byIdentity }, conflicts };
    if (lookups.inBatch) return { decision: { kind: "link", partyId: lookups.inBatch }, conflicts };
  }
  return { decision: { kind: "create", partyId: newId, name, type }, conflicts };
}

export type PartyLinkPlanRow = {
  /** 写进 `*_party.party_id` 的值：引用既有与本轮新建都已经有 id 了 */
  partyId: bigint;
  partyRole: string;
  represented: boolean;
  sortOrder: number;
  /** 需要在事务里往 `mn_party` 补一行的那几条 */
  isNew: boolean;
  name?: string;
  type?: string;
  idType?: string | null;
  idNumber?: string | null;
};

export type PartyLinkPlan = { rows: PartyLinkPlanRow[]; nameConflicts: PartyNameConflict[] };

/**
 * 读取全部在**进事务之前**做完（与本层取号、取初始态、取预设节点同一口径：事务内再向池子
 * 要一条连接查配置，池子满时会互等成死锁）。插入留给调用方的事务，
 * 所以"计划里有、库里没有"的窗口与宿主插入是同一个事务边界。
 */
export async function planPartyLinks(links: readonly PartyLinkInput[]): Promise<PartyLinkPlan> {
  const db = await getDb();
  const rows: PartyLinkPlanRow[] = [];
  const nameConflicts: PartyNameConflict[] = [];
  const createdInBatch = new Map<string, bigint>();

  for (const [i, l] of links.entries()) {
    const base = { partyRole: l.partyRole, represented: l.represented, sortOrder: i + 1 };
    const type = (l.type ?? "").trim();
    const idNumber = l.idNumber?.trim() || null;
    const name = (l.name ?? "").trim();

    const byId = await (async () => {
      if (!l.partyId) return null;
      const [hit] = await db
        .select({ id: party.id })
        .from(party)
        .where(and(eq(party.id, BigInt(l.partyId)), eq(party.isDeleted, false)))
        .limit(1);
      return hit?.id ?? null;
    })();

    const byIdentity =
      !l.partyId && idNumber
        ? ((
            await db
              .select({ id: party.id })
              .from(party)
              .where(
                and(eq(party.type, type), eq(party.idNumber, idNumber), eq(party.isDeleted, false)),
              )
              .limit(1)
          )[0]?.id ?? null)
        : null;

    const sameName =
      !l.partyId && !byIdentity && name
        ? await db
            .select({ id: party.id, name: party.name })
            .from(party)
            .where(and(eq(party.name, name), eq(party.isDeleted, false)))
            .limit(5)
        : [];

    const key = batchKeyOf(type, idNumber);
    const { decision, conflicts } = pickPartyLink(
      l,
      { byId, byIdentity, sameName, inBatch: key ? (createdInBatch.get(key) ?? null) : null },
      BigInt(nextId()),
    );
    for (const c of conflicts) nameConflicts.push({ ...c, row: i });

    if (decision.kind === "create") {
      if (key) createdInBatch.set(key, decision.partyId);
      rows.push({
        ...base,
        partyId: decision.partyId,
        isNew: true,
        name: decision.name,
        type: decision.type,
        idType: l.idType?.trim() || null,
        idNumber,
      });
      continue;
    }
    rows.push({ ...base, partyId: decision.partyId, isNew: false });
  }

  return { rows, nameConflicts };
}

type Db = Awaited<ReturnType<typeof getDb>>;
/** 事务句柄：与 `services/activity.ts` 同一取法（从回调参数上取，别自己拼泛型） */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 把计划里标了 `isNew` 的当事人真正插进 `mn_party`（在调用方的事务里跑） */
export async function insertNewParties(
  tx: Tx,
  rows: readonly PartyLinkPlanRow[],
  actorUserId: bigint,
): Promise<void> {
  const fresh = rows.filter((r) => r.isNew);
  if (fresh.length === 0) return;
  await tx.insert(party).values(
    fresh.map((r) => ({
      id: r.partyId,
      name: r.name ?? "",
      type: r.type ?? "",
      idType: r.idType ?? null,
      idNumber: r.idNumber ?? null,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    })),
  );
}

/**
 * 当事人检索（建案时"引用既有"那个下拉的数据源）。
 *
 * 谓词**不是**宿主范围，是草案 §7.2 的"我对它关联的至少一个宿主可见"：
 * `party` 是跨案件共享实体，照抄宿主范围会套不出谓词（它没有 owner_id）。
 * 两条 EXISTS 都不起别名 —— `scopedWhere` 渲染的是**真实表名**（`mn_matter.is_deleted`…），
 * 一旦 `join mn_matter as m` 就会 `missing FROM-clause entry`。这条踩过一次就写在代码旁边。
 *
 * 后果按 §7.2 原样接受：搜客户名只命中"我有相关案件的"，前端要提示
 * 「部分结果因权限未显示」，**不做**全局当事人检索。
 */
export async function searchVisibleParties(actor: Actor, keyword: string) {
  const db = await getDb();
  const pattern = `%${keyword.trim()}%`;
  const visible = or(
    exists(
      sql`(select 1 from mn_matter_party mp
             join mn_matter on mn_matter.id = mp.matter_id
            where mp.party_id = mn_party.id and ${scopedWhere("matter", actor)})`,
    ),
    exists(
      sql`(select 1 from mn_risk_matter_party rp
             join mn_risk_matter on mn_risk_matter.id = rp.risk_matter_id
            where rp.party_id = mn_party.id and ${scopedWhere("risk_matter", actor)})`,
    ),
    // is_admin 没有范围谓词（`scopedWhere` 只剩 `NOT is_deleted`），也不能一条都搜不到
    actor.isAdmin ? sql`true` : undefined,
  );
  const rows = await db
    .select({
      id: party.id,
      name: party.name,
      type: party.type,
      idNumber: party.idNumber,
    })
    .from(party)
    .where(
      and(
        eq(party.isDeleted, false),
        // 与 `keywordFilter` 同一写法：`lower(...) like lower(...)`，ILIKE 走不了 btree，一期接受
        sql`lower(${party.name}) like lower(${pattern})`,
        visible,
      ),
    )
    .orderBy(asc(party.name))
    .limit(PARTY_SEARCH_LIMIT);

  return {
    items: rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      type: r.type,
      /**
       * 证件号在这里只当**消歧用的尾串**，不是明文字段：明文查看走 §7.3
       * （要 `can_read_plain` 且记 `SENSITIVE_FIELD_READ`）。一个搜索下拉不构成那次查看。
       */
      idNumberTail: (r.idNumber ?? "").slice(-4),
    })),
    /** 命中数达到上限 ⇒ 后面还有，前端把"部分结果"那句话亮出来（§7.2） */
    truncated: rows.length === PARTY_SEARCH_LIMIT,
  };
}

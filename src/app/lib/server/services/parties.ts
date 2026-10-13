import {
  and,
  asc,
  count as dcount,
  desc,
  eq,
  exists,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { nextId } from "@/shared/ids/snowflake";
import { ID_TYPES, ID_TYPE_LABELS, PARTY_TYPES, PARTY_TYPE_LABELS } from "@/shared/enums/business";
import { listQuerySchema, SORTABLE_COLUMNS } from "@/shared/schema/list-query";
import { getDb } from "../db/client";
import { matter, matterParty, party, riskMatter, riskMatterParty } from "../db/schema";
import { scopedWhere } from "../scope/visibility";
import { blindIndex, decryptField, encryptField } from "../crypto/field-crypto";
import { logActivity } from "./activity";
import type { Actor } from "../auth/auth";

/** 下拉一次给 20 条（与 §4.1 `selectable-users` 的"分页上限 + 不接受批量列举"同一口径） */
export const PARTY_SEARCH_LIMIT = 20;

/**
 * 当事人（M3 **对手方档案**）：建案/转案件时「引用既有」优先于「再建一份」（master F2-15），
 * 加上 MATT-40 的三件——独立档案页的两个读出口、加密存储与盲索引查重、合并（F3-9）。
 *
 * 为什么值得单独一处：`mn_party` 是**跨案件共享实体**（权限草案 §7.2）。同一家公司在库里出现两次
 * 之后，当事人详情页的「涉及案件」就永远只剩一半，而且没有任何一处会报错。
 *
 * 判定本身抽成纯函数 `pickPartyLink`（下面那五条口径在那儿讲），本文件只留"查哪几样"的 IO。
 * 这么拆不是为了好看：`planPartyLinks` 整体要连库，而 `pnpm verify` 的口径是**离线可跑**，
 * 于是最容易写错的那几条分支反而没有回归 —— 而它们错了的表现是"当事人的案子少一半"，
 * 上线很久都不会有人发现。
 *
 * ## 三条与规格对齐的口径（都不是实现细节）
 *
 *   1. **我方（本企业）永不入表**（IQ-7 / Q24=B）：`isOwnCompanyName` 是那道防呆，
 *      写路径上缺失本企业名一律硬失败（不静默跳过，见 `ownCompanyNames`）。
 *   2. **对手方是（前）员工时不做任何特殊化**（US-M3-3 / Q29=A）：不建"内部人员类当事人"、
 *      不关联任何系统账号 —— 要区分就用标签表达（F3-6）。本文件因此**不许**出现
 *      `appUser` 与当事人之间的任何关联；`parties.spec.ts` 有一条源码断言守着它。
 *   3. **展示层全明文**（IQ-12）：读出口一律 `decryptField`，界面没有"显示明文"按钮；
 *      留痕的是**导出**两档（`exportParties`：明文档要 `canReadPlain`，整批记 `EXPORT`）。
 */

/* ───────────────────────── 本企业名防呆（IQ-7） ───────────────────────── */

/**
 * 本企业名（可多个别名）来自 `MN_OWN_COMPANY_NAMES`，逗号分隔。
 *
 * 为什么不给默认值、也不做成配置表：它是**部署的事实**（这家企业叫什么），
 * 猜不出来，也不该猜 —— 一个猜错的默认值会让防呆变成"挡住了别的公司"。
 * 为什么不静默跳过：跳过 = 我方可以再次被建进当事人表，而那正是 IQ-7 明令禁止的
 * 后果（本仓最贵的一类错：没有一处会报错，当事人详情页从此少一半）。
 *
 * ⚠ 抛错的**范围刻意收窄**：只在"确实要新建一行当事人"时读它（见 `planPartyLinks` /
 * `insertNewParties`）。引用既有行、搜索、列表都不需要知道本企业叫什么，
 * 于是没配这个变量的环境里，"引用既有当事人"照常可用，只有"快速新增"会带着
 * 一句人话失败 —— 那是我们想要的位置。
 */
export function ownCompanyNames(): readonly string[] {
  const names = readOwnCompanyNames();
  if (!names) {
    throw new Error(
      "缺 MN_OWN_COMPANY_NAMES：本企业名防呆（IQ-7「我方永不入当事人表」）必须知道本企业叫什么，" +
        "猜不出来所以不给默认值。在 .env 里写：MN_OWN_COMPANY_NAMES=某某集团有限公司（多个别名用逗号分隔）",
    );
  }
  return names;
}

/** 读路径（提示用）：没配就当"不知道"，返回空数组 —— 提示可以没有，**建档的闸门不可以没有** */
function ownCompanyNamesForHint(): readonly string[] {
  return readOwnCompanyNames() ?? [];
}

function readOwnCompanyNames(): readonly string[] | null {
  const raw = process.env.MN_OWN_COMPANY_NAMES;
  if (!raw) return null;
  const names = raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? names : null;
}

/**
 * 这个名字是不是本企业（**纯函数**，离线可测）。
 *
 * 口径是"trim + 大小写无关的**完全相等**"，不做包含匹配：`江苏恒基建设集团有限公司`
 * 与 `江苏恒基建设集团财务有限公司` 是两个法人，包含匹配会把后者也挡在门外 ——
 * 防呆挡错了人，用户只会绕开它（改个写法再提交），那道闸门就废了。
 */
export function isOwnCompanyName(name: string, names: readonly string[]): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return names.some((x) => x.trim().toLowerCase() === n);
}

/**
 * 引用了库里不存在（或已软删）的当事人 —— 必须硬失败，静默新建等于把选错的人写进案卷。
 *
 * 声明位置在「查重与建行」一节**之前**：它的子类 `OwnCompanyPartyError` 住在上面那段防呆里，
 * 而 class extends 不吃变量提升（挪下去会 TS2449）。
 */
export class UnknownPartyError extends Error {
  constructor(
    readonly partyId: string,
    /** 允许子类给一句更具体的用户话术（`OwnCompanyPartyError` 就是这么用的） */
    message?: string,
  ) {
    super(message ?? `当事人 ${partyId} 不存在或已被删除，无法引用`);
    this.name = "UnknownPartyError";
  }
}

/**
 * 快速新增时输入了本企业名。
 *
 * 为什么继承 `UnknownPartyError`：两个路由（`/api/matters`、`/api/risk-matters`）
 * 已经 catch 那个类型翻成 400 并把 `message` 原样给用户，而这两条路径**不在本票写范围内**
 * —— 新造一个错误类型意味着它们会把它当未知错误抛成 500。继承之后，用户看到的是下面这句话，
 * 这正是"提示而非建档"要的效果。（错误码仍是 `unknown_party`，语义上不完美；
 * 要一个独立的错误码得改那两个 handler，已写进交付报告。）
 */
export class OwnCompanyPartyError extends UnknownPartyError {
  constructor(readonly companyName: string) {
    super(
      companyName,
      `「${companyName}」是本企业名称：我方（本企业）永不进当事人表，` +
        `它在案件上的地位由该案的「我方诉讼地位」表达。这一行请填对方当事人或第三人。`,
    );
    this.name = "OwnCompanyPartyError";
  }
}

/* ───────────────────────── DTO（本票写范围内） ───────────────────────── */

/**
 * 当事人 DTO 的 schema 住在这里，**不在 `src/shared/schema`** —— 这是一处已知偏差：
 * 本票的写范围不含 shared，而 shared 是校验的唯一真相（禁令⑧）。
 * 所以这一节是**临时落点**，三份 schema 用的都是 shared 已有的零件
 * （`listQuerySchema` 的键、`idField` 同款正则），没有第二套值域；
 * 父代理把这四段平移到 `shared/schema/hosts.ts` 即可，服务层 import 换成 shared 就行。
 */
const idField = (label: string) => z.string().regex(/^\d+$/, `${label}必须是数字字符串`);

/**
 * 列表查询：从 `listQuerySchema` **收窄**出来，不是另写一份。
 *
 * 为什么把 `sortBy` 收成两个字面量：当事人表没有 `code`/`status`/`level`/`amount`/`owner`
 * 这些维度，若照抄那 8 个键，服务层的映射就只能把用不上的键指回 `updated_at`
 * —— 那正是 `database-guidelines.md` 点名的事故（"DTO 说得出、服务层做不到 ⇒ 排序静默退回"）。
 * 收窄之后，`sortBy=amount` 会得到 400 而不是一个"点了没反应"的表头。
 * `satisfies` 保证这两个键确实是 `SORTABLE_COLUMNS` 的子集（写错编译期就红）。
 */
export const PARTY_SORTABLE_KEYS = [
  "name",
  "updated_at",
] as const satisfies readonly (typeof SORTABLE_COLUMNS)[number][];
export type PartySortKey = (typeof PARTY_SORTABLE_KEYS)[number];

export const partyListQuerySchema = listQuerySchema
  .pick({ page: true, pageSize: true, keyword: true, sortBy: true, sortDir: true })
  .extend({ sortBy: z.enum(PARTY_SORTABLE_KEYS).default("updated_at") });
export type PartyListQuery = z.infer<typeof partyListQuerySchema>;

/** 新建/编辑对手方（F3-2：**仅名称必填**，其余选填） */
export const partyCreateSchema = z
  .object({
    name: z.string().trim().min(2, "请输入当事人名称（至少 2 个字）").max(200),
    /** E17/E18 的值域从 `@/shared/enums/business` 取 —— 不在这里再抄一份 */
    type: z.enum(PARTY_TYPES, { message: "请选择当事人类型（它决定证件号的校验规则）" }),
    idType: z.enum(ID_TYPES).optional().or(z.literal("")),
    idNumber: z.string().trim().max(64).optional().or(z.literal("")),
    contact: z.string().trim().max(100).optional().or(z.literal("")),
    remark: z.string().trim().max(2000).optional().or(z.literal("")),
  })
  .strict();
export type PartyCreateInput = z.infer<typeof partyCreateSchema>;

/** 编辑：与新建同一套值域，只是全部选填（改哪个传哪个） */
export const partyUpdateSchema = partyCreateSchema.partial().strict();
export type PartyUpdateInput = z.infer<typeof partyUpdateSchema>;

/**
 * 合并请求（F3-9）。`[id]` 是**主记录**（surviving），`mergedIds` 是要并进去的那几条。
 *
 * 上限 20 与建案当事人区同口径：一次合并 20 份以上重复档案不是运维动作，是数据事故，
 * 那种情况该先查清为什么会有这么多重复。
 */
export const partyMergeSchema = z
  .object({
    mergedIds: z.array(idField("被并方")).min(1, "至少选一条要并入的档案").max(20),
    reason: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .strict();
export type PartyMergeInput = z.infer<typeof partyMergeSchema>;

/** 导出：`plain=1` 走明文档（要 `canReadPlain`），否则脱敏档 */
export const partyExportQuerySchema = z.object({
  keyword: z.string().trim().min(1).max(60).optional(),
  plain: z
    .enum(["1", "true", "0", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});
export type PartyExportQuery = z.infer<typeof partyExportQuerySchema>;

/* ───────────────────────── 查重与建行（建案路径） ───────────────────────── */

export type PartyLinkInput = {
  /** 已登记当事人的 id，`string` 形态来自 DTO（master P1-19：bigint 不出服务层） */
  partyId?: string | null;
  name?: string | null;
  type?: string | null;
  idType?: string | null;
  idNumber?: string | null;
  partyRole: string;
};

/** 三样探测的查询结果，全部可缺省（缺 = 没命中） */
export type PartyLookups = {
  /** 按 `partyId` 取的既有行 */
  byId?: bigint | null;
  /** 按 `(type, id_number_hash)` 精确命中的既有行 —— 与 `uk_mn_party_identity` 同一口径 */
  byIdentity?: bigint | null;
  /** 精确同名的既有行（最多取几条，用于提示，不用于自动合并） */
  sameName?: readonly { id: bigint; name: string }[];
  /** 同一批次里前面某行刚新建出来的 id（键由 `batchKeyOf` 给出） */
  inBatch?: bigint | null;
  /** 这一行的名称是不是本企业（防呆，IQ-7） */
  ownCompany?: boolean;
};

export type PartyLinkDecision =
  | { kind: "link"; partyId: bigint }
  | { kind: "create"; partyId: bigint; name: string; type: string }
  /** 本企业名：**不建档**，调用方据此抛 `OwnCompanyPartyError` */
  | { kind: "reject"; reason: "own_company"; name: string };

export type PartyNameConflict = { partyId: string; name: string; row: number };

/** 批次内去重的键：只有带证件号的行才可能撞 `uk_mn_party_identity`，无证件号的不去重 */
export function batchKeyOf(type: string, idNumber: string | null): string | null {
  return idNumber ? `${type}|${idNumber}` : null;
}

/**
 * 一条当事人入参 → 「引用既有」还是「新建」，五条分支：
 *   0. **名称是本企业** → 拒绝（`reject`）。我方永不入表，这是 IQ-7 的闸门；
 *   1. 给了 `partyId` → 直接引用；库里没有就抛 `UnknownPartyError`（不降级成新建）；
 *   2. `(type, id_number)` 精确命中（比的是**盲索引**）→ 自动复用。证件号唯一确定主体，
 *      与 DB 唯一索引同口径；
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

  // 防呆排在证件号命中之前：本企业名即使"撞上了库里某一行的证件号"也不该被静默复用
  if (lookups.ownCompany)
    return { decision: { kind: "reject", reason: "own_company", name }, conflicts };

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
    const base = { partyRole: l.partyRole, sortOrder: i + 1 };
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

    /**
     * 精确命中走**盲索引**（`id_number` 现在是密文，明文比较从此不可能成立）。
     *
     * 第二个 OR 是**过渡读法**：迁移 0009 之前的存量行还是明文、`id_number_hash` 为 NULL
     * （回填需要应用侧的密钥，迁移里做不到）。没有这一条，演示库里那 5 行会在下次建案时
     * 各多出一份"同证件号的孪生档案" —— 那正是这张表要防的事，而它会表现成"合并功能没用"。
     * 存量行回填完之后，这一条应当删掉。
     */
    const byIdentity =
      !l.partyId && idNumber
        ? ((
            await db
              .select({ id: party.id })
              .from(party)
              .where(
                and(
                  eq(party.type, type),
                  eq(party.isDeleted, false),
                  or(
                    eq(party.idNumberHash, blindIndex(idNumber)),
                    and(isNull(party.idNumberHash), eq(party.idNumber, idNumber)),
                  ),
                ),
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
      {
        byId,
        byIdentity,
        sameName,
        inBatch: key ? (createdInBatch.get(key) ?? null) : null,
        // 只在真的要新建时才去读本企业名（没配就抛，见 ownCompanyNames 的注释）
        ownCompany: !l.partyId && name ? isOwnCompanyName(name, ownCompanyNames()) : false,
      },
      BigInt(nextId()),
    );
    for (const c of conflicts) nameConflicts.push({ ...c, row: i });

    if (decision.kind === "reject") throw new OwnCompanyPartyError(decision.name);

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

/**
 * 把计划里标了 `isNew` 的当事人真正插进 `mn_party`（在调用方的事务里跑）。
 *
 * 敏感列在这里**落库前一刻**加密：入参、计划、`nameConflicts` 全是明文（用户要看见自己填的），
 * 只有写进库的那一瞬是密文。防呆也在这里再挡一道 —— 计划与插入是两处，
 * 只有两处都挡才叫"闸门"，只挡计划等于把闸门装在了半路上。
 */
export async function insertNewParties(
  tx: Tx,
  rows: readonly PartyLinkPlanRow[],
  actorUserId: bigint,
): Promise<void> {
  const fresh = rows.filter((r) => r.isNew);
  if (fresh.length === 0) return;
  const names = ownCompanyNames();
  await tx.insert(party).values(
    fresh.map((r) => {
      const name = r.name ?? "";
      if (isOwnCompanyName(name, names)) throw new OwnCompanyPartyError(name);
      const idNumber = r.idNumber ?? null;
      return {
        id: r.partyId,
        name,
        type: r.type ?? "",
        idType: r.idType ?? null,
        idNumber: idNumber ? encryptField(idNumber) : null,
        idNumberHash: idNumber ? blindIndex(idNumber) : null,
        createdBy: actorUserId,
        updatedBy: actorUserId,
      };
    }),
  );
}

/* ───────────────────────── 可见性（§7.2） ───────────────────────── */

/**
 * 当事人可见性谓词：草案 §7.2 的"我对它关联的至少一个宿主可见"。
 *
 * 谓词**不是**宿主范围，照抄宿主范围会套不出谓词（`party` 是跨案件共享实体，没有 `owner_id`）。
 * 两条 EXISTS 都不起别名 —— `scopedWhere` 渲染的是**真实表名**（`mn_matter.is_deleted`…），
 * 一旦 `join mn_matter as m` 就会 `missing FROM-clause entry`。这条踩过一次就写在代码旁边。
 *
 * 兜底 `sql\`false\`` 与 `scopedWhere` 同口径：谓词万一全被过滤掉，宁可零行也不要全表放行。
 */
function visiblePartyPredicate(actor: Actor): SQL {
  return (
    or(
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
    ) ?? sql`false`
  );
}

/**
 * 当事人行自己的过滤：未删 + 可见。三个读出口（检索/列表/详情）与**合并**共用一份
 * —— 导出给 `party-merge.ts` 用是刻意的：合并要判"每一条都看得见"，
 * 在这里再拼一份谓词，就会出现"读得到却并不掉"或反过来（合并动了看不见的案卷）。
 */
export function visiblePartyWhere(actor: Actor, ...extra: (SQL | undefined)[]): SQL {
  return and(eq(party.isDeleted, false), visiblePartyPredicate(actor), ...extra) ?? sql`false`;
}

/**
 * 关键词：名称模糊命中，**或**完整证件号精确命中。
 *
 * 后者是盲索引的正当用法（密文上做不了模糊匹配，但精确等值正是它存在的理由）：
 * 用户手里只有一个身份证号时，那是他唯一能搜的东西。
 */
function partyKeywordWhere(keyword: string): SQL {
  const pattern = `%${keyword.trim()}%`;
  return (
    or(
      // 与 `keywordFilter` 同一写法：`lower(...) like lower(...)`，ILIKE 走不了 btree，一期接受
      sql`lower(${party.name}) like lower(${pattern})`,
      eq(party.idNumberHash, blindIndex(keyword)),
    ) ?? sql`false`
  );
}

/**
 * 当事人检索（建案时"引用既有"那个下拉的数据源）。
 *
 * 三条口径都不是风格：
 *   · 关键字必填（`partySearchSchema.min(1)`）：空关键字等于全公司当事人一次列举，
 *     与 §4.1 拒绝裸 `/users` 列表同一个理由；
 *   · 只回证件号**尾四位**用于消歧。这不是"脱敏展示"（展示层是全明文，IQ-12），
 *     而是这个控件只承担消歧：一个搜索下拉不构成导出，导出是另一条链路
 *     （`exportParties`，两档 + `canReadPlain` + `EXPORT`）；
 *   · `ownCompany` 是防呆的**提示**面：输入本企业名时当场说出来，
 *     而不是等提交后由服务层拒（写路径的闸门在 `planPartyLinks`，两处都要有）。
 *
 * 后果按 §7.2 原样接受：搜客户名只命中"我有相关案件的"，前端要提示
 * 「部分结果因权限未显示」，**不做**全局当事人检索。
 */
export async function searchVisibleParties(actor: Actor, keyword: string) {
  const db = await getDb();
  const rows = await db
    .select({
      id: party.id,
      name: party.name,
      type: party.type,
      idNumber: party.idNumber,
    })
    .from(party)
    .where(visiblePartyWhere(actor, partyKeywordWhere(keyword)))
    .orderBy(asc(party.name))
    .limit(PARTY_SEARCH_LIMIT);

  return {
    items: rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      type: r.type,
      idNumberTail: (decryptField(r.idNumber) ?? "").slice(-4),
    })),
    /** 命中数达到上限 ⇒ 后面还有，前端把"部分结果"那句话亮出来（§7.2） */
    truncated: rows.length === PARTY_SEARCH_LIMIT,
    /** 输入的就是本企业名（防呆提示；没配 `MN_OWN_COMPANY_NAMES` 时恒 false） */
    ownCompany: isOwnCompanyName(keyword, ownCompanyNamesForHint()),
  };
}

/* ───────────────────────── 档案列表 / 详情（F3-1 / F3-4） ───────────────────────── */

/**
 * 排序键 → 列。类型写成 `Record<PartySortKey, SQL>`：少键报"缺属性"、多键报"多余属性"，
 * 而**不存在**"指回 updated_at 兜底"那种写法（那正是排序静默失效的形态）。
 */
const PARTY_SORTABLE: Record<PartySortKey, SQL> = {
  name: sql`${party.name}`,
  updated_at: sql`${party.updatedAt}`,
};

/** 涉及案件/事项一次最多列这么多（详情页客户端分页；超出的条数进"未显示"计数） */
export const PARTY_INVOLVED_LIMIT = 100;

export async function listParties(actor: Actor, q: PartyListQuery) {
  const db = await getDb();
  const where = visiblePartyWhere(actor, q.keyword ? partyKeywordWhere(q.keyword) : undefined);
  const col = PARTY_SORTABLE[q.sortBy];
  const order = q.sortDir === "asc" ? asc(col) : desc(col);

  const [totalRow] = await db.select({ n: dcount() }).from(party).where(where);
  const rows = await db
    .select({
      id: party.id,
      name: party.name,
      type: party.type,
      idType: party.idType,
      idNumber: party.idNumber,
      contact: party.contact,
      remark: party.remark,
      updatedAt: party.updatedAt,
      /**
       * 涉及案件/事项的条数**只数我看得见的那些**：数与详情页列出来的行必须对得上，
       * 否则列表说"3 个案件"、点进去只列 1 个，读起来是"数据丢了"。
       * 看不见的那部分由详情页的「部分结果因权限未显示」说明（§7.2）。
       */
      matterCount: sql<number>`(select count(*)::int from mn_matter_party mp
        join mn_matter on mn_matter.id = mp.matter_id
       where mp.party_id = ${party.id} and ${scopedWhere("matter", actor)})`,
      riskCount: sql<number>`(select count(*)::int from mn_risk_matter_party rp
        join mn_risk_matter on mn_risk_matter.id = rp.risk_matter_id
       where rp.party_id = ${party.id} and ${scopedWhere("risk_matter", actor)})`,
    })
    .from(party)
    .where(where)
    .orderBy(order, desc(party.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  return {
    items: rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      type: r.type,
      idType: r.idType,
      /** 展示层全明文（IQ-12）：**不脱敏、不设按钮** */
      idNumber: decryptField(r.idNumber),
      contact: decryptField(r.contact),
      remark: r.remark,
      matterCount: r.matterCount,
      riskCount: r.riskCount,
      updatedAt: r.updatedAt,
    })),
    page: q.page,
    pageSize: q.pageSize,
    total: totalRow?.n ?? 0,
  };
}

export type PartyInvolvedMatter = {
  id: string;
  internalCode: string;
  name: string;
  status: string;
  isArchived: boolean;
  /** 对方在该案中的地位（E06，相对我方视角） */
  partyRole: string;
  /** 我方在该案中的地位（E12）—— 与上一列并排才是"相对我方视角" */
  ourLitigationRole: string;
  updatedAt: string;
};

export type PartyInvolvedRisk = {
  id: string;
  code: string;
  name: string;
  status: string;
  isArchived: boolean;
  partyRole: string;
  updatedAt: string;
};

export type PartyDetail = {
  id: string;
  name: string;
  type: string;
  idType: string | null;
  idNumber: string | null;
  contact: string | null;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  /**
   * 并进本档案的那些（主记录才有）。**只给这一个方向**：
   * 被并方自己是软删行，接口对它给 404（与 F3-7 的删除同一语义，B8「仅软删、无回收站 UI」），
   * 所以"我并进了谁"没有可展示的页面 —— 留一个走不到的字段就是留一段死代码。
   * 去向在**主记录**这一页看得到，那正是用户要找的东西。
   */
  mergedIn: { id: string; name: string; mergedAt: string | null }[];
  matters: PartyInvolvedMatter[];
  risks: PartyInvolvedRisk[];
  /** 库里有、但你的数据范围看不到的条数（§7.2 要求界面说出来） */
  hidden: { matters: number; risks: number };
  /** 可见条数超过 `PARTY_INVOLVED_LIMIT`（列出的是前 N 条） */
  truncated: { matters: boolean; risks: boolean };
};

/**
 * 档案详情（F3-4）：本体的明文 + 它卷入的**全部**案件与事项及其中的地位。
 *
 * "全部"要按数据范围读：`scopedWhere` 的 EXISTS 让"我看不见的案卷"不出现，
 * 但它们**存在**这件事必须说出来（`hidden`）——否则用户会以为这条档案只跟过 1 个案，
 * 而真相是他的范围只覆盖那 1 个（§7.2 的"部分结果因权限未显示"）。
 *
 * 返回 `null` = 看不见或不存在（路由翻 404，措辞不区分两者，元规则 3）。
 */
export async function getParty(actor: Actor, id: bigint): Promise<PartyDetail | null> {
  const db = await getDb();
  const [row] = await db
    .select({
      id: party.id,
      name: party.name,
      type: party.type,
      idType: party.idType,
      idNumber: party.idNumber,
      contact: party.contact,
      remark: party.remark,
      createdAt: party.createdAt,
      updatedAt: party.updatedAt,
      createdByName: sql<
        string | null
      >`(select u.display_name from mn_app_user u where u.id = ${party.createdBy})`,
    })
    .from(party)
    .where(visiblePartyWhere(actor, eq(party.id, id)))
    .limit(1);
  if (!row) return null;

  const mergedIn = await db
    .select({ id: party.id, name: party.name, mergedAt: party.mergedAt })
    .from(party)
    .where(eq(party.mergedIntoId, id))
    .orderBy(asc(party.mergedAt));

  const matterRows = await db
    .select({
      id: matter.id,
      internalCode: matter.internalCode,
      name: matter.name,
      status: matter.status,
      isArchived: matter.isArchived,
      partyRole: matterParty.partyRole,
      ourLitigationRole: matter.litigationRole,
      updatedAt: matter.updatedAt,
    })
    .from(matterParty)
    .innerJoin(matter, eq(matter.id, matterParty.hostId))
    .where(and(eq(matterParty.partyId, id), scopedWhere("matter", actor)))
    .orderBy(desc(matter.updatedAt))
    .limit(PARTY_INVOLVED_LIMIT + 1);

  const riskRows = await db
    .select({
      id: riskMatter.id,
      code: riskMatter.code,
      name: riskMatter.name,
      status: riskMatter.status,
      isArchived: riskMatter.isArchived,
      partyRole: riskMatterParty.partyRole,
      updatedAt: riskMatter.updatedAt,
    })
    .from(riskMatterParty)
    .innerJoin(riskMatter, eq(riskMatter.id, riskMatterParty.hostId))
    .where(and(eq(riskMatterParty.partyId, id), scopedWhere("risk_matter", actor)))
    .orderBy(desc(riskMatter.updatedAt))
    .limit(PARTY_INVOLVED_LIMIT + 1);

  // 总数（不套可见性）：只用来算"还有多少条你看不见"，**不返回任何行内容**
  const [matterTotal] = await db
    .select({ n: dcount() })
    .from(matterParty)
    .innerJoin(matter, eq(matter.id, matterParty.hostId))
    .where(and(eq(matterParty.partyId, id), eq(matter.isDeleted, false)));
  const [riskTotal] = await db
    .select({ n: dcount() })
    .from(riskMatterParty)
    .innerJoin(riskMatter, eq(riskMatter.id, riskMatterParty.hostId))
    .where(and(eq(riskMatterParty.partyId, id), eq(riskMatter.isDeleted, false)));

  const matters = matterRows.slice(0, PARTY_INVOLVED_LIMIT);
  const risks = riskRows.slice(0, PARTY_INVOLVED_LIMIT);

  return {
    id: String(row.id),
    name: row.name,
    type: row.type,
    idType: row.idType,
    idNumber: decryptField(row.idNumber),
    contact: decryptField(row.contact),
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdByName: row.createdByName,
    mergedIn: mergedIn.map((m) => ({
      id: String(m.id),
      name: m.name,
      mergedAt: m.mergedAt,
    })),
    matters: matters.map((m) => ({ ...m, id: String(m.id) })),
    risks: risks.map((r) => ({ ...r, id: String(r.id) })),
    hidden: {
      matters: Math.max(0, (matterTotal?.n ?? 0) - matters.length),
      risks: Math.max(0, (riskTotal?.n ?? 0) - risks.length),
    },
    truncated: {
      matters: matterRows.length > PARTY_INVOLVED_LIMIT,
      risks: riskRows.length > PARTY_INVOLVED_LIMIT,
    },
  };
}

/* ───────────────────────── 新建 / 编辑（F3-2） ───────────────────────── */

/**
 * 无业务宿主的档案动作的**审计落点**：操作者账号维度。
 *
 * ⚠ 这是本票的一处**已知偏差**，理由与代价都写在这里：
 *   · E03 `target_type` 的 7 个取值里没有 `party`，`ck_mn_activity_host` 又要求
 *     "日志必须挂在案件/事项上（`app_user` 除外）"——所以一条"谁建了这份档案"的日志
 *     无处可写：填 `party` 被 CHECK 拒，填一个案件是**说谎**（这条日志与那个案件无关）；
 *   · 迁移 0006 为账号动作开的那个口子（`target_type='app_user'` + 不挂宿主）
 *     是既有唯一"无业务宿主"的合法落点，于是档案类动作借它落地，
 *     `payload` 里写清动作对象（`party_id`）。读起来是"这个账号对档案做了这件事"；
 *   · 正确修法是给 E03 加 `party` 维度（注册表 + 文档 + 迁移三向同批），
 *     那三处都不在本票写范围内，已写进交付报告。
 */
function partyAuditLanding(actor: Actor): { targetType: string; targetId: bigint } {
  return { targetType: "app_user", targetId: BigInt(actor.userId) };
}

export type PartyWriteRejection =
  | { ok: false; why: "identity_exists"; partyId: string; name: string }
  | { ok: false; why: "own_company"; name: string };

/**
 * 新建对手方（F3-2：仅名称必填）。
 *
 * 两条判定：
 *   · **本企业名** → 拒绝（IQ-7 的闸门，与建案路径同一处判定）；
 *   · **同证件号已在库** → 不新建，回 `identity_exists` 并带上既有那条的 id。
 *     这不是"自动合并"：档案一个字段都没动，只是告诉用户"你要建的那份已经在了"。
 *     同**名**不同证件号（或都没填证件号）则**照建**，把同名行作为提示带回 ——
 *     自动合并会稀释对手画像（US-M3-2），合并必须由人在详情页发起（F3-9）。
 */
export async function createParty(
  actor: Actor,
  input: PartyCreateInput,
): Promise<
  { ok: true; id: string; sameName: { id: string; name: string }[] } | PartyWriteRejection
> {
  const db = await getDb();
  const name = input.name.trim();
  if (isOwnCompanyName(name, ownCompanyNames())) return { ok: false, why: "own_company", name };

  const idNumber = input.idNumber?.trim() || null;
  const hash = idNumber ? blindIndex(idNumber) : null;
  const contact = input.contact?.trim() || null;

  if (hash && idNumber) {
    const [dup] = await db
      .select({ id: party.id, name: party.name })
      .from(party)
      .where(
        and(
          eq(party.type, input.type),
          eq(party.isDeleted, false),
          or(
            eq(party.idNumberHash, hash),
            // 存量明文行（迁移 0009 之前写入的）也认：否则用户会在这里建出第二份档案
            and(isNull(party.idNumberHash), eq(party.idNumber, idNumber)),
          ),
        ),
      )
      .limit(1);
    if (dup) return { ok: false, why: "identity_exists", partyId: String(dup.id), name: dup.name };
  }

  const sameName = await db
    .select({ id: party.id, name: party.name })
    .from(party)
    .where(and(eq(party.name, name), eq(party.isDeleted, false)))
    .limit(5);

  const id = BigInt(nextId());
  await db.transaction(async (tx) => {
    await tx.insert(party).values({
      id,
      name,
      type: input.type,
      idType: input.idType?.trim() || null,
      idNumber: idNumber ? encryptField(idNumber) : null,
      idNumberHash: hash,
      contact: contact ? encryptField(contact) : null,
      remark: input.remark?.trim() || null,
      createdBy: BigInt(actor.userId),
      updatedBy: BigInt(actor.userId),
    });
    // 载荷里**不写证件号/手机号**：审计日志是长期留存的明文表，
    // 把敏感值抄进去等于给加密开了一个后门（"库里是密文"就不成立了）
    await logActivity(tx, actor, {
      ...partyAuditLanding(actor),
      action: "PARTY_CREATED",
      payload: { party_id: String(id), name, type: input.type, has_id_number: Boolean(idNumber) },
    });
  });

  return {
    ok: true,
    id: String(id),
    sameName: sameName.map((s) => ({ id: String(s.id), name: s.name })),
  };
}

/** 编辑结果：`null` = 看不见或不存在（→ 404）；`identity_exists` = 撞上另一份档案的证件号 */
export async function updateParty(
  actor: Actor,
  id: bigint,
  input: PartyUpdateInput,
): Promise<{ ok: true } | PartyWriteRejection | null> {
  const db = await getDb();
  const [before] = await db
    .select({
      id: party.id,
      name: party.name,
      type: party.type,
      idType: party.idType,
      idNumber: party.idNumber,
      idNumberHash: party.idNumberHash,
      contact: party.contact,
      remark: party.remark,
    })
    .from(party)
    .where(visiblePartyWhere(actor, eq(party.id, id)))
    .limit(1);
  if (!before) return null;

  const nextName = input.name === undefined ? before.name : input.name.trim();
  if (input.name !== undefined && isOwnCompanyName(nextName, ownCompanyNames())) {
    return { ok: false, why: "own_company", name: nextName };
  }
  const nextType = input.type ?? before.type;
  const nextIdType = input.idType === undefined ? before.idType : input.idType.trim() || null;
  const beforeIdNumber = decryptField(before.idNumber);
  const beforeContact = decryptField(before.contact);
  const idNumberGiven = input.idNumber !== undefined;
  const nextIdNumber = idNumberGiven ? input.idNumber?.trim() || null : beforeIdNumber;
  const nextHash = nextIdNumber ? blindIndex(nextIdNumber) : null;
  const contactGiven = input.contact !== undefined;
  const nextContact = contactGiven ? input.contact?.trim() || null : beforeContact;
  const nextRemark = input.remark === undefined ? before.remark : input.remark.trim() || null;

  if (nextHash) {
    const [dup] = await db
      .select({ id: party.id, name: party.name })
      .from(party)
      .where(
        and(eq(party.type, nextType), eq(party.isDeleted, false), eq(party.idNumberHash, nextHash)),
      )
      .limit(1);
    if (dup && dup.id !== id)
      return { ok: false, why: "identity_exists", partyId: String(dup.id), name: dup.name };
  }

  /**
   * `field_diffs` 只记**非敏感**字段的旧值/新值；证件号与手机号只记一个"改过"的布尔。
   * 理由同 `createParty`：审计表是长期留存的明文表，把敏感值抄进去就等于绕开了加密。
   */
  const diffs: Record<string, unknown> = {};
  if (nextName !== before.name) diffs.name = { from: before.name, to: nextName };
  if (nextType !== before.type) diffs.type = { from: before.type, to: nextType };
  if (nextIdType !== before.idType) diffs.id_type = { from: before.idType, to: nextIdType };
  if (nextRemark !== before.remark) diffs.remark = { from: before.remark, to: nextRemark };
  if (idNumberGiven && nextIdNumber !== beforeIdNumber) diffs.id_number = { changed: true };
  if (contactGiven && nextContact !== beforeContact) diffs.contact = { changed: true };

  await db.transaction(async (tx) => {
    await tx
      .update(party)
      .set({
        name: nextName,
        type: nextType,
        idType: nextIdType,
        // 证件号没传就保持原密文（重加密会产生新 IV，等于每次编辑都改写敏感列）
        ...(idNumberGiven
          ? {
              idNumber: nextIdNumber ? encryptField(nextIdNumber) : null,
              idNumberHash: nextHash,
            }
          : {}),
        ...(contactGiven ? { contact: nextContact ? encryptField(nextContact) : null } : {}),
        remark: nextRemark,
        updatedBy: BigInt(actor.userId),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(party.id, id));
    await logActivity(tx, actor, {
      ...partyAuditLanding(actor),
      action: "PARTY_UPDATED",
      payload: { party_id: String(id) },
      diffs,
    });
  });

  return { ok: true };
}

/* ───────────────────────── 导出两档（IQ-12 / M6 US-M6-3′） ───────────────────────── */

/** 一次导出最多这么多行；超出时 `truncated=true`，界面必须说出来（静默截断＝假全量） */
export const PARTY_EXPORT_LIMIT = 1000;

export type PartyExportRow = {
  name: string;
  type: string;
  idType: string | null;
  idNumber: string | null;
  contact: string | null;
  remark: string | null;
  matterCount: number;
  riskCount: number;
  updatedAt: string;
};

/**
 * 脱敏：**只留尾四位**。短于五位的一律全遮 —— 留两位等于没遮。
 * 这是**导出档**的写法，不是展示层：展示层全明文（IQ-12），两者不要互相借用。
 */
export function maskValue(v: string | null): string {
  if (!v) return "";
  const s = v.trim();
  if (s.length <= 4) return "****";
  return `****${s.slice(-4)}`;
}

/** CSV 单元格：逗号/引号/换行都要包起来，换行折成空格（Excel 里一行一条才对得上） */
function csvCell(v: string): string {
  const s = v.replace(/\r?\n/g, " ");
  return /[",\s]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 导出的 CSV 文本在**服务端**拼（不是把行丢给浏览器拼）：格式只有一处实现，
 * 于是它能被离线单测（引号、逗号、换行三个坑都有用例），而浏览器只负责下载。
 * BOM 是给 Excel 的：没有它，中文表头在 Windows 版 Excel 里是乱码。
 */
export function partiesCsv(rows: readonly PartyExportRow[]): string {
  const header = [
    "名称",
    "类型",
    "证件类型",
    "证件号",
    "联系方式",
    "备注",
    "涉及案件",
    "涉及事项",
    "更新时间",
  ];
  const lines = rows.map((r) =>
    [
      r.name,
      PARTY_TYPE_LABELS[r.type as keyof typeof PARTY_TYPE_LABELS] ?? r.type,
      r.idType ? (ID_TYPE_LABELS[r.idType as keyof typeof ID_TYPE_LABELS] ?? r.idType) : "",
      r.idNumber ?? "",
      r.contact ?? "",
      r.remark ?? "",
      String(r.matterCount),
      String(r.riskCount),
      r.updatedAt,
    ]
      .map(csvCell)
      .join(","),
  );
  return `\uFEFF${[header.join(","), ...lines].join("\r\n")}`;
}

/**
 * 导出两档（IQ-12 的第三重防线）。
 *
 *   · **脱敏档**：人人可导（能看到列表就能导这份列表），证件号/手机号只留尾四位；
 *   · **明文档**：`plain=true`，**调用方必须先 `requirePrivilege(actor, "canReadPlain", …)`**
 *     —— 这条判定不写在这里，是因为它是 HTTP 层的特权口径（`http.ts` 的那个 helper），
 *     服务层再判一次就会出现两套口径。两档**都**写 `EXPORT`（payload 记 `plain` 与行数），
 *     这就是"整批记 EXPORT"：一次导出记一条，不是一行记一条。
 */
export async function exportParties(
  actor: Actor,
  opts: { keyword?: string; plain: boolean },
): Promise<{ plain: boolean; count: number; truncated: boolean; csv: string }> {
  const db = await getDb();
  const where = visiblePartyWhere(
    actor,
    opts.keyword ? partyKeywordWhere(opts.keyword) : undefined,
  );
  const rows = await db
    .select({
      name: party.name,
      type: party.type,
      idType: party.idType,
      idNumber: party.idNumber,
      contact: party.contact,
      remark: party.remark,
      updatedAt: party.updatedAt,
      matterCount: sql<number>`(select count(*)::int from mn_matter_party mp
        join mn_matter on mn_matter.id = mp.matter_id
       where mp.party_id = ${party.id} and ${scopedWhere("matter", actor)})`,
      riskCount: sql<number>`(select count(*)::int from mn_risk_matter_party rp
        join mn_risk_matter on mn_risk_matter.id = rp.risk_matter_id
       where rp.party_id = ${party.id} and ${scopedWhere("risk_matter", actor)})`,
    })
    .from(party)
    .where(where)
    .orderBy(asc(party.name), asc(party.id))
    .limit(PARTY_EXPORT_LIMIT + 1);

  const truncated = rows.length > PARTY_EXPORT_LIMIT;
  const kept = truncated ? rows.slice(0, PARTY_EXPORT_LIMIT) : rows;
  const out: PartyExportRow[] = kept.map((r) => ({
    name: r.name,
    type: r.type,
    idType: r.idType,
    idNumber: opts.plain ? decryptField(r.idNumber) : maskValue(decryptField(r.idNumber)),
    contact: opts.plain ? decryptField(r.contact) : maskValue(decryptField(r.contact)),
    remark: r.remark,
    matterCount: r.matterCount,
    riskCount: r.riskCount,
    updatedAt: r.updatedAt,
  }));

  await db.transaction(async (tx) => {
    await logActivity(tx, actor, {
      ...partyAuditLanding(actor),
      action: "EXPORT",
      payload: {
        target_type: "party",
        scope: "party_list",
        rows: out.length,
        plain: opts.plain,
        ...(opts.keyword ? { keyword: opts.keyword } : {}),
      },
    });
  });

  return { plain: opts.plain, count: out.length, truncated, csv: partiesCsv(out) };
}

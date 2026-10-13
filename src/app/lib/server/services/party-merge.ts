import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { matterParty, party, riskMatterParty } from "../db/schema";
import { logActivity } from "./activity";
import { visiblePartyWhere } from "./parties";
import type { Actor } from "../auth/auth";

/**
 * 当事人合并（F3-9，MATT-40 新增；M3 对齐轮 Q30=A 裁定"一期做"）。
 *
 * ## 它解决什么
 *
 * 同名重复档案会**稀释对手画像**：同一家公司在库里两份，当事人详情页的"涉及案件"
 * 就永远只剩一半，而且没有任何一处会报错（US-M3-2 的出错代价）。查重只能提示，
 * 真正的修法是合并 —— 所以合并不是"清理工具"，是画像成立的前提。
 *
 * ## 三步，缺一不可
 *
 *   1. **关联全部改挂主记录**：`mn_matter_party` / `mn_risk_matter_party` 里指向被并方的行
 *      改成指向主记录。同一宿主上主记录已经在了的那些行**丢掉**（撞 `uk_mn_*_party`，
 *      而且留着就是同一案卷里同一当事人的两行）——丢掉多少条要记进审计载荷，不能悄悄丢；
 *   2. **被并方软删**：`is_deleted` + `deleted_at`，并写上 `merged_into_id` / `merged_at`。
 *      写 `merged_into_id` 而不是只软删，是为了让"为什么不见了"能分辨：
 *      合并能顺着它跳回主记录，F3-7 的删除不能；
 *   3. **全程写 `PARTY_MERGED`**：每个受影响宿主各一条（挂在该案卷/事项的时间线上，
 *      用户在那条线上就能看见"这里的当事人被并过"），外加一条操作者维度的汇总
 *      （载荷记 surviving/merged id，与枚举表 §3 的 `{surviving_party_id, merged_party_ids:[]}`
 *      同形）。两条都写不是啰嗦：宿主行是"在这个案卷里发生过什么"，
 *      操作者行是"这次操作是什么" —— 零关联的被并方只有后者兜得住（不然它悄无声息地消失）。
 *
 * ## 一次事务、行级锁
 *
 * 合并改的是**别的案卷的关联**，中途失败必须整体回滚（否则会出现"一半案卷挂了主记录、
 * 一半还挂在被并方"）。同时对涉及的档案行 `FOR UPDATE`：两个人同时合并同一对档案时，
 * 第二个会看到第一个的结果（`is_deleted`）而不是各改一半。
 *
 * ## 为什么不能撤销
 *
 * 一期**没有反合并**：被并方的原关联行已经改挂或丢掉，恢复需要一份"合并前的快照"，
 * 那属于另一张票。界面上必须把"不可撤销"写在按钮旁边（不是弹窗里的小字）。
 */

/** 一次最多合并这么多条：再多不是运维动作，是数据事故（先查清为什么会有这么多重复） */
export const MAX_MERGED_PARTIES = 20;

/** 形状错误（空选择、超过上限）——路由翻 400，与"看不见/不存在"的 404 分开 */
export class MergeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeInputError";
  }
}

/**
 * 入参规范化（**纯函数**，离线可测）：
 *   · 主记录出现在被并方里 → **丢掉**而不是报错（表单上很容易把当前这条也带上，
 *     为它挡一次提交不值得）；
 *   · 重复 id 去重；
 *   · 去掉之后一条都不剩 → 报错（"把 A 并进 A"不是合并，是空操作，
 *     静默成功会让人以为做了什么）。
 */
export function normalizeMergeInput(
  survivingId: bigint,
  mergedIds: readonly bigint[],
): { survivingId: bigint; mergedIds: bigint[] } {
  const uniq: bigint[] = [];
  for (const id of mergedIds) {
    if (id === survivingId) continue;
    if (!uniq.includes(id)) uniq.push(id);
  }
  if (uniq.length === 0) throw new MergeInputError("至少要选一条与主记录不同的档案");
  if (uniq.length > MAX_MERGED_PARTIES)
    throw new MergeInputError(`一次最多合并 ${MAX_MERGED_PARTIES} 条档案`);
  return { survivingId, mergedIds: uniq };
}

export type MergeResult = {
  survivingId: string;
  mergedIds: string[];
  /** 改挂到主记录的关联行数（案件 + 事项合计） */
  moved: number;
  /** 同一宿主上主记录已在该当事人、因此被丢掉的关联行数 */
  dropped: number;
};

/**
 * 合并。返回 `null` = **看不见或不存在**（路由翻 404，措辞不区分两者，元规则 3）：
 * 主记录不存在/已删/自己就是被并方、任一被并方不存在/已删/已并走、或任一涉及档案
 * 落在操作者的数据范围之外 —— 这五种都归到同一句"没有找到这条记录，或你没有访问它的权限"。
 *
 * 为什么要求"看得见**每一条**被并方"：合并会把被并方的案卷关联改挂到主记录上，
 * 那是在动操作者可能看不见的案卷。允许"只要看得见主记录就能并掉任意档案"，
 * 等于给了一个跨范围改写的入口（权限草案 §4 的"禁止裸表访问"就是防这个）。
 */
export async function mergeParties(
  actor: Actor,
  survivingId: bigint,
  mergedIds: readonly bigint[],
  reason?: string | null,
): Promise<MergeResult | null> {
  const input = normalizeMergeInput(survivingId, mergedIds);
  const involved = [input.survivingId, ...input.mergedIds];
  const db = await getDb();

  return db.transaction(async (tx) => {
    // ① 可见性：与读出口**同一个谓词**（`visiblePartyWhere`），不在这里再拼一份
    const visible = await tx
      .select({ id: party.id })
      .from(party)
      .where(visiblePartyWhere(actor, inArray(party.id, involved)));
    if (visible.length !== involved.length) return null;

    // ② 行级锁 + 状态校验（锁在可见性之后拿：拿不到的东西连锁都不该去碰）
    const rows = await tx
      .select({
        id: party.id,
        name: party.name,
        isDeleted: party.isDeleted,
        mergedIntoId: party.mergedIntoId,
      })
      .from(party)
      .where(inArray(party.id, involved))
      .for("update");
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const survivor = byId.get(String(input.survivingId));
    if (!survivor || survivor.isDeleted || survivor.mergedIntoId) return null;
    for (const id of input.mergedIds) {
      const r = byId.get(String(id));
      if (!r || r.isDeleted || r.mergedIntoId) return null;
    }

    // ③ 受影响的宿主在**改之前**取：改完之后被并方那几行已经不存在了（改挂/丢掉），
    //    再查就只能查到主记录原有的那些关联 —— 审计会说"这个案卷被合并过"，
    //    而那个案卷其实一点没变。
    const matterHosts = await tx
      .selectDistinct({ hostId: matterParty.hostId })
      .from(matterParty)
      .where(inArray(matterParty.partyId, input.mergedIds));
    const riskHosts = await tx
      .selectDistinct({ hostId: riskMatterParty.hostId })
      .from(riskMatterParty)
      .where(inArray(riskMatterParty.partyId, input.mergedIds));

    let moved = 0;
    let dropped = 0;
    for (const mergedId of input.mergedIds) {
      // 先丢冲突行、再改挂其余：顺序反了会撞 uk_mn_*_party（同一宿主同一当事人只许一行）
      const dm = await tx
        .delete(matterParty)
        .where(
          and(
            eq(matterParty.partyId, mergedId),
            sql`EXISTS (SELECT 1 FROM mn_matter_party sp
                         WHERE sp.party_id = ${input.survivingId}
                           AND sp.matter_id = ${matterParty.hostId})`,
          ),
        )
        .returning({ id: matterParty.id });
      const um = await tx
        .update(matterParty)
        .set({ partyId: input.survivingId })
        .where(eq(matterParty.partyId, mergedId))
        .returning({ id: matterParty.id });

      const dr = await tx
        .delete(riskMatterParty)
        .where(
          and(
            eq(riskMatterParty.partyId, mergedId),
            sql`EXISTS (SELECT 1 FROM mn_risk_matter_party sp
                         WHERE sp.party_id = ${input.survivingId}
                           AND sp.risk_matter_id = ${riskMatterParty.hostId})`,
          ),
        )
        .returning({ id: riskMatterParty.id });
      const ur = await tx
        .update(riskMatterParty)
        .set({ partyId: input.survivingId })
        .where(eq(riskMatterParty.partyId, mergedId))
        .returning({ id: riskMatterParty.id });

      dropped += dm.length + dr.length;
      moved += um.length + ur.length;
    }

    // ④ 被并方软删 + 指出主记录（`ck_mn_party_merged_shape` 要求这两件事同时成立）
    const now = new Date().toISOString();
    await tx
      .update(party)
      .set({
        isDeleted: true,
        deletedAt: now,
        mergedIntoId: input.survivingId,
        mergedAt: now,
        updatedBy: BigInt(actor.userId),
      })
      .where(inArray(party.id, input.mergedIds));

    // ⑤ 审计：宿主行（每个受影响的案卷/事项各一条）+ 操作者汇总行
    const summary = {
      surviving_party_id: String(input.survivingId),
      merged_party_ids: input.mergedIds.map(String),
      links_moved: moved,
      links_dropped: dropped,
    };
    for (const h of matterHosts) {
      await logActivity(tx, actor, {
        targetType: "matter",
        targetId: h.hostId,
        matterId: h.hostId,
        action: "PARTY_MERGED",
        reason: reason ?? null,
        payload: summary,
      });
    }
    for (const h of riskHosts) {
      await logActivity(tx, actor, {
        targetType: "risk_matter",
        targetId: h.hostId,
        riskMatterId: h.hostId,
        action: "PARTY_MERGED",
        reason: reason ?? null,
        payload: summary,
      });
    }
    await logActivity(tx, actor, {
      // 无业务宿主的落点：与 `parties.ts` 的 `partyAuditLanding` 同一处偏差，
      // 理由写在那边（E03 没有 party 维度，`ck_mn_activity_host` 要求挂宿主）
      targetType: "app_user",
      targetId: BigInt(actor.userId),
      action: "PARTY_MERGED",
      reason: reason ?? null,
      payload: { ...summary, surviving_party_name: survivor.name },
    });

    return {
      survivingId: String(input.survivingId),
      mergedIds: input.mergedIds.map(String),
      moved,
      dropped,
    };
  });
}

import type { Actor } from "../auth/auth";
import type { DataScope } from "@/shared/enums";

/**
 * 两条归属护栏（权限草案 §2.2）—— "可见即可操作"这条简化能成立的前提，所以**硬编码、不配置化**。
 *
 * 为什么要单独一个文件而不是写在服务函数里：护栏 1 要管的是五个动作
 * （改负责人、改状态、归档、删除、增删协办/关注人），它们会陆续落在不同端点上。
 * 判断散在各自 handler 里，必然出现"新加一个动作忘了套"的形态 ——
 * 而这类漏检的现场表现是"协办人改不动/改得动"，取决于谁先写那个端点，review 抓不住。
 *
 * 两条口径分得很清楚：
 *   · 护栏 1（本文件的 `ownsAttribution`）：**归属与状态类**动作要负责人本人，
 *     或持有 L1 数据范围的人，或 `is_admin`（草案 §3 的逃生口）。
 *   · 护栏 2：**明细读写**（节点 / 进展 / 费用 / 评论 / 附件 / 自定义提醒）不加判定 ——
 *     能看到宿主就能写，可见性由 `scopedWhere` 单点保证，写成第二道判定反而会误伤
 *     （草案 §2.2 的原文就是"能看就能写明细"）。
 */

type ActorLike = Pick<Actor, "userId" | "dataScope"> & { isAdmin?: boolean };

/**
 * 这个操作者有没有资格动这条宿主的**归属/状态**？
 *
 * `ownerId` 收 `bigint` 与 `string` 两种形态：服务层内部是 `bigint`，
 * DTO 与 URL 上是 `string`（master P1-19）。用 `String()` 归一而不是要求调用方转换，
 * 是因为漏转的失败形态是"永远比不相等"⇒ 负责人自己也改不动，最难查。
 */
export function ownsAttribution(actor: ActorLike, ownerId: string | bigint): boolean {
  if (actor.isAdmin) return true;
  if (actor.dataScope === ("all" satisfies DataScope)) return true;
  return String(ownerId) === String(actor.userId);
}

/**
 * 操作者能不能把 `userId` 设为参与人（承办 / 协办 / 关注）。
 *
 * 权限草案 §4.1（2026-09-26 收窄裁定）：被加者必须落在**操作者的可见用户集**内 ——
 * L1 与 `is_admin` 是全公司启用用户皆可，其余只能加与自己共现于同一宿主的同事。
 * 这一条是纯判定，"共现"那半要查库，由调用方拿结果传进来。
 */
export function canAddParticipant(
  actor: ActorLike,
  targetUserId: string | bigint,
  opts: { coOccurred?: boolean; targetEnabled?: boolean } = {},
): boolean {
  if (opts.targetEnabled === false) return false;
  const unrestricted = actor.isAdmin || actor.dataScope === ("all" satisfies DataScope);
  return (
    unrestricted || (opts.coOccurred ?? false) || String(targetUserId) === String(actor.userId)
  );
}

/**
 * 权限草案 §6：谁能改这条宿主的**参与人名单**（加/摘承办、协办、关注）。
 *
 * 三个主体：**经办人本人 / L1（含 `is_admin`）/ 创建人**。
 * 协办与关注没有这条权利——他们看得见宿主（所以能读名单），但管不了名单。
 *
 * ## 为什么放在这里而不是各服务函数里
 *
 * 与护栏 1 同一条理由：这条判定要管**两侧宿主**（事项与案件）的多个端点，
 * 散在各处必然出现"新加一个端点忘了套"。而且它是**与宿主无关**的纯判定
 * （只看 actor 与宿主的 owner/creator 三列），没有任何理由分两份。
 *
 * ⚠ 2026-10-13 从 `risks.ts` 提取到这里：原先它是 risks.ts 里的局部函数，
 * 案件侧要用就得再写一份——那就是第二份实现，而"谁能改名单"漂移了不会报错，
 * 只会让某个协办悄悄获得加人的能力。
 */
export function canManageStaffList(
  actor: ActorLike,
  host: { ownerId: string | bigint | null; creatorId: string | bigint | null },
): boolean {
  if (actor.isAdmin) return true;
  if (actor.dataScope === ("all" satisfies DataScope)) return true;
  const uid = String(actor.userId);
  if (host.ownerId !== null && String(host.ownerId) === uid) return true;
  return host.creatorId !== null && String(host.creatorId) === uid;
}

/**
 * 批量导入的执行权：**只有 L1 数据范围**（外加 `is_admin` 逃生口）。
 *
 * 依据：master F7-4 与 IQ-11 的裁定原文「权限：仅 L1 角色可执行（与 Q40 捞取面一致）」——
 * Q40 那条是"未指派事项只对持 L1 的角色可见可捞"，所以这里用**同一个谓词**
 * （`dataScope === "all"`），不是另立一套"谁能导"。
 *
 * 为什么单独一个函数而不是在各路由里写 `actor.dataScope === "all"`：
 * 与上面两条护栏同一条理由 —— 这条判定要管四个端点（模板、导入、报告、批次列表），
 * 散着写必然出现"新加一个端点忘了套"，而漏检的形态是"参与经办也能导全公司的账"。
 *
 * 它**不是**特权开关（`privileges` 那四个）：特权是角色授予的单项能力，
 * 而这条是数据范围的一个门槛，随角色范围自动成立（权限草案 §1 三档范围）。
 */
export function canImport(actor: ActorLike): boolean {
  if (actor.isAdmin) return true;
  return actor.dataScope === ("all" satisfies DataScope);
}

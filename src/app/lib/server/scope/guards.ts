import type { Actor } from "../auth/auth";
import type { DataScope } from "@/shared/enums";

/**
 * 两条归属护栏（权限草案 §2.2）—— "可见即可操作"这条简化能成立的前提，所以**硬编码、不配置化**。
 *
 * 为什么要单独一个文件而不是写在服务函数里：护栏 1 要管的是五个动作
 * （改承办人、改状态、归档、删除、增删协办/关注人），它们会陆续落在不同端点上。
 * 判断散在各自 handler 里，必然出现"新加一个动作忘了套"的形态 ——
 * 而这类漏检的现场表现是"协办人改不动/改得动"，取决于谁先写那个端点，review 抓不住。
 *
 * 两条口径分得很清楚：
 *   · 护栏 1（本文件的 `ownsAttribution`）：**归属与状态类**动作要承办人本人，
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
 * 是因为漏转的失败形态是"永远比不相等"⇒ 承办人自己也改不动，最难查。
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
 * L1 与 `is_admin` 是全所启用用户皆可，其余只能加与自己共现于同一宿主的同事。
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

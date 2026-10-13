/**
 * `mn_notification_event.dedupe_key` 的构造（修订稿 §7.2）。
 *
 * ## 为什么去重靠数据库唯一键，不靠应用层判重
 *
 * §7.2 第 4 条把这件事写死了：「去重靠数据库唯一键，不靠应用层判重」。
 * 理由是 outbox 的投递语义是**至少一次**（`0003_event_outbox.sql` 头注），
 * 消费者崩溃后重放同一行是正常路径，不是异常路径——
 * 应用层判重要在"查一次再插一次"之间留一个窗口，而那个窗口在多副本下必然被穿过。
 * `UNIQUE (dedupe_key)` + `ON CONFLICT DO NOTHING` 没有窗口。
 *
 * ## 两类 key 的差别（不是两种写法，是两种粒度）
 *
 * · **immediate**（业务动作当场产生）：`event_type : target_id : event_batch_id : 收件人摘要`
 *   `event_batch_id` 是**一次业务操作**的批次号，透传自 outbox 的 `batch_id`。
 *   它让"同一次转案件生成 N 个案件"只出一条通知（§7.2 合并规则 1），
 *   也让"同一批里两条同源评论"合成一条（合并规则 3 的同类形态）。
 * · **scheduled**（扫描器产生）：`event_type : target_id : 业务日`
 *   同一节点同一天的多次提前提醒合并为 1 条（§7.2 原文）。这里刻意**不含收件人**：
 *   定时类的收件人是节点 owner + follower，一天之内不该因为人员变动再发一条。
 *
 * ## 收件人摘要为什么是散列而不是拼接的 id 列表
 *
 * `dedupe_key` 是 `varchar(120)`，而 10 个雪花 id 拼起来就 200 字符——超长会被 PG 拒，
 * 而拒的时机是"用户点了保存"，不是 CI。散列成 12 字符既守住列宽，
 * 又保住语义（同一批同一群人才算同一条）。用纯 TS 实现而不是 `node:crypto`：
 * 禁令① 不允许 shared 层碰 Node API（它同时进客户端 bundle）。
 */

/**
 * 稳定散列：FNV-1a 的两个不同种子拼起来（64 位量级）。
 *
 * 不引库、不用 `node:crypto`：这段代码要能在客户端 bundle 里跑。
 * 它**不是**安全散列，也不需要是——用途只是"同一群收件人得到同一个短串"。
 */
function shortHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ c, 0x85ebca6b) + i) >>> 0;
  }
  return h1.toString(36).padStart(7, "0") + h2.toString(36).padStart(7, "0");
}

/**
 * 收件人集合的摘要。**先排序再去重**：`["b","a"]` 与 `["a","b"]` 必须是同一个 key，
 * 否则同一批里两次解析顺序不同就会各出一条通知（这正是 §7.2 合并规则 2 要挡的）。
 */
export function recipientsDigest(userIds: readonly (string | bigint)[]): string {
  const sorted = [...new Set(userIds.map(String))].sort();
  return shortHash(sorted.join(","));
}

/** immediate 类：同批 + 同目标 + 同收件人 = 一条 */
export function immediateDedupeKey(args: {
  eventType: string;
  targetId: string | bigint;
  batchId: string;
  recipients: readonly (string | bigint)[];
}): string {
  return [
    args.eventType,
    String(args.targetId),
    args.batchId,
    recipientsDigest(args.recipients),
  ].join(":");
}

/** scheduled 类：同目标 + 同业务日 = 一条（不看收件人，见文件头） */
export function scheduledDedupeKey(args: {
  eventType: string;
  targetId: string | bigint;
  dateKey: string;
}): string {
  return [args.eventType, String(args.targetId), args.dateKey].join(":");
}

/** 列宽上限（与迁移里的 `varchar(120)` 同源）。超长是缺陷，不是"截一下就好" */
export const DEDUPE_KEY_MAX_LENGTH = 120;

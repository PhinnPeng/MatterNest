/**
 * 雪花 id（技术选型 §4「ID」行、修订稿 §12.2）。
 *
 * 两条约束决定了实现形态，都不是风格：
 *   · DB 列是 `bigint` ⇒ 值必须落在 64 位有符号范围内；
 *   · JS `Number` 只有 53 位安全整数 ⇒ **内部一律用 `bigint` 运算，出口转 `string`**（P1-19）。
 *     这里如果返回 number，`Date.now()` 级的时间戳一乘移位就会静默丢低位。
 *
 * 位分配：41 位毫秒（自定义纪元起，约可用到 2095）+ 10 位 worker + 12 位序列。
 * worker 号从 `MN_WORKER_ID` 读，默认 1；**多副本部署必须给不同值**，否则同一毫秒可能撞号
 * （编号列有 unique，撞了会当场报错而不是静默，这是刻意的：宁可失败也不要重号）。
 */

/** 2026-01-01T00:00:00Z。写死而不是 `new Date()` 相对算，避免重启后时间戳倒退。 */
const EPOCH = 1767225600000n;
const WORKER_BITS = 10n;
const SEQUENCE_BITS = 12n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;
const WORKER_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_BITS;

let workerId = Number(process.env.MN_WORKER_ID ?? 1);
if (!Number.isInteger(workerId) || workerId < 0 || workerId > Number(MAX_WORKER())) {
  workerId = 1; // 配错就退回默认值：宁可共用号段也不要启动失败，撞号有 unique 兜底
}

function MAX_WORKER() {
  return (1n << WORKER_BITS) - 1n;
}

let lastTimestamp = -1n;
let sequence = 0n;

/** 下一个雪花 id，**字符串形态**（DTO 与 JSON 一律 string，见 P1-19） */
export function nextId(): string {
  let now = BigInt(Date.now()) - EPOCH;
  if (now < lastTimestamp) {
    // 时钟回拨：等而不是抛，回拨窗口通常毫秒级；但超过 2s 就是运维事故，让它响
    if (lastTimestamp - now > 2000n) throw new Error("时钟回拨超过 2 秒，拒绝发号");
    now = lastTimestamp;
  }
  if (now === lastTimestamp) {
    sequence = (sequence + 1n) & MAX_SEQUENCE;
    if (sequence === 0n) {
      while (now <= lastTimestamp) now = BigInt(Date.now()) - EPOCH;
    }
  } else {
    sequence = 0n;
  }
  lastTimestamp = now;
  return ((now << TIMESTAMP_SHIFT) | (BigInt(workerId) << WORKER_SHIFT) | sequence).toString();
}

/** 解析出创建时刻，用于"由 id 反推大致时间"的调试；不用于业务判定 */
export function createdAtOfId(id: string | bigint): Date {
  const v = BigInt(id);
  return new Date(Number(v >> TIMESTAMP_SHIFT) + Number(EPOCH));
}

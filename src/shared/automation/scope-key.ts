/**
 * `scope_key` 归一化（枚举表 §4.4，MATT-43 / T5b 落地）。
 *
 * ## 它是干什么的
 *
 * 修订稿 §2.1 把"动作唯一性"的作用域从全局改成**触发域**：
 *
 * > 在同一触发域（`scope_key`）内，同一 `action_type` 至多一条启用规则。
 *
 * 而 DB 侧的兑现方式是一条 partial unique index：
 *
 * ```sql
 * CREATE UNIQUE INDEX ux_mn_automation_rule_enabled_action
 *   ON mn_automation_rule (scope_key, action_type) WHERE is_enabled;
 * ```
 *
 * 于是**9 条预置规则能同时在线**：规则 4 与规则 9 同为 `time_no_progress` + `notify`，
 * 若作用域是"触发类型"两者必然打架；作用域是"归一化后的触发条件"就天然分开
 * （`{days:30}` vs `{days:14,status_code:"closed"}`）。
 *
 * ## 为什么归一化必须**稳定**，以及"不稳定"会长什么样
 *
 * 唯一索引的判定完全落在这个函数产出的串上。归一化只要有一处不稳，
 * 后果**不是报错**，而是两种相反的静默故障：
 *   · 同一条件算出两个 key ⇒ 约束形同虚设，"同域同动作"能并存，用户收到两条同源通知；
 *   · 不同条件算出一个 key ⇒ 两条本来该共存的规则**插不进去**，而报错信息说的是
 *     "duplicate key"，指向的是约束，不是归一化。
 * 所以枚举表 §4.4 附了 8 条必过向量（V1–V8），`scope-key.spec.ts` 逐条钉住。
 *
 * ## 三个实现选择，都不是风格
 *
 * 1. **不用 `node:crypto`。** 禁令①：`src/shared/**` 不得碰 Node API（它同时进客户端 bundle）。
 *    所以这里自带一份 SHA-1 —— 它只用来把触发条件压成 12 字符的定长串，
 *    不是安全边界（谁能写规则表谁就能直接写 `scope_key`）。**不要**拿它做任何安全用途。
 * 2. **base32hex 用大写字母表的 RFC 4648 形态，落成小写。** 文档写的是 `base32_hex`，
 *    没钉大小写；选小写是为了与全仓的 `code` 风格一致（`risk_matter`、`in_progress`）。
 *    它**只影响字面值，不影响语义** —— 8 条向量断的全是"同 key / 不同 key"这类关系。
 * 3. **数值键取 `int()`**（向量 5）：`{days:3}` 与 `{days:"03"}` 与 `{days:3.0}` 必须是同一个域，
 *    否则"管理员把 3 改成 03"就能绕过唯一约束再插一条同域规则。
 */
import { SCOPE_KEY_LENGTH, TRIGGER_CONFIG_NUMERIC_KEYS } from "@/shared/enums/automation";

/** RFC 4648 base32hex 字母表，小写形态（见文件头第 2 条） */
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/** 归一化时要丢弃的"空"值（§4.4 向量 2：`null` / `[]` / `{}` / `""`） */
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0;
  return false;
}

/** 标量 → 串。布尔走字面量、数值取整数形态（§4.4 向量 4/5） */
function canonScalar(v: string | number | boolean, numericKey: boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(Math.trunc(v) === v ? Math.trunc(v) : v);
  // 数值键上的字符串同样取 int()：`"03"` 与 `3` 是同一个域（向量 5）
  if (numericKey && /^\d+$/.test(v)) return String(parseInt(v, 10));
  return JSON.stringify(v);
}

/**
 * 递归归一化（§4.4 的 7 条规则）。
 *
 * `numericKey` 只对**对象属性**生效：数组元素没有键名，
 * 而 `days` 出现在数组里的情况不存在（`remind_days` 是节点表的列，不进 `trigger_config`）。
 */
function canonValue(v: unknown, numericKey: boolean): string | null {
  if (isEmptyValue(v)) return null;
  if (Array.isArray(v)) {
    const hasObject = v.some((x) => x !== null && typeof x === "object");
    if (hasObject) {
      // 对象数组保序（规则 3）：它们通常是有序的配置项，排序会改变语义
      return `[${v.map((x) => canonValue(x, false) ?? "null").join(",")}]`;
    }
    // 标量数组先升序再序列化（向量 3：`["b","a"]` 与 `["a","b"]` 同 key）
    const parts = v.map((x) => canonScalar(x as string | number | boolean, false));
    parts.sort();
    return `[${parts.join(",")}]`;
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort(); // 规则 1：按键名 ASCII 升序
    const parts: string[] = [];
    for (const k of keys) {
      const inner = canonValue(obj[k], TRIGGER_CONFIG_NUMERIC_KEYS.includes(k));
      if (inner !== null) parts.push(`${JSON.stringify(k)}:${inner}`); // 规则 2：空值丢键
    }
    return `{${parts.join(",")}}`;
  }
  return canonScalar(v as string | number | boolean, numericKey);
}

/**
 * `canon(trigger_config)` —— 序列化结果**不含任何空白字符**（规则 7）。
 *
 * 顶层不是对象时（理论上被服务层校验挡住）退化成 `{}`：
 * 归一化函数不该抛——它跑在"保存规则"的路径上，而一条坏配置让整个保存 500
 * 比"算出个可解释的 key"更糟。真正的校验在 `TRIGGER_CONFIG_KEYS` 那一侧。
 */
export function canonTriggerConfig(config: unknown): string {
  return canonValue(config, false) ?? "{}";
}

/**
 * 触发域摘要。**不含动作**——这正是"同域不同动作"能并存的原因（§2.1）。
 *
 * `normalized := trigger_type + "|" + trigger_target_type + "|" + canon(trigger_config)`
 */
export function computeScopeKey(
  triggerType: string,
  triggerTargetType: string,
  triggerConfig: unknown,
): string {
  const normalized = `${triggerType}|${triggerTargetType}|${canonTriggerConfig(triggerConfig)}`;
  return base32Hex(sha1(utf8Bytes(normalized))).slice(0, SCOPE_KEY_LENGTH);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 下面两个是"禁令① 不许用 node:crypto"的直接后果：自带 SHA-1 与 UTF-8 编码。
 * 它们**只服务于 scope_key**，不要 export 出去当通用散列用（见文件头第 1 条）。
 * ──────────────────────────────────────────────────────────────────────────── */

/** UTF-8 编码（手写而不是 `TextEncoder`：后者在 shared 层属于运行时全局，仍不该依赖） */
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i) ?? 0;
    if (c > 0xffff) i++; // 代理对：一个码点吃掉两个 code unit
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
  }
  return out;
}

const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;

/** SHA-1（FIPS 180-1）。单测用 `sha1("abc")` 的公开向量钉住实现本身 */
function sha1(bytes: readonly number[]): number[] {
  const msg = [...bytes];
  const bitLen = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // 64 位长度大端：高位用 floor(len/2^32)（本用途的输入远小于 2^32，高位恒 0）
  const hi = Math.floor(bitLen / 4294967296);
  const lo = bitLen >>> 0;
  msg.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  msg.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let i = 0; i < msg.length; i += 64) {
    const w = new Array<number>(80).fill(0);
    for (let j = 0; j < 16; j++)
      w[j] =
        (((msg[i + 4 * j] ?? 0) << 24) |
          ((msg[i + 4 * j + 1] ?? 0) << 16) |
          ((msg[i + 4 * j + 2] ?? 0) << 8) |
          (msg[i + 4 * j + 3] ?? 0)) >>>
        0;
    for (let j = 16; j < 80; j++)
      w[j] = rotl((w[j - 3] ?? 0) ^ (w[j - 8] ?? 0) ^ (w[j - 14] ?? 0) ^ (w[j - 16] ?? 0), 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number;
      let k: number;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      // 各项都在 ±2^32 内，和不超过 2^53 ⇒ JS number 精确；>>> 0 取模 2^32
      const t = (rotl(a, 5) + f + e + k + (w[j] ?? 0)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out: number[] = [];
  for (const h of [h0, h1, h2, h3, h4])
    out.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
  return out;
}

/** base32hex（RFC 4648 §7 的字母表，无填充）：20 字节摘要 → 32 字符 */
function base32Hex(bytes: readonly number[]): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(acc >>> (bits - 5)) & 0x1f] ?? "";
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(acc << (5 - bits)) & 0x1f] ?? "";
  return out;
}

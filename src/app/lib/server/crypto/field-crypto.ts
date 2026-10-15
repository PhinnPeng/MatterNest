import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * 字段级加密 + 盲索引（MATT-40 / F3-8，修订稿 §6.3 与 §10 B7 的落地）。
 *
 * ## 三重防线的终态（IQ-12，2026-10-10 裁定）
 *
 *   1. **存储层加密保留** —— 证件号 / 手机号在库里是密文，本模块就是那一层；
 *   2. **展示层全明文** —— 没有"显示明文"按钮、没有逐次审计（`SENSITIVE_FIELD_READ`
 *      作废为历史值）；所以每个读路径都要 `decryptField`，不 decrypt 的读法会
 *      把 `v1:…` 直接画到界面上（见本文件末尾那条"漏 decrypt 的表现"）；
 *   3. **导出两档** —— 脱敏档人人可导，明文档要 `can_read_plain` 且整批记 `EXPORT`。
 *
 * ## 为什么这个文件不在 `src/shared/crypto`
 *
 * 技术选型 §4 那行写的是 `shared/crypto`，但**禁令①**（`tools/lint-guard/restricted-imports.mjs`）
 * 禁止 `src/shared/**` import `node:*` / `crypto` —— 密钥与 AES 只能在服务端。
 * 这条冲突以禁令① 为准：`src/shared/dirs.ts` 里那个 `crypto` 目录名是选型期的占位，
 * 不是待建目录。本模块因此住在 `lib/server/` 下，**且不得被任何客户端组件 import**。
 *
 * ## 密钥托管（B7 / MATT-36）未定 —— 只阻塞部署，不阻塞实现
 *
 * 两把钥匙只从环境变量取（名字来自 `.env.example` 的「字段加密（两把密钥分离，修订稿 §6.3）」段）：
 *
 *   · `MN_AES_KEY`  —— AES-256-GCM 主密钥，32 字节；
 *   · `MN_HMAC_KEY` —— 盲索引密钥，32 字节；
 *   · `MN_KEY_VERSION` —— 密文信封的版本号（默认 1）。
 *
 * 生成：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
 * （`.env` 已 gitignore，**仓库里永不留值**；`.env.example` 只留空占位）。
 *
 * 托管方式（KMS / secret 注入 / 轮换周期）定下来之前，**不要在这里加第三处密钥来源**
 * ——文件、数据库、内置默认值都不许。轮换也还没做：换掉 `MN_AES_KEY` 会让旧密文解不开
 * （`decryptField` 会抛 GCM 认证失败，不会静默给乱码），那属于 MATT-36 的范围。
 *
 * ## 为什么缺密钥必须抛，而不是降级成明文
 *
 * 静默降级是最危险的失败形态：界面照常显示（展示层本来就要明文）、库里悄悄存明文，
 * 而"库里是密文"恰恰是这一层唯一的存在理由 —— 没有任何一处会报错，等发现时
 * 已经积累了一库明文，且**无法事后区分**哪些行是密文、哪些是明文。
 * 所以两把钥匙缺失时一律 `throw`，错误信息里带上生成命令（运维照着做就能修）。
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** AES-256-GCM 与 HMAC-SHA256 的密钥都是 32 字节；长度不符即拒（不做截断/补齐） */
const KEY_BYTES = 32;

/** 密文信封：`v<key_version>:<base64url(iv | tag | ciphertext)>`，版本号自描述，不另开列 */
const ENVELOPE = /^v(\d+):/;

/**
 * AAD（附加认证数据）：固定串。
 *
 * 它挡的是"把 A 列的密文搬到 B 列"——两列都敏感（证件号 / 手机号），搬运本身危害有限，
 * 所以这里不做逐列 AAD（那要求读的时候也知道列名，多一处能写错的地方）。
 */
const AAD = Buffer.from("mn-field-v1", "utf8");

/**
 * 密钥解析（**纯函数**，从 env 拆出来是为了能离线测）：
 * 只接受 hex（长度恰为 `bytes*2`）或 base64url 解出**恰好** `bytes` 字节的串。
 *
 * 为什么不接受"够长的口令原文"：那会让 `MN_AES_KEY=changeme` 这类值静默生效，
 * 而弱密钥和缺密钥一样是事故。宁可让人照生成命令重生成一个。
 */
export function parseKeyMaterial(raw: string | undefined, envName: string, bytes: number): Buffer {
  const v = raw?.trim();
  if (!v) {
    throw new Error(
      `缺 ${envName}：字段加密的密钥不许走默认值（有默认值等于所有部署共用一把）。` +
        `生成一个：node -e "console.log(require('crypto').randomBytes(${bytes}).toString('base64url'))"，写进 .env`,
    );
  }
  const isHex = v.length === bytes * 2 && /^[0-9a-fA-F]+$/.test(v);
  const buf = isHex ? Buffer.from(v, "hex") : Buffer.from(v, "base64url");
  if (buf.length !== bytes) {
    throw new Error(
      `${envName} 解出来 ${buf.length} 字节，需要 ${bytes} 字节（base64url 或 hex 两种写法都认）。` +
        `生成一个：node -e "console.log(require('crypto').randomBytes(${bytes}).toString('base64url'))"`,
    );
  }
  return buf;
}

/** 首次用到才读 env（与 `auth.ts` 的 `pepper()` 同一形状：缺了当场炸，不留半可用状态） */
let aesCache: Buffer | null = null;
let hmacCache: Buffer | null = null;
function aesKey(): Buffer {
  aesCache ??= parseKeyMaterial(process.env.MN_AES_KEY, "MN_AES_KEY", KEY_BYTES);
  return aesCache;
}
function hmacKey(): Buffer {
  hmacCache ??= parseKeyMaterial(process.env.MN_HMAC_KEY, "MN_HMAC_KEY", KEY_BYTES);
  return hmacCache;
}

/** 信封上的版本号；只做记录与自描述，**不做密钥选择**（一期只有一把钥匙，轮换属 MATT-36） */
function keyVersion(): string {
  return (process.env.MN_KEY_VERSION ?? "").trim() || "1";
}

/**
 * 启动期自检：密钥齐不齐、长度对不对。
 *
 * ✅ **已挂在 `instrumentation-node.ts` 的 `registerNode()` 上**（MATT-36 收紧第 3 项，
 * `src/instrumentation.spec.ts` 有四条用例钉住，含「三把都要在」与调用顺序）。
 * 挂上之前的失败点是「第一次用到加密」的那次请求 ⇒ 应用 ready、`/login` 200、
 * 直到某人打开当事人详情才 500，而**那之前没有任何一处报错**。
 *
 * ⚠ 它只管**字段加密那两把**；`MN_SESSION_PEPPER` 归 `auth.ts`
 * （`assertSessionPepperConfigured()`）。两个出口由
 * `instrumentation-node.ts` 的 `assertServerSecretsConfigured()` 合起来调用 ——
 * 「启动期密钥自检」这个名字覆盖三把，少一把都会让人以为已经查过了。
 */
export function assertFieldCryptoConfigured(): void {
  aesKey();
  hmacKey();
}

/** 明文 → 密文信封。随机 IV ⇒ **同一个明文每次密文都不同**（这正是明文唯一索引必须换成盲索引的原因） */
export function encryptField(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", aesKey(), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${keyVersion()}:${Buffer.concat([iv, tag, body]).toString("base64url")}`;
}

/** 这个值是不是本模块产出的密文信封（迁移前的存量明文不是） */
export function isEncrypted(stored: string | null | undefined): boolean {
  return typeof stored === "string" && ENVELOPE.test(stored);
}

/**
 * 密文信封 → 明文。空值给 `null`（列可空）。
 *
 * ⚠ **没有信封的值原样返回**：那是迁移 0009 之前写进去的存量明文
 * （`db/seed/0003_demo.sql` 的 5 行演示数据就是），它们还没被加密。
 * 这是一条**过渡读法**，不是"容错"：加密后的行不可能长得像明文，
 * 所以两条路不会互相冒充；等存量行回填完（见迁移 0009 的注释），
 * 这个分支就该删掉——留着它，一行漏加密的数据就永远不会被发现。
 */
export function decryptField(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === "") return null;
  if (!ENVELOPE.test(stored)) return stored;

  const raw = Buffer.from(stored.slice(stored.indexOf(":") + 1), "base64url");
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error("字段密文长度不足：信封头在、内容是坏的（截断或被改过）");
  }
  const decipher = createDecipheriv("aes-256-gcm", aesKey(), raw.subarray(0, IV_BYTES));
  decipher.setAAD(AAD);
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  // GCM 的认证标签在这里校验：换了密钥、改了一个字节都会抛，**不会**返回乱码
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * 盲索引：查重与等值检索用的**带密钥** HMAC-SHA256（hex 64 位，落 `varchar(64)` 列）。
 *
 * 为什么带密钥：证件号的空间是**可枚举**的（身份证号有校验位、统一社会信用代码有固定形状），
 * 裸 `sha256(id_number)` 能被彩虹表/字典反推 —— 那样"库里只有密文"这条防线就白设了。
 * 密钥在 env 里、不在库里，于是"拿到了库"与"拿到了明文"是两件事。
 *
 * 为什么先 `trim` 再算：入参在 DTO 层已经 trim 过（`partyLinkSchema`），这里再 trim 一次是
 * 为了让**这一层的口径**自足 —— 将来多一个调用方忘了 trim，也不会算出第二个哈希、
 * 从而让同一张身份证在库里存成两行（那正是 `uk_mn_party_identity` 要防的事）。
 *
 * `domain` 是域分隔（同一把钥匙下，同一个值在不同列得到不同哈希）：一期只用
 * `party.id_number` 一处，留参数是为了将来 `contact` 要查重时不至于复用证件号的哈希。
 */
export function blindIndex(value: string, domain = "party.id_number"): string {
  return createHmac("sha256", hmacKey())
    .update(`${domain}\u0000${value.trim()}`, "utf8")
    .digest("hex");
}

/**
 * 漏 decrypt 的表现（写给下一个读这段的人）：
 * 界面上会出现 `v1:AAAA…` 这种字符串，长度大约 60+ 字符、全是 base64 字符集。
 * 本项目已知有两处**不在本票写范围内**的读路径会这样（`services/matters.ts` 的详情
 * 当事人块、`services/risks.ts` 的 `listRiskParties`），它们把 `party.id_number`
 * 原样带进 DTO —— 修法是包一层 `decryptField`，已写进交付报告请父代理处理。
 */

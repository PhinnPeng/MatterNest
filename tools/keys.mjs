/**
 * 三把加密密钥的**产出**与**核对**（MATT-36 决策落地）。
 *
 * ```
 *   node tools/keys.mjs gen [--force]        打印三个值（不写任何文件）
 *   node tools/keys.mjs check [--env <路径>]  核对 .env 里的值与校验值是否一致
 * ```
 *
 * ## 它解决的是什么
 *
 * 裁定是「三把密钥只经 `environment:` 注入，不入库、不进镜像、不进 git」
 * （`docs/research-secret-storage.md`）。但裁定只回答了「放哪」，
 * 没回答「值从哪来」—— 而后者才是部署当天真正要做的那一步。
 *
 * 在本文件之前，那个动作是：打开 `.env.example`，从注释里抄一条
 * `node -e "console.log(require('crypto').randomBytes(32)...)"`，跑三遍，
 * 手工贴三个值。**三遍手工**是事故的来源：
 *   · 43 个随机字符手工搬运，颠倒一次不会报错（长度对、解出的字节数也对），
 *     直到读当事人详情时 GCM 认证失败才暴露 —— 而那与「服务没起」很难区分；
 *   · 三个值贴串行，或把 AES 那个贴进 HMAC 行 → 违反 NIST §5.2 的
 *     「一条 key shall 只做一个用途」，而**没有任何检查会响**；
 *   · 在已部署的机器上重跑一遍、覆盖正在用的值 ⇒ 全库 PII 永久不可读。
 *
 * 三条里最贵的是最后一条，所以 `gen` 会**读** `.env` 并拒绝运行。
 * 它**从不写入**任何文件。
 *
 * ## 为什么校验值单独占一行、而不是跟在值后面
 *
 * `# sha256 前 8 位：xxxxxxxx` 必须在 `MN_AES_KEY=` 的**上一行**。
 * 写成行尾注释的话，dotenv 是否把 ` #` 之后当注释取决于版本与解析器
 * （`@next/env` 走 dotenv，`dotenv` 对行尾 `#` 的处理在版本间变过），
 * 而「粘贴时被吃掉一个字符」正是本工具要拦的那类事故 —— 不能引入一个新的。
 * 独立注释行对解析器完全不可见，零风险。
 *
 * 校验值是 `sha256(值)` 的前 8 个 hex（32 bit）。它**不含密钥本身**，
 * 贴在 `.env` 里不增加泄漏面 —— 能读到那一行的人本来就有密钥。
 *
 * ## `check` 验两件不同的事（别把它们当一件）
 *
 *   1. 值与**紧邻上一行**的校验值一致 ⇒ 证明「搬运途中没被改坏」；
 *   2. 三把**互不相同** ⇒ 证明「没贴错行」。
 *
 * 第 2 条曾经缺席，而它的缺席方式恰好是本工具自称要拦的那一类：
 * 校验行**不绑定键名**，所以三把贴成同一把、各自上方都放**正确**的校验值时，
 * 「核对通过」照报不误（评审实测）。⇒ 校验值一致**不**代表贴对了。
 */
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 三把的形状与用途。**顺序即输出顺序**，也是 README 里的顺序。 */
const KEYS = [
  {
    name: "MN_AES_KEY",
    purpose: "当事人证件号 / 联系方式的字段级加密（AES-256-GCM）",
    blast: "换掉它 ⇒ 库中全部历史 PII **永久不可读**。decryptField 抛 GCM 认证失败、无兜底路径",
  },
  {
    name: "MN_HMAC_KEY",
    purpose: "盲索引（HMAC-SHA256），使密文列可等值检索与查重",
    blast: "换掉它 ⇒ 盲索引全变，**同一人查不出同一人**；唯一索引会拒收重复行",
  },
  {
    name: "MN_SESSION_PEPPER",
    purpose: "会话 token 的 HMAC-SHA256 密钥（cookie 存随机 token，库里只存摘要）",
    blast: "换掉它 ⇒ **全部会话立即失效**，所有人重新登录（预期行为，但要提前通知）",
  },
];

const KEY_BYTES = 32;

/**
 * `gen` 要先看一眼的 env 文件。相对仓库根解析，因为运维通常在仓库根跑。
 *
 * `--env` 可以覆盖（可重复）：部署上按环境分文件（`deploy/.env.prod` 之类）时，
 * 护栏必须看**真正会被 compose 读的那一个**，否则这道护栏对一半场景是空的。
 *
 * ⚠ 只**读**。这是本工具与「自动填充」的根本区别 ——
 * 它要拦的恰恰是自动写入会干出的事。
 */
const DEFAULT_ENV_CANDIDATES = ["deploy/.env", ".env"];

function envCandidates(rest) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--env" && rest[i + 1]) out.push(rest[i + 1]);
  }
  return out.length > 0 ? out : DEFAULT_ENV_CANDIDATES;
}

/**
 * 把一个值解析成 32 字节密钥，解析不出来给 `null`。
 *
 * 与 `src/app/lib/server/crypto/field-crypto.ts` 的 `parseKeyMaterial` 是**同一口径的
 * 两份实现**（hex 64，或 base64url 解出 32 字节）。改一处必须改另一处 ——
 * 本仓没有让 `.mjs` 工具 import `.ts` 的机制（部署机上有仓库、没有构建产物），
 * 所以这份重复是有意的，代价记在这一行。
 */
function keyBytes(value) {
  const v = value.trim();
  if (/^[0-9a-fA-F]+$/.test(v) && v.length === 64) return Buffer.from(v, "hex");
  const buf = Buffer.from(v, "base64url");
  return buf.length === KEY_BYTES ? buf : null;
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function generate() {
  return randomBytes(KEY_BYTES).toString("base64url");
}

/**
 * 从一段 env 文本里读出某个键的原始值；注释行与空行不算。
 *
 * 容忍 `export ` 前缀：shell 源的 env 文件（`set -a; . ./.env`）是常见形态，
 * 漏掉它会让整道护栏在那种文件上**空转**（评审实测：`export` 形式下 `gen` 照跑）。
 */
function readEnvValue(text, name) {
  // ⚠ 分隔符两侧一律用 `[ \t]*` 而**不是** `\s*`：`\s` 含换行，于是
  // `MN_AES_KEY=\nMN_HMAC_KEY=` 会被读成「AES 的值是 `MN_HMAC_KEY=`」——
  // 而这只差一个字符的写法让「全是空值 ⇒ 护栏不触发」变成「护栏永远触发」。
  // 那条用例当时是红的，就是它抓到的。
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*([^\\r\\n]*)`, "m");
  const hit = re.exec(text);
  return hit ? { value: hit[1].trim().replace(/^["']|["']$/g, "") } : null;
}

/**
 * `gen` 的护栏：哪些 env 文件里已经有值。
 *
 * @returns `Array<{path, present: string[]}>` —— 只列**真的有值**的那些。
 */
function findExisting(envPaths) {
  const out = [];
  for (const rel of envPaths) {
    const abs = resolve(REPO, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    const present = KEYS.filter((k) => {
      const hit = readEnvValue(text, k.name);
      return hit !== null && hit.value !== "";
    }).map((k) => k.name);
    if (present.length > 0) out.push({ path: rel, present });
  }
  return out;
}

/* ── gen ───────────────────────────────────────────────────────────────── */

const BANNER = ["## 三把加密密钥（MATT-36 裁定：只经 environment: 注入，不入库）", ""];

function cmdGen(force, envPaths) {
  const existing = findExisting(envPaths);
  if (existing.length > 0 && !force) {
    console.error("拒绝运行：这些文件里已经填过密钥了 ——");
    for (const e of existing) {
      console.error(`  ${e.path}  已有：${e.present.join(" / ")}`);
    }
    console.error("");
    console.error("在已部署的机器上重跑并覆盖正在用的值，会让库中历史 PII 永久不可读：");
    for (const k of KEYS) console.error(`  · ${k.name}：${k.blast}`);
    console.error("");
    console.error("确实要重来（新建环境、或应急轮换）才加 --force。");
    process.exitCode = 1;
    return;
  }
  if (existing.length > 0) {
    console.error("⚠ --force：下面这些文件里已有密钥，本次产出将被手工覆盖 ——");
    for (const e of existing) console.error(`  ${e.path}  ${e.present.join(" / ")}`);
    console.error("");
  }

  const lines = [...BANNER];
  const values = [];
  for (const key of KEYS) {
    const value = generate();
    values.push({ name: key.name, value });
    lines.push(`# ── ${key.name} ${"─".repeat(Math.max(0, 56 - key.name.length))}`);
    lines.push(`# 用途：${key.purpose}`);
    lines.push(`# 不可逆：${key.blast}`);
    lines.push(`# 形状：${KEY_BYTES} 字节（43 字符 base64url；64 字符 hex 也认）`);
    lines.push(`# sha256 前 8 位：${fingerprint(value)}`);
    lines.push(`${key.name}=${value}`);
    lines.push("");
  }

  lines.push("## 三条必须先读完再粘贴");
  lines.push("");
  lines.push(
    "  1. 这三个值各自独立。NIST SP 800-57 Pt1 R5 §5.2：一条 key shall 只做一个用途。",
    "     `keys:check` 与启动期自检都会验它们互不相同 —— 贴串行会直接被拦下。",
  );
  lines.push(
    "  2. 贴进 env 并启动之后，就一直用同一把。轮换不是「换个值重启」：",
    "     · MN_AES_KEY        ⇒ 全库历史 PII 永久不可读（无兜底路径）",
    "     · MN_HMAC_KEY       ⇒ 同一人查不出同一人（唯一索引拒收重复行）",
    "     · MN_SESSION_PEPPER ⇒ 全部会话立即失效（预期，但要提前通知）",
    "     换 pepper 还必须**重启进程**：pepper() 是模块级缓存，不重启不生效，且失败是静默的。",
  );
  lines.push(
    "  3. 粘贴后用 `pnpm keys:check` 核对一遍 —— 它验两件事：",
    "     · 每行上方的 sha256 前 8 位 = 该行的值（抓「字符颠倒」）",
    "     · 三把互不相同（抓「贴错行」）",
  );
  lines.push("");
  lines.push("下一站：把上面三段（含各自上方的注释行）贴进 deploy/.env。");

  console.log(lines.join("\n"));

  // 互不相同是硬要求（NIST §5.2），而 randomBytes 撞的概率可以忽略 ——
  // 但那正是「可以忽略」与「保证」的区别，而这里报错只需要一行。
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v.value)) {
      console.error(`\n产出异常：${v.name} 与前一把逐字相同 —— 这是概率事件，出现即重跑。`);
      process.exitCode = 1;
      return;
    }
    seen.add(v.value);
  }
}

/* ── check ─────────────────────────────────────────────────────────────── */

const CHECKSUM_RE = /^#\s*sha256\s*前\s*8\s*位[：:]\s*([0-9a-f]{8})\s*$/;

/**
 * 核对 env 里的值与其上方注释行的 sha256 前 8 位，并验三把互不相同。
 *
 * 逐行扫而不是按键扫：校验值在**上一行**，所以形状是成对的相邻两行。
 */
function cmdCheck(envPath) {
  const abs = resolve(REPO, envPath);
  if (!existsSync(abs)) {
    console.error(`[FAIL] 文件不存在：${envPath}`);
    process.exitCode = 1;
    return;
  }
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);

  const problems = [];
  let checked = 0;

  for (const key of KEYS) {
    const assign = new RegExp(`^\\s*(?:export\\s+)?${key.name}\\s*[:=]`);
    const at = lines.findIndex((l) => assign.test(l));
    if (at < 0) {
      problems.push(`${key.name}：文件里没有这一行（${envPath}）`);
      continue;
    }
    const eq = lines[at].search(/[:=]/);
    const value = lines[at]
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value === "") {
      problems.push(`${key.name}：第 ${at + 1} 行还是空值`);
      continue;
    }
    const above = at > 0 ? CHECKSUM_RE.exec(lines[at - 1].trim()) : null;
    if (!above) {
      problems.push(
        `${key.name}：第 ${at} 行上方没有「# sha256 前 8 位」注释行 —— ` +
          `多半是只贴了值、没贴注释（那样本工具抓不到手工搬运的错误）`,
      );
      continue;
    }
    const got = fingerprint(value);
    checked++;
    if (got !== above[1]) {
      problems.push(
        `${key.name}：第 ${at + 1} 行的值与第 ${at} 行的校验值对不上` +
          `（注释写 ${above[1]}，实际算出 ${got}）—— 抄的时候颠倒了，或贴错了行`,
      );
    }
  }

  // 三把互不相同（与启动期的 `assertKeysMutuallyDistinct()` 同一条）。
  // 按**解析后的字节**比，而不是逐字 —— 同一把写成 hex 与 base64url 也是同一把。
  const seen = new Map();
  for (const key of KEYS) {
    const assign = new RegExp(`^\\s*(?:export\\s+)?${key.name}\\s*[:=]`);
    const at = lines.findIndex((l) => assign.test(l));
    if (at < 0) continue;
    const eq = lines[at].search(/[:=]/);
    const bytes = keyBytes(lines[at].slice(eq + 1));
    if (!bytes) continue; // 形状不对的由上面两条报
    const hex = bytes.toString("hex");
    const earlier = seen.get(hex);
    if (earlier !== undefined) {
      problems.push(
        `${earlier} 与 ${key.name} 是**同一把密钥**（各自上方的校验值当然都「对」）—— ` +
          `NIST SP 800-57 Pt1 R5 §5.2「一条 key shall 只做一个用途」` +
          `⇒ 拿到它的人一次就同时拿到「解密全部 PII」与「伪造任意会话」。` +
          `启动期自检也拦这一条，所以部署时它会红。`,
      );
    }
    seen.set(hex, key.name);
  }

  // canary：一个都没验到 ⇒ 下面每条 ok 都是假绿（本仓对「扫到 0 处」有真实戒心）。
  //
  // ⚠ 它**追加**在逐条诊断之后，而不是提前 return —— 早先写成提前 return，
  // 于是「三把都只贴了值、没贴校验行」这种最常见的情况只报出 canary 那句
  // 「什么都没验」，运维看不到可执行的「注释行也要贴」。
  if (checked === 0) {
    problems.push(
      `一个值都没核对成功（${envPath}）：三把都没配上可读的校验值。` +
        `这会让本工具变成一句「全部通过」而什么都没验。`,
    );
  }

  for (const p of problems) console.error(`  [FAIL] ${p}`);
  if (problems.length > 0) {
    console.error(`\n核对失败 ${problems.length} 条（核对成功 ${checked} 条）。`);
    process.exitCode = 1;
  } else {
    console.log(
      `核对通过：${checked} 把的值与各自的 sha256 前 8 位一致，且三把互不相同（${envPath}）。`,
    );
  }
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

const [, , cmd, ...rest] = process.argv;

if (cmd === "gen") {
  cmdGen(rest.includes("--force"), envCandidates(rest));
} else if (cmd === "check") {
  const i = rest.indexOf("--env");
  cmdCheck(i >= 0 && rest[i + 1] ? rest[i + 1] : "deploy/.env");
} else {
  console.error(
    "用法：\n" +
      "  node tools/keys.mjs gen [--force]          打印三把密钥（不写任何文件）\n" +
      "  node tools/keys.mjs check [--env <路径>]   核对 env 里的值与校验值",
  );
  process.exitCode = 2;
}

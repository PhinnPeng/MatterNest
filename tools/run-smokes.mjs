/**
 * 全组冒烟的**唯一入口**（`pnpm smoke`）。
 *
 * ## 为什么需要这个工具
 *
 * 仓里有 17 个 `agent-work/smoke-*.mjs`，各自打同一个 dev server、各自连同一个共享库，
 * 但**从来没有一条命令跑过全组**（`pnpm verify` 故意不含它们：verify 必须离线可跑）。
 * 于是出现过一次真实事故：`smoke-improvements` 读的是 `process.env.BASE` / 默认端口 3000，
 * 而其余 16 个读 `SMOKE_BASE` / 3777 —— 起在默认端口时它是全组唯一连不上的那个。
 * 它**从来没成功执行过一次**，却躺在一堆"绿色冒烟"里提供虚假覆盖，而且因为没人跑全组，
 * 这件事完全不可见（`docs/retro-2026-10-14.md` 候选 3）。
 *
 * 这个工具的全部价值只有一句话：**任一脚本失败 / 超时 / 起不来 ⇒ 进程退出码非 0**。
 * 所以下面每一条设计都服务于这一句，其余都是次要的。
 *
 * ## 脚本清单靠发现，不靠人记
 *
 * 清单是 `readdirSync("agent-work")` 里匹配 `/^smoke-.*\.mjs$/` 的全部文件，按名排序。
 * 新增 `smoke-*.mjs` 自动进队 —— 硬编码清单只是把"虚假覆盖"换了个地方存放。
 * ⚠ 正则**锚定在文件名的开头**：`agent-work/cleanup-smoke.mjs` 与 `agent-work/smoke.txt`
 *  都在同一目录，但它们不是冒烟，不能被卷进来。
 * 发现结果为空 ⇒ 直接退出 1（那说明 glob 或目录坏了，此时"跑过了"是纯粹的谎）。
 *
 * ## 串行，不并行 —— 请不要"优化"成并行
 *
 * 这 17 个脚本共享**一个** dev server 和**一个**共享 dev 库，每个都在库里建临时账号、
 * 临时事项、临时当事人，然后各自清场。并发跑会让夹具互相看见：
 * `smoke-notifications` 与 `smoke-rule9` 都在读 `mn_notification` 做去重/冷却断言，
 * `smoke-batch` 自己就写了"另一个冒烟脚本同时在跑"会让 `attempts + 1` 的去重断言塌掉。
 * 串行慢，但是唯一正确的姿势。
 *
 * ## 判定以退出码为准，汇总行只是给人看的
 *
 * 退出码是脚本自己写的、已经被读过很多遍的那份事实；汇总行是人肉格式，17 个脚本有 5 种
 * 写法（见 `parseSummary`）。所以：**退出码非 0 ⇒ 失败**，无条件。
 * 反过来，**退出码 0 但整段输出里找不到任何汇总行 ⇒ 也判失败**。这不是苛刻，
 * 是本工具存在的理由：一个"没跑却安静退 0"的脚本正是本轮要消灭的东西，
 * 让它靠沉默通过等于把工具自己变成下一个假覆盖。
 *
 * ## 「清场失败」是**第三种**结果，不是失败的一种
 *
 * 17 个脚本的退出码约定见 `agent-work/_testacct.mjs` 的 `finishSmoke`：
 * 0 断言全过且库干净 / 1 断言有红 / 2 断言全过但**库被自己弄脏了** / 3 环境不对。
 *
 * 2 必须单独一类，不能并进「失败」也不能当成「通过」：
 *   · 当成「通过」= 本工具直接变成它要消灭的那个假覆盖（库里 22 个残留账号那一轮）；
 *   · 并进「失败」= 把"环境被污染，先清库再复跑"和"代码红了，去改代码"混成一件事，
 *     而这两件事的处置完全不同。
 *
 * ⚠ 判定 2 时**还要求输出里出现 `[clean] 清场失败` 标记**：脚本在预检阶段也可能退 2
 *   （早期版本用它表示"环境不对"，现已改成 3，但那类路径仍可能存在），
 *   只看退出码会把"没跑起来"误报成"跑过了但没跑干净"。
 *
 * ## 超时之后**继续**跑剩下的，不中止全组
 *
 * 一个脚本挂死（典型形态：库的隧道中途断了，查询永不返回）已经足以让本轮判红，
 * 没有任何理由因此丢掉后面 16 个脚本的信息 —— 那 16 个的结果才是"这次到底坏了什么"
 * 的答案。所以策略是：杀掉它，记成 `超时`，继续，最后照样退出非 0。
 * 代价是**强杀会留下脏夹具**（脚本死在 `finally` 的清场之前），所以汇总末尾会明确警告。
 *
 * 用法：
 *   pnpm smoke                                  # 全组（先探活，探不通直接退出 1）
 *   pnpm smoke -- --only archive --only users   # 只跑名字里含这些片段的（调试用）
 *   SMOKE_BASE=http://127.0.0.1:3777 pnpm smoke
 *   SMOKE_TIMEOUT_MS=300000 pnpm smoke          # 单脚本超时，默认 180000
 *   SMOKE_READY_TIMEOUT_MS=60000 pnpm smoke     # 探活总预算，默认 120000
 *   SMOKE_WAIT_FOR_SERVER=1 pnpm smoke           # 探不通不立刻退，而是等到预算耗尽
 *
 * 退出码：0 全部通过；1 有失败/超时/未见汇总/起不来；
 *        2 **没有硬失败、但有脚本没清干净**（断言全绿，共享库是脏的）；
 *        64 用法错误（sysexits 的 EX_USAGE —— 2 已经留给「清场失败」，两码不能重叠）。
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `tools/**` 那段 eslint 配置只登记了 `process` 与 `console`，而本文件要用 fetch
 * （探活）、AbortSignal（探活单次超时）、setTimeout（退避与超时闸）。不改共享配置
 * （那会让全部 tools/*.mjs 的 no-undef 变宽），在这里按文件声明。
 */
/* global fetch, AbortSignal, setTimeout, clearTimeout, URL */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_DIR = path.join(ROOT, "agent-work");
/** 与 17 个冒烟脚本里的默认值一致；脚本各自也读 SMOKE_BASE，这里只是探活地址 */
const DEFAULT_BASE = "http://127.0.0.1:3777";
/**
 * 探 `/login` 而不是 `/`：`/` 会重定向到登录页（多一跳，且重定向目标依赖鉴权状态），
 * 而 `/login` 是 server component 空壳（禁令⑥：不 import `lib/server/**`）——
 * 它能验到"dev server 起来了并且这一条路由编译完了"，又不会被数据库/登录态连累。
 */
const PROBE_PATH = "/login";
/**
 * 默认 180 秒，理由是可查的，不是拍的：
 *   - `smoke-batch.mjs` 自带看门狗 `WATCHDOG_MS = 150_000`（它自己那条"隧道中途断了
 *     导致查询永不返回"的死等事故留下的）。编排器的默认必须**大于**它，否则编排器会
 *     先掐掉 smoke-batch，把它自己设计好的"宁可红不可挂"变成一句没有信息量的超时。
 *   - 180 − 150 = 30 秒余量留给清场（`finally` 里的删账号/删业务行要再打十几条 SQL）。
 *   - 其余 16 个脚本没有看门狗，也没有规模探针（notifications 93 条断言、reports 51KB
 *     脚本，全是串行 HTTP），但它们若真死等，多半也是同一个隧道故障 —— 那时早杀更好。
 * 覆盖：`SMOKE_TIMEOUT_MS`。
 */
const DEFAULT_TIMEOUT_MS = 180_000;
/**
 * 探活总预算。`next dev` 是**先监听后编译**：端口一旦 accept，Turbopack 才现编第一条路由，
 * 首请求可能几十秒。这段时间里 fetch 会超时或拿到 5xx，两者都不是"没起来"，
 * 所以 5xx/超时都算"再等等"，只有 ECONNREFUSED/ENOTFOUND 才是真的没人听。
 * 覆盖：`SMOKE_READY_TIMEOUT_MS`。
 */
const DEFAULT_READY_TIMEOUT_MS = 120_000;
/** 单次探活的超时：比总预算短，才谈得上"重试" */
const PROBE_ATTEMPT_MS = 15_000;
const PROBE_RETRY_MS = 1_500;
/** 强杀宽限：SIGTERM 之后给清理逻辑一点时间，再 SIGKILL */
const KILL_GRACE_MS = 5_000;
/** 实际生效的单脚本超时（可被 SMOKE_TIMEOUT_MS 覆盖）。放这里是因为提示语与表格都要读它 */
let TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
function timeoutLabel() {
  return `${(TIMEOUT_MS / 1000).toFixed(0)}s`;
}

/** 失败详情块的容量上限。挂死的脚本可能每秒刷几千行，全留会把内存吃光 */
const CAP_HEAD = 60;
const CAP_TAIL = 120;
const CAP_FAIL = 40;
/** 失败脚本立刻回显多少行（详情块用） */
const SHOW_FAIL_LINES = 15;
const SHOW_TAIL_LINES = 10;

// ───────────────────────── 参数 ─────────────────────────

function usage(msg) {
  if (msg) console.error(`用法错误：${msg}\n`);
  console.error(
    [
      "用法：node tools/run-smokes.mjs [--only <片段>]...",
      "",
      "  --only <片段>   只跑文件名含该片段的脚本，可重复。不给就跑全组。",
      "",
      "环境变量：",
      `  SMOKE_BASE               目标 dev server（默认 ${DEFAULT_BASE}）`,
      `  SMOKE_TIMEOUT_MS         单脚本超时，默认 ${DEFAULT_TIMEOUT_MS}`,
      `  SMOKE_READY_TIMEOUT_MS   探活总预算，默认 ${DEFAULT_READY_TIMEOUT_MS}`,
      "  SMOKE_WAIT_FOR_SERVER=1  探不通时等待而不是立刻退出",
    ].join("\n"),
  );
  // 64 = EX_USAGE。**刻意不是 2**：2 已经专指「断言全过但共享库被弄脏」，
  // 两个含义挤同一个码就等于把其中之一藏回笼统的失败里。
  process.exit(64);
}

function parseArgs(argv) {
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only" || a === "-o") {
      const v = argv[++i];
      if (!v) usage(`${a} 后面要跟脚本名片段`);
      only.push(v);
    } else if (a === "--help" || a === "-h") {
      usage(null);
    } else {
      usage(`不认识 ${a}`);
    }
  }
  return only;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) usage(`${name}=${raw} 不是正数`);
  return n;
}

// ───────────────────────── 显示宽度 ─────────────────────────

// ESC 就是控制字符，而这里要匹配的正是它：冒烟输出可能带颜色码，
// 带上的话 `^\s*\[FAIL\]` 那一批会整批匹配不上（失败详情块就空了）。
// eslint-disable-next-line no-control-regex
const ANSI = new RegExp("\\u001b\\[[0-9;?]*[A-Za-z]", "g");

/** CJK 在等宽终端里占 2 列。用码位近似（不引外部包：表格只有脚本名与几个数字）。 */
function charWidth(cp) {
  if (cp === 0x200b || (cp >= 0x0300 && cp <= 0x036f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function dispWidth(s) {
  let w = 0;
  for (const ch of String(s).replace(ANSI, "")) w += charWidth(ch.codePointAt(0));
  return w;
}

function pad(s, n) {
  return String(s) + " ".repeat(Math.max(0, n - dispWidth(s)));
}

function padStart(s, n) {
  return " ".repeat(Math.max(0, n - dispWidth(s))) + String(s);
}

function secs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

// ───────────────────────── 汇总行解析 ─────────────────────────

/**
 * 仓里实际出现过的 5 种汇总写法（逐个读脚本确认过，不是猜的）：
 *   ① `PASS：61 通过 / 0 失败` / `FAIL：…`            —— 11 个脚本，最常见
 *   ② `冒烟：8 通过 / 0 失败`                        —— smoke-demo
 *   ③ `✅ 全绿：93 通过 / 0 失败` / `❌ 有红：…`      —— notifications / rule9
 *   ④ `通过 61 · 失败 0`                             —— smoke-import（分隔符是 `·`）
 *   ⑤ `冒烟：7/7 通过，失败 S3 S4`                    —— smoke-improvements（分子分母式）
 *
 * 本函数**只吃通过数与失败数**，不解析 PASS/FAIL/✅ 这些词 —— 17 个里只有 11 个会打它们，
 * 拿它们当锚点等于让 6 个脚本永远解析不出汇总。
 *
 * 容错清单（这些都是仓里真实存在的写法，不是假想）：
 *   - 分隔符可以是空格 / `：` / `：` / `·` / `/` / `，`，前后可有任意空白；
 *   - 行首可以有 `PASS`、`✅ 全绿`、`冒烟` 等任意前缀；
 *   - ANSI 颜色先剥掉；
 *   - `通过` 与 `失败` 可以落在同一行，也可以分落两行（扫全行 + 从后往前找）；
 *   - `N/M 通过` 与 `N 通过 … M 失败` 两种算式都认；
 *   - `失败` 后面若跟的是**标识符而不是数字**（`失败 S3 S4`），不算失败计数 ——
 *     否则 `失败 S3` 里的 `3` 会被读成"失败 3 条"。
 *
 * 仍读不出 ⇒ 返回 null，调用方按"未见汇总"处理（判失败）。
 */
function parseSummary(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(ANSI, "").trim())
    .filter(Boolean);

  // 从后往前找：汇总行总是最后一个（清场日志在它之前）
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = parseSummaryLine(lines[i]);
    // 优先要"像汇总"的那一行（含 失败 或分子分母式），
    // 避免把某条断言说明里的"通过率"之类误当成总结
    if (m && (m.fail !== null || m.total !== null)) return m;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = parseSummaryLine(lines[i]);
    if (m) return m;
  }
  return null;
}

/**
 * 取紧邻在 `word` 前后、且**不被别的分隔符隔开**的那个数字。
 *
 * 必须同时认两个方向，因为仓里的两种语序都真实存在：
 *   词后：`通过 12 · 失败 0`（smoke-import）   → 先找词后
 *   词前：`93 通过 / 0 失败`（11 个脚本 + notifications/rule9） → 再找词前
 * 只认一个方向就会静默漏掉另一半的脚本，而漏掉的形状恰好是**多数派**。
 *
 * `[\s:：·]*` 是不许跨过斜杠、分号一类分隔符：否则 `93 通过 / 0 失败` 里的 0
 * 会被当成"通过数"，一行汇总会被读成 `通过 0 / 失败 null`。
 * ⚠ 词前那侧只允许空白 —— `失败 S3 S4`（标识符，不是计数）必须读成 null，
 *   交给分母去算，否则 "失败 S3" 里的 3 会被当成"失败 3 条"。
 */
function countNear(word, line) {
  const after = line.match(new RegExp(`${word}[\\s:：·]*(\\d+)`));
  if (after) return Number(after[1]);
  const before = line.match(new RegExp(`(\\d+)\\s*${word}`));
  if (before) return Number(before[1]);
  return null;
}

function parseSummaryLine(line) {
  if (!line.includes("通过")) return null;

  // 形状 ⑤：`7/7 通过`（分子分母式，smoke-improvements）
  const ratio = line.match(/(\d+)\s*\/\s*(\d+)\s*通过/);
  const total = ratio ? Number(ratio[2]) : null;
  const pass = ratio ? Number(ratio[1]) : countNear("通过", line);
  if (pass === null) return null;

  const explicitFail = countNear("失败", line);
  const fail = explicitFail !== null ? explicitFail : total !== null ? total - pass : null;
  return { pass, fail, total };
}

// ───────────────────────── 探活 ─────────────────────────

/**
 * 两种失败形态必须分开，因为它们要不同的处置：
 *   - **没人听**（ECONNREFUSED / ENOTFOUND）：`pnpm smoke` 是人主动敲的命令，
 *     服务没起就是没起。立刻带着"怎么起"退 1，比让 17 个脚本各吐一遍 ECONNREFUSED
 *     再让人自己猜强一万倍。（`SMOKE_WAIT_FOR_SERVER=1` 切到等待模式，给 CI 用。）
 *   - **在听但没准备好**（fetch 超时 / 5xx）：`next dev` 先 accept 后编译，
 *     首请求几十秒很正常。这不是错误，是还没好 —— 所以重试到预算耗尽。
 * 判定"准备好"的标准：状态码 < 500。5xx 意味着这条路由编译失败或运行时炸了，
 * 那是另一回事，值得再试但不该被当成 ready。
 */
async function waitForServer(base, { budgetMs, waitMode }) {
  const url = base.replace(/\/+$/, "") + PROBE_PATH;
  const deadline = Date.now() + budgetMs;
  let attempt = 0;

  for (;;) {
    attempt++;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PROBE_ATTEMPT_MS),
        redirect: "manual",
      });
      if (res.status < 500) {
        return { ok: true, attempt, status: res.status };
      }
      console.log(`  探活 ${attempt}：HTTP ${res.status}（dev server 还在编译或已报错，继续等）`);
    } catch (e) {
      const code = e?.cause?.code ?? e?.code;
      if ((code === "ECONNREFUSED" || code === "ENOTFOUND") && !waitMode) {
        return { ok: false, attempt, reason: "down", code };
      }
      console.log(`  探活 ${attempt}：${code ?? e?.message ?? e}（继续等）`);
    }
    if (Date.now() >= deadline) return { ok: false, attempt, reason: "not-ready" };
    await sleep(PROBE_RETRY_MS);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从 base 里取端口，只为拼提示语。base 若不带端口（80/443）就回落到默认口 */
function portOf(base) {
  try {
    return new URL(base).port || "3777";
  } catch {
    return "3777";
  }
}

function printNoServer(base, probe, budgetMs) {
  console.error("");
  console.error(`✖ 冒烟中止：${base} 上没有可用的 dev server。`);
  if (probe.reason === "down") {
    console.error("");
    console.error("  端口上没人听（不是慢，是没起）。两条路：");
    console.error("");
    console.error("    ① 另开一个终端起它（端口必须对上，`next dev` 不给 -p 就是 3000）：");
    console.error(`         pnpm dev --port ${portOf(base)}`);
    console.error("       起了以后再回来跑 pnpm smoke。");
    console.error("");
    console.error("    ② 或者把这次运行指到已经在跑的另一个地址：");
    console.error(`         $env:SMOKE_BASE='${base}'; pnpm smoke`);
    console.error("       ⚠ 3000 ↔ 3777 这个坑正是本工具要拦的那一类：脚本连不上与脚本坏了，");
    console.error("         长得一模一样（一句 ECONNREFUSED），只有探活能分开。");
    console.error("");
    console.error("  不想立刻退（等别人把服务起起来）就加 SMOKE_WAIT_FOR_SERVER=1。");
  } else {
    console.error("");
    console.error(`  端口有人在听（探测 ${probe.attempt} 次，累计预算 ${budgetMs}ms 用完），`);
    console.error(`  但 ${base}${PROBE_PATH} 一直没给出 < 500 的响应。两种可能：`);
    console.error(
      "    ① dev server 首次编译这条路由（正常，等一会儿就好）—— 调大 SMOKE_READY_TIMEOUT_MS 再试；",
    );
    console.error("    ② 它编译失败 / 运行时报错（异常）—— 看起 dev server 那个终端的红字。");
  }
  console.error("");
  console.error("  ⚠ 这里刻意**不**继续跑那批脚本：让它们各自吐一遍 ECONNREFUSED，");
  console.error("    只会把一个清楚的环境问题变成十几段看起来像代码问题的堆栈。");
}

// ───────────────────────── 子进程 ─────────────────────────

/**
 * `--env-file` 的处置（**刻意**的，不是顺带的）：
 *
 * 17 个冒烟脚本一个都不调 `process.loadEnvFile()`，它们全靠命令行上的
 * `--env-file=.env` 拿 `PG*`（`tools/db-check.mjs` 与 `tools/migrate.mjs` 相反，
 * 自己在进程里 loadEnvFile）。编排器不传这个 flag，17 个脚本会全部连不上库，
 * 然后每个都吐一句"数据库连不上"——和 ECONNREFUSED 同一类灾难。
 *
 * 所以：**`.env` 存在就显式传给每个子进程；不存在就不传，并且说出来。**
 * 不传时也不该崩：`.env` 在 `.gitignore` 里，一个新克隆的仓库本来就没有它，
 * 那时脚本该报的是"PGDATABASE 连不上"，不是编排器的 ENOENT。
 *
 * 另一条为什么可以放心：Node 的 `--env-file` **不覆盖**已存在的环境变量
 * （实测 `FOO=shell` + 文件里 `FOO=file` ⇒ 读到 shell 的值）。所以编排器用
 * `env` 显式注入的 `SMOKE_BASE` 不会被 `.env` 里的陈旧值盖掉 —— 这是"显式注入
 * 一定赢"的前提，值不值得依赖它已实测过。
 */
function childArgs(scriptAbs, envFile) {
  return envFile ? ["--env-file", envFile, scriptAbs] : [scriptAbs];
}

/** 当前正在跑的子进程。只为 Ctrl-C 用（见下面的安装处） */
let currentChild = null;

// Ctrl-C 不处理的话，编排器自己退了、子脚本还活着：它在共享库里继续建夹具、
// 拿着事务、跑完还会清场 —— 而清场可能撞上下一个已经开始跑的人。
// 直接 SIGKILL 而不是 SIGTERM：用户已经明确表示"别再等了"，清场可以事后手工做。
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (currentChild) currentChild.kill("SIGKILL");
    console.error(`\n收到 ${sig}：已强杀当前脚本并退出。共享库里可能留有夹具，记得清。`);
    process.exit(130);
  });
}

function runSmoke(file, { base, timeoutMs, envFile }) {
  const scriptAbs = path.join(SMOKE_DIR, file);
  const started = Date.now();

  return new Promise((resolve) => {
    const head = [];
    const tail = [];
    const fails = [];
    /**
     * 清场收尾报告整块。`fails` 只收得住**含「清场失败」字样**的行，而报告里
     * 逐条列出的「`· 临时账号 xxx —— 原因`」不含那四个字 —— 只靠 fails 的话，
     * 详情块会只剩一行标题，看不出到底是哪个账号没删掉。所以从标题行起整块收。
     */
    const cleanup = [];
    let inCleanupReport = false;
    let remainder = "";

    const push = (line) => {
      const s = line.replace(ANSI, "").replace(/\r$/, "");
      if (head.length < CAP_HEAD) head.push(s);
      tail.push(s);
      if (tail.length > CAP_TAIL) tail.shift();
      // 判定失败的行形态：仓里 17 个脚本的 ok() 统一打 `[FAIL]`，外加三种中断形态
      if (/^\s*\[FAIL\]|❌|冒烟中断|脚本中断|清场失败|冒烟脚本自身出错/.test(s)) {
        if (fails.length < CAP_FAIL) fails.push(s);
      }
      if (/清场失败 \d+ 项/.test(s)) inCleanupReport = true;
      if (inCleanupReport && cleanup.length < CAP_FAIL) cleanup.push(s);
    };

    let child;
    try {
      child = spawn(process.execPath, childArgs(scriptAbs, envFile), {
        cwd: ROOT,
        env: { ...process.env, SMOKE_BASE: base },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        file,
        status: "launch-failed",
        exitCode: null,
        signal: null,
        elapsedMs: 0,
        summary: null,
        head: [],
        tail: [],
        fails: [],
        cleanup: [],
        spawnError: e?.message ?? String(e),
      });
      return;
    }

    let timedOut = false;
    let settled = false;
    let killTimer = null;
    currentChild = child;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM 给 5 秒：脚本的 finally 里要连库删夹具，砍太快等于把共享库留在脏状态
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    const onData = (chunk) => {
      // 实时透传：冒烟单条断言的 detail 常常就是排查的全部线索，不能等跑完才给
      process.stdout.write(chunk);
      const lines = (remainder + chunk.toString("utf8")).split(/\n/);
      remainder = lines.pop() ?? "";
      for (const l of lines) push(l);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      currentChild = null;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        file,
        status: "launch-failed",
        exitCode: null,
        signal: null,
        elapsedMs: Date.now() - started,
        summary: null,
        head,
        tail,
        fails,
        cleanup,
        spawnError: e?.message ?? String(e),
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      currentChild = null;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (remainder) push(remainder);

      const text = [...head, ...tail].join("\n");
      const summary = parseSummary(text);

      let status;
      // 「清场失败」要**两个信号同时**成立：退出码 2，且输出里有 `[clean] 清场失败`。
      // 只看退出码会把预检阶段退 2 的脚本（= 环境不对、什么都没跑）误报成"跑过了但没跑干净"。
      const cleanupMarked = fails.some((l) => l.includes("清场失败"));
      if (timedOut) status = "timeout";
      else if (code === 2 && summary && cleanupMarked) status = "clean-failed";
      else if (code !== 0)
        status = "fail"; // 退出码是硬事实：崩了/断言红了都走这里
      else if (!summary)
        status = "no-summary"; // 静默退 0 = 虚假覆盖，必须红
      else status = "pass";

      resolve({
        file,
        status,
        exitCode: code,
        signal,
        elapsedMs: Date.now() - started,
        summary,
        head,
        tail,
        fails,
        cleanup,
        spawnError: null,
      });
    });
  });
}

// ───────────────────────── 报告 ─────────────────────────

const STATUS_TEXT = {
  pass: "通过",
  fail: "失败",
  timeout: "超时",
  "no-summary": "未见汇总",
  "launch-failed": "起不来",
  "clean-failed": "清场失败",
};

function printFailureDetail(r) {
  console.log("");
  console.log(`──── ${r.file} · ${STATUS_TEXT[r.status]} · 详情 ────`);
  if (r.spawnError) console.log(`无法启动：${r.spawnError}`);

  const why = [];
  if (r.status === "timeout") why.push(`超过 ${timeoutLabel()} 未结束，已强杀`);
  if (r.status === "fail")
    why.push(`退出码 ${r.exitCode}${r.signal ? `（信号 ${r.signal}）` : ""}`);
  if (r.status === "clean-failed")
    why.push(
      `退出码 ${r.exitCode}：断言全过，但清场有失败 —— **共享库是脏的**。` +
        `下面列出的就是没删掉的账号/夹具，先手工清再复跑，否则下一轮会因为撞号假红。`,
    );
  if (r.status === "no-summary") why.push("退出码 0，但输出里没有任何汇总行");
  if (why.length) console.log(why.join("；"));

  // 清场失败：先把「哪些账号没删掉、为什么」整块打出来，再谈断言。
  // 这一支的断言多半是全绿的，只打 [FAIL] 行会得到一句"没有 [FAIL] 行"，
  // 读者会以为工具误判——实际上红在库上，不在断言上。
  if (r.cleanup.length) {
    console.log("  ── 清场收尾报告 ──");
    for (const l of r.cleanup) console.log(`  ${l}`);
  }

  if (r.fails.length) {
    const shown = r.fails.slice(0, SHOW_FAIL_LINES);
    for (const l of shown) console.log(`  ${l}`);
    if (r.fails.length > shown.length) {
      console.log(`  …… 还有 ${r.fails.length - shown.length} 行 [FAIL] 未显示`);
    }
  } else {
    console.log("  （输出里没有 [FAIL] 行 —— 这一支多半不是断言红，见上面的原因）");
  }

  const tail = r.tail.slice(-SHOW_TAIL_LINES);
  console.log(`  ── 末 ${tail.length} 行 ──`);
  for (const l of tail) console.log(`  ${l}`);
  console.log("──────────────────────────────");
}

function printTable(results) {
  const rows = results.map((r) => {
    const asserts = r.summary ? `${r.summary.pass} 通过 / ${r.summary.fail ?? "?"} 失败` : "—";
    // 被信号杀掉的拿不到退出码，补一句信号名，免得那一格只剩一个破折号看不出发生了什么
    const code = r.exitCode === null ? (r.signal ? `—(${r.signal})` : "—") : String(r.exitCode);
    return [r.file, STATUS_TEXT[r.status], code, secs(r.elapsedMs), asserts];
  });
  const head = ["脚本", "结果", "退出码", "用时", "断言"];
  const w = head.map((h, i) => Math.max(dispWidth(h), ...rows.map((c) => dispWidth(c[i]))));
  const line = (cells) =>
    cells.map((c, i) => (i === 0 ? pad(c, w[i]) : padStart(c, w[i]))).join("  ");

  console.log("");
  console.log("════════ 冒烟汇总 ════════");
  console.log(line(head));
  console.log(w.map((n) => "─".repeat(n)).join("  "));
  for (const r of rows) console.log(line(r));

  const tally = {
    pass: 0,
    fail: 0,
    timeout: 0,
    "no-summary": 0,
    "launch-failed": 0,
    "clean-failed": 0,
  };
  let passAssertions = 0;
  let failAssertions = 0;
  for (const r of results) {
    tally[r.status]++;
    if (r.summary) {
      passAssertions += r.summary.pass ?? 0;
      failAssertions += r.summary.fail ?? 0;
    }
  }
  const broken = results.filter((r) => r.status !== "pass");

  console.log("─".repeat(w.reduce((a, b) => a + b, 0) + 8));
  console.log(
    `合计 ${results.length} 个脚本 · 通过 ${tally.pass} · 失败 ${tally.fail} · ` +
      `超时 ${tally.timeout} · 未见汇总 ${tally["no-summary"]} · 起不来 ${tally["launch-failed"]}` +
      ` · 清场失败 ${tally["clean-failed"]}`,
  );
  const asserts =
    failAssertions > 0
      ? `断言 ${passAssertions} 通过 / ${failAssertions} 失败`
      : `断言 ${passAssertions} 通过`;
  console.log(asserts);
  console.log(`目标 ${base} · 单脚本超时 ${timeoutLabel()}`);

  if (broken.length) {
    console.log("");
    console.log("未通过的脚本（每条的第一处 [FAIL] 在上面的详情块里）：");
    for (const r of broken) {
      const first = r.fails[0]?.trim() ?? (r.spawnError ? r.spawnError : "（无 [FAIL] 行）");
      const code = r.exitCode === null ? "无退出码" : `exit=${r.exitCode}`;
      console.log(`  · ${r.file}  ${STATUS_TEXT[r.status]}  ${code}  ${first}`);
    }
  }

  // 被强杀的脚本死在 `finally` 的清场之前，夹具会留在共享库里。
  // 必须在这里说出来：下一次跑的人会把这些残留当成"上一个人留下的脏数据"，
  // 然后花半天查一个自己造成的库污染（`docs/retro-2026-10-14.md` 候选 2 就是这件事）。
  if (tally.timeout > 0) {
    console.log("");
    console.log(
      `⚠ 有 ${tally.timeout} 个脚本是被强杀的。它们很可能没跑到 finally 的清场，` +
        `库里会留下临时账号与业务行 —— 先清干净再跑下一轮，否则后面几轮会因为撞号/撞证件号假红。`,
    );
  }

  // 清场失败单列一段：它不是"代码红了"，而是"这一次运行污染了共享库"。
  // 混进「失败」里，处置（清库 + 复跑）就会被当成改代码的理由。
  if (tally["clean-failed"] > 0) {
    console.log("");
    console.log(
      `⚠ 有 ${tally["clean-failed"]} 个脚本**断言全过但没清干净**（退出码 2）。` +
        `这不是代码红了，是共享库被这一轮弄脏了：`,
    );
    for (const r of results.filter((x) => x.status === "clean-failed")) {
      const items = r.cleanup.length ? r.cleanup.join(" / ") : "（报告未捕获，见上面的详情块）";
      console.log(`  · ${r.file} —— ${items}`);
    }
    console.log("  先把这些账号与夹具行手工清掉再跑下一轮，否则 db:check 会报出指不到来源的红。");
  }
}

// ───────────────────────── 主流程 ─────────────────────────

const only = parseArgs(process.argv.slice(2));

const envFile = path.join(ROOT, ".env");
const useEnvFile = existsSync(envFile);
const base = (process.env.SMOKE_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");
const readyBudget = intEnv("SMOKE_READY_TIMEOUT_MS", DEFAULT_READY_TIMEOUT_MS);
const waitMode = process.env.SMOKE_WAIT_FOR_SERVER === "1";
TIMEOUT_MS = intEnv("SMOKE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

// ---- 发现 ----
const all = existsSync(SMOKE_DIR)
  ? readdirSync(SMOKE_DIR)
      .filter((f) => /^smoke-.*\.mjs$/.test(f))
      .sort()
  : [];
if (all.length === 0) {
  console.error(`✖ ${SMOKE_DIR} 下没有任何 smoke-*.mjs —— 发现逻辑坏了，不是"没有冒烟可跑"。`);
  process.exit(1);
}
const scripts = only.length ? all.filter((f) => only.some((frag) => f.includes(frag))) : all;
if (scripts.length === 0) {
  usage(`--only ${only.join(" / ")} 没匹配到任何脚本；现有：${all.join(", ")}`);
}

console.log(`冒烟编排 → ${base}`);
console.log(`发现 ${all.length} 个 smoke-*.mjs，本次跑 ${scripts.length} 个（串行）`);
console.log(
  useEnvFile
    ? `子进程环境：--env-file .env 存在，已显式传给每个脚本（Node 语义：已存在的环境变量优先，SMOKE_BASE 不会被 .env 盖掉）`
    : `子进程环境：.env 不存在，不传 --env-file（脚本会缺 PG*，那是脚本该报的错，不是这里的）`,
);
if (only.length) console.log(`过滤：--only ${only.join(" --only ")}`);
console.log(`探活目标：${base}${PROBE_PATH} · 单脚本超时 ${timeoutLabel()}`);

const probe = await waitForServer(base, { budgetMs: readyBudget, waitMode });
if (!probe.ok) {
  printNoServer(base, probe, readyBudget);
  process.exit(1);
}
console.log(`探活通过：HTTP ${probe.status}（第 ${probe.attempt} 次）`);
console.log("");

// ---- 逐个跑 ----
const results = [];
for (const [i, file] of scripts.entries()) {
  const r = await runSmoke(file, {
    base,
    timeoutMs: TIMEOUT_MS,
    envFile: useEnvFile ? envFile : null,
  });
  results.push(r);
  const asserts = r.summary ? `${r.summary.pass}通过/${r.summary.fail ?? "?"}失败` : "无汇总行";
  console.log(
    `[${String(i + 1).padStart(2)}/${scripts.length}] ${pad(file, 24)} ` +
      `${STATUS_TEXT[r.status]}  exit=${r.exitCode ?? "—"}  ${secs(r.elapsedMs)}  ${asserts}`,
  );
  if (r.status !== "pass") printFailureDetail(r);
  console.log("");
}

printTable(results);

// 退出码是这个工具的全部价值所在：任何一支没绿，进程就不能是 0。
// 2 单独留给"断言全绿、但共享库被弄脏"——它必须能一路传到 `pnpm smoke` 的调用方，
// 否则最外层又把它压回一个笼统的 1，"跑过了"与"跑干净了"在顶层又同形了。
// 用法错误另给 64（EX_USAGE），否则它和 2 在外面看是同一件事。
const hardBroken = results.some((r) => r.status !== "pass" && r.status !== "clean-failed");
const cleanupBroken = results.some((r) => r.status === "clean-failed");
process.exit(hardBroken ? 1 : cleanupBroken ? 2 : 0);

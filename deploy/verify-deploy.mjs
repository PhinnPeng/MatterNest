/**
 * 部署配置的机械核对（MATT-71）。
 *
 * ## 为什么它必须存在
 *
 * `deploy/README.md` 在 MATT-71 之前列着「反向代理与 Node 服务的最小可用配置」
 * 这项交付物，而 `deploy/` 下**只有那份 README** —— 没有 `nginx.conf`，
 * 全仓搜 `nginx` / `proxy_pass` / `proxy_read_timeout` 零命中。
 * 一份没人执行的建议文档，正是本票点名要治的失败模式。
 *
 * 所以这份脚本**读配置、算数值、断言**，不是复述 README。
 *
 * ## 它断言什么（以及每条背后的形状）
 *
 * 1. **`proxy_read_timeout` 在 `location = /api/import` 上 ≥ 120s。**
 *    MATT-44 实测 1000 行导入 = 81.0s；父代理裁定「维持 1000 行上限 + 超时 ≥ 120s」。
 *    nginx 默认 60s ⇒ 这条请求必然 504 而服务端照跑完 —— 「客户端看起来失败、
 *    服务端其实成功」是最难排查的形状。
 * 2. **超时值不是写在注释里。** 解析前剥掉 `#` 注释，只在真正生效的指令里找。
 *    这是判据「在配置里看得见，而不是写在注释里」的字面实现。
 * 3. **请求体上限存在，且导入那条 ≥ 应用自己的 schema 上限。**
 *    上限**从 `src/shared/schema/import.ts` 现读现算**（`MAX_IMPORT_CSV_CHARS`
 *    × 3 字节/字符的 UTF-8 上界）。改 schema 忘了改 nginx，这里会红。
 * 4. **`client_max_body_size` 在 server 级存在**（非导入端点的兜底）。
 * 5. **导入 location 上 `proxy_next_upstream off`** —— 默认值 `error timeout`
 *    意味着 nginx 会在超时后自己重试；单副本时是空操作，加副本那一刻就变成
 *    「用户没点、nginx 自己把 81 秒的导入跑了两遍」。
 *
 * ## 怎么跑
 *
 *   node deploy/verify-deploy.mjs
 *
 * 退出码 0 = 全部通过；1 = 有断言失败。**不需要数据库、不需要 Docker、
 * 不需要构建** —— 纯文本解析，所以它能进任何一次提交前检查。
 *
 * ## 写法约定
 *
 * 失败走 `process.exitCode = 1` + `console.error`，**不 throw**：
 * 判据要求「把超时改回 60 ⇒ 必须红为**断言**，而不是崩」——
 * 崩（未捕获异常 / 解析炸掉）与红（断言不成立）在 CI 里长得很像，
 * 但只有后者能告诉人「哪一条不成立、期望多少、实际多少」。
 */
/* global process, console */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

/** 导入实测（秒）。来源：MATT-44 交付评论，1000 行 = 81.0s（81ms/行，逐行一事务）。 */
const IMPORT_MEASURED_SECONDS = 81.0;
/** 父代理裁定：超时必须 ≥ 120s。取 120 而不是 81 —— 实测值不是设计余量。 */
const IMPORT_MIN_TIMEOUT_SECONDS = 120;

/** 应用自己的请求体字符上限，从源码现读（`MAX_IMPORT_ROWS = 1000` 配套的那条）。 */
const IMPORT_SCHEMA_FILE = join(REPO, "src", "shared", "schema", "import.ts");

const failures = [];

function fail(what, expected, actual) {
  failures.push({ what, expected, actual });
  console.error(`  [FAIL] ${what}\n         期望：${expected}\n         实际：${actual}`);
}

function ok(what, actual) {
  console.log(`  [ok]   ${what} = ${actual}`);
}

/* ── nginx 解析 ─────────────────────────────────────────────────────────── */

/**
 * 剥掉 `#` 注释，保留行号以便报错时能指到行。
 *
 * 为什么必须剥：判据要求超时「在配置里看得见，而不是写在注释里」。
 * 不剥的话，一份把 `proxy_read_timeout 180s;` 整行注释掉的配置也能通过断言，
 * 而 nginx 跑起来会用 60s —— 断言与运行时行为脱节，断言就白写了。
 */
function stripComments(text) {
  return text.split("\n").map((line, i) => {
    let inSingle = false;
    let inDouble = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === "\\") {
        c++;
        continue;
      }
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === "#" && !inSingle && !inDouble) return { text: line.slice(0, c), line: i + 1 };
    }
    return { text: line, line: i + 1 };
  });
}

/**
 * 抽出 `location <matcher> { ... }` 的指令表。
 *
 * 用大括号配对而不是正则 —— nginx 的 `location` 可以写成一行
 * （`location /api/ { proxy_pass ...; }`），正则会在这种写法上漏掉。
 * 深度从 0 起只吃 `location` 块，块内指令按 `{ name: value }` 收集，
 * 重复出现的指令保留**最后一个**（与 nginx「后写的覆盖先写的」一致）。
 *
 * ⚠ matcher 必须按「`location` 与 `{` 之间的全部内容」取，不能用 `\S+`：
 *   本仓最关键的那块是 `location = /api/import {`，matcher 是 `= /api/import` ——
 *   **带一个空格**。`\S+` 会把它截成 `=`，于是正则要求 `{` 紧跟其后而匹配失败，
 *   整块被静默跳过。初版就是这么写的，第一次跑出来「解析到 3 个 location」而实际 4 个。
 */
function parseLocations(lines) {
  const locations = [];
  let i = 0;
  while (i < lines.length) {
    const { text, line } = lines[i];
    // 非贪婪取到 `{` 之前，允许 matcher 含空格（`= /api/import`、`~ ^/api/x$`）
    const m = /^\s*location\s+(.+?)\s*\{/.exec(text);
    if (!m) {
      i++;
      continue;
    }
    const matcher = m[1].trim();
    const startLine = line;
    // 从本行 `{` 之后开始计深度
    let depth = 1;
    let body = text.slice(text.indexOf("{") + 1);
    i++;
    while (i < lines.length && depth > 0) {
      const cur = lines[i];
      depth += (cur.text.match(/\{/g) ?? []).length;
      depth -= (cur.text.match(/\}/g) ?? []).length;
      if (depth <= 0) {
        // 本行是收尾行；`}` 之前可能还有指令
        body += "\n" + cur.text.slice(0, cur.text.lastIndexOf("}"));
        break;
      }
      body += "\n" + cur.text;
      i++;
    }
    const directives = {};
    for (const raw of body.split("\n")) {
      const d = /^\s*([a-z_]+)\s+([^;]+);/.exec(raw);
      if (d) directives[d[1]] = d[2].trim();
    }
    locations.push({ matcher, directives, startLine });
    i++;
  }
  return locations;
}

/** nginx 时长 → 秒。支持 `90s` / `2m` / `1h` / 裸数字（= 秒）。 */
function parseSeconds(value) {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(String(value).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || "s";
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
}

/** nginx 体积 → 字节。支持 `8m` / `1M` / `512k` / 裸数字（= 字节）。 */
function parseBytes(value) {
  const m = /^(\d+(?:\.\d+)?)([kKmMgG]?)$/.exec(String(value).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return Math.round(n * { "": 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[unit]);
}

/* ── 应用侧上界：从源码现读 ─────────────────────────────────────────────── */

function readImportCharLimit() {
  const src = readFileSync(IMPORT_SCHEMA_FILE, "utf8");
  const m = /export const MAX_IMPORT_CSV_CHARS\s*=\s*([\d_]+)/.exec(src);
  if (!m) return null;
  return Number(m[1].replace(/_/g, ""));
}

/* ── 断言 ──────────────────────────────────────────────────────────────── */

function verify() {
  const confPath = join(HERE, "nginx.conf");
  const raw = readFileSync(confPath, "utf8");

  console.log("\n[MATT-71] 部署配置机械核对");
  console.log(`  配置：${confPath}`);
  console.log(
    `  基准：导入实测 ${IMPORT_MEASURED_SECONDS}s，裁定超时下限 ${IMPORT_MIN_TIMEOUT_SECONDS}s\n`,
  );

  const lines = stripComments(raw);
  const locations = parseLocations(lines);

  console.log("① 解析出的 location：");
  for (const l of locations) console.log(`     line ${l.startLine}  ${l.matcher}`);
  if (locations.length === 0) {
    fail("解析出至少一个 location 块", ">0", "0（配置无法解析或没有 location）");
    return;
  }

  console.log("\n② 断言：");

  // ── 1. 导入 location 存在 ──
  // 下面 2/4 两条断言都挂在这块上。它不在时**只报这一条**就收工 ——
  // 否则一次缺失会级联出三条同源失败，把「哪一处不成立」淹掉。
  const importLoc = locations.find((l) => l.matcher === "= /api/import");
  if (!importLoc) {
    fail(
      "存在 location = /api/import",
      "精确匹配块 `location = /api/import { ... }`",
      `实际只解析到：${locations.map((l) => l.matcher).join(", ")}`,
    );
    console.log("");
    return;
  }
  ok("导入 location", `line ${importLoc.startLine}  ${importLoc.matcher}`);

  // ── 1b. 导入 location 的读超时 ──
  const got = importLoc.directives.proxy_read_timeout;
  if (got === undefined) {
    fail(
      "导入 location 显式设置 proxy_read_timeout",
      "一条生效指令（不能只写在注释里）",
      "该块内没有 proxy_read_timeout ⇒ 继承 nginx 默认 60s ⇒ 81s 的导入必然 504",
    );
  } else {
    const seconds = parseSeconds(got);
    if (seconds === null) {
      fail("proxy_read_timeout 的值可解析", "如 `180s` / `120s` / `2m`", got);
    } else if (seconds < IMPORT_MIN_TIMEOUT_SECONDS) {
      fail(
        "导入读超时 ≥ 裁定下限",
        `≥ ${IMPORT_MIN_TIMEOUT_SECONDS}s（实测 ${IMPORT_MEASURED_SECONDS}s）`,
        `${got} = ${seconds}s —— 会 504 而服务端照跑完 ${IMPORT_MEASURED_SECONDS}s 的导入`,
      );
    } else {
      ok("导入 proxy_read_timeout", `${got}（= ${seconds}s，下限 ${IMPORT_MIN_TIMEOUT_SECONDS}s）`);
    }
  }

  // ── 2. 请求体上限 ──
  const chars = readImportCharLimit();
  if (chars === null) {
    fail(
      "从 src/shared/schema/import.ts 读到 MAX_IMPORT_CSV_CHARS",
      "一个数字常量",
      "没读到 —— 无法推导导入的请求体下界，body 上限断言失去依据",
    );
  } else {
    // 中文 UTF-8 = 3 字节/字符；Astral 字符 4 字节 / 2 个 UTF-16 单元 = 2 字节/单元，
    // 不构成更坏情形。JSON 转义（引号/换行）也只放大 ASCII 部分，同样 ≤ 3 字节/字符。
    const utf8Upper = chars * 3;
    const needed = importLoc.directives.client_max_body_size;
    const bytes = needed === undefined ? null : parseBytes(needed);
    if (needed === undefined) {
      fail(
        "导入 location 覆盖 client_max_body_size",
        "一条生效指令",
        "未设置 ⇒ 继承上层（通常 1m）⇒ 大 CSV 在跑起来之前就被 413",
      );
    } else if (bytes === null) {
      fail("client_max_body_size 的值可解析", "如 `8m` / `1m` / `512k`", needed);
    } else if (bytes < utf8Upper) {
      fail(
        "导入请求体上限 ≥ 应用 schema 允许的 CSV 上界",
        `≥ ${utf8Upper} 字节（MAX_IMPORT_CSV_CHARS=${chars} × 3）`,
        `${needed} = ${bytes} 字节 —— 合法的大导入会在开始前被 413，` +
          `而 1000 行 / ${IMPORT_MEASURED_SECONDS}s 的实测就是按这个上界做的`,
      );
    } else {
      ok("导入 client_max_body_size", `${needed}（= ${bytes}B，schema 下界 ${utf8Upper}B）`);
    }
  }

  // ── 3. 非导入端点的 body 兜底 ──
  // http{} 级那条是全局兜底；根 location 里的那条是「页面壳与静态资源」的兜底。
  // 这里断言的是**配置里存在非注释的 client_max_body_size**（任意层级）——
  // 因为框架侧按设计不设 body limit，这一层是唯一的防线。
  const active = raw
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  if (!/^\s*client_max_body_size\s+\S+;/m.test(active)) {
    fail(
      "配置中存在（非注释）client_max_body_size",
      "至少一条生效指令",
      "一条都没有 ⇒ 框架侧按设计也不设 body limit ⇒ 没有任何一层限制请求体",
    );
  } else {
    ok("client_max_body_size（存在性）", "已设置");
  }

  // ── 4. nginx 不自己重试长请求 ──
  const nu = importLoc.directives.proxy_next_upstream;
  if (nu === undefined) {
    fail(
      "导入 location 显式 proxy_next_upstream off",
      "`proxy_next_upstream off;`",
      "未设置 ⇒ 默认 `error timeout` ⇒ nginx 超时后自己重试；单副本是空操作，" +
        "加第二个副本那一刻就变成导入被跑两遍",
    );
  } else if (nu.toLowerCase() !== "off") {
    fail("导入 location 的 proxy_next_upstream", "off", nu);
  } else {
    ok("导入 proxy_next_upstream", nu);
  }

  console.log("");
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

try {
  verify();
} catch (e) {
  // 只有「配置读不出来 / 解析炸了」才走到这里 —— 那是**崩**，不是红。
  // 判据要的是后者；这里如实区分并给出非零退出。
  console.error("\n[FATAL] 核对脚本自身失败（这不是断言失败，是读不到配置）：");
  console.error(e);
  process.exitCode = 1;
}

if (failures.length > 0) {
  console.error(`\n[MATT-71] 失败 ${failures.length} 条断言。\n`);
  process.exitCode = 1;
} else {
  console.log(`[MATT-71] 全部断言通过。\n`);
}

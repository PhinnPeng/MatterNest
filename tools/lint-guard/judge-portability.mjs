/**
 * 禁令⑪ 判据脚本可移植（2026-10-16，retro 候选 1 + 2）。
 *
 * ## 这条断言防的是什么
 *
 * 本仓的「完成判据」就是 `agent-work/` 下的脚本（MATT-1 目的地第 2 条：
 * 每票的判据要能被**别人独立跑一遍**复现）。而 `agent-work/` 恰好是
 * **五道门禁一道都不读它**的地方：eslint 与 prettier 都忽略了它
 * （`eslint.config.mjs` 的 `ignores`、`.prettierignore` 的 `agent-work/`），
 * `anchors:check` 只从 `revred-*.mjs` 抽 needle 字面量，
 * `run-smokes.mjs` 只发现 `smoke-*.mjs`（22 个 `probe-*.mjs` 没有任何运行者）。
 * 于是「脚本起不来」与「功能有缺陷」在结果上同形：都只有一个非零退出码。
 *
 * 2026-10-16 实测到的两种形态（都是真事，不是设想）：
 *
 *   ① 10 个探针写死 `ms-playwright/chromium-1224/chrome-win64/chrome.exe`，
 *      而本机 ms-playwright 下只有 `chromium-1248` ⇒ 它们**一条都起不来**，
 *      且这个状态躺了整整一个版本周期：没有任何东西会跑它们，也就没人知道。
 *   ② 11 个探针写死全局 playwright 的绝对路径
 *      `F:/WorkSoftware/nvm/v22.22.2/node_modules/playwright/index.js` ——
 *      那条路径绑在 **node 版本目录**上，而 `playwright` 根本不在 `package.json`。
 *
 * 另有一条**入库**坑（同一轮实测）：`agent-work/` 是白名单制忽略的
 * （`.gitignore` 逐个 `!` 放行），新增共用助手 `_chrome.mjs` 时**不会被提交**，
 * 而本地跑得好好的 —— 只有别人 clone 时才炸成「import 一个不存在的文件」。
 * 本仓最容易接受不了的就是这种「本地全绿、别人全红」。
 *
 * ## 三条断言
 *
 *   ① 语法：每个入库的 `agent-work/*.mjs` 都要 `node --check` 通过。
 *      没人跑它们，那就至少让「写坏了」在提交时说话。
 *   ② 相对 import 的目标必须**已入库**（`git ls-files` 判定）。
 *   ③ 机器绝对路径字面量一律不许出现：判据脚本必须能在别人的机器上起来，
 *      本机事实只能经环境变量推导（出口是 `agent-work/_chrome.mjs`）。
 *
 * ## 抓不到什么（别高估它）
 *
 *   · 抓不到「路径取法对了但依赖没装」：那要真起一次浏览器，而真起需要 dev server 与开发库。
 *   · 抓不到 `smoke-*.mjs` 的语义（那是禁令⑧ 的事），也抓不到草稿：只有**已入库**的
 *     `agent-work/*.mjs` 进扫描范围 —— 60+ 个 `_dbg-*` / `_probe_*` 草稿文件不付代价。
 *   · 抓不到 `*.spec.ts`（`agent-work/smoke-import.spec.ts` 由 vitest 真跑，缺依赖会红）。
 *   · 抓不到恒假断言 —— 那种形状与正确写法同形（上一份 retro 已记，仍然成立）。
 */
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * 机器绝对路径的形状 —— ⚠ 只认**引号形态**（`"…"` / `'…'`），与「富文本白名单」
 * 「副标题纪律」同一条判据：说明文字里会**写**这些路径（`_chrome.mjs` 的文件头就写着
 * 那条失效过的路径，好让下一个人知道为什么不能写死），词级匹配会把解释也拦下来；
 * 引号形态才是「真的有人在代码里用了它」。
 *
 * ⚠ 刻意**不是**泛化的 `[A-Za-z]:[\\/]`：那会把 `https://` 里的 `s:/` 也吃掉
 * （本仓冒烟脚本满篇 URL）。这里只列「人写死自己机器」的真实形态：
 * 盘符 + 常见机器目录，或 POSIX 路径里的家目录 / 挂载点。
 *
 * 抓不到的形态（写清楚，别让读的人以为它兜住了全部）：模板串 `` `${x}/C:/Users` `` 形态
 * 与「路径拼出来的」都不在范围内 —— 本仓判据脚本写路径用的都是普通字符串（实测）。
 */
const MACHINE_PATH =
  /["']((?:[A-Za-z]:[\\/](?:Users|WorkSoftware|Program|Windows|ms-playwright)|(?:\/Users\/|\/home\/|\/mnt\/))[^"'\n]*)/g;

/** 相对 import 的三种写法：静态 `from`、动态 `import()`、`require()` */
const RELATIVE_SPECS = [
  /from\s+"(\.[^"]+)"/g,
  /import\(\s*"(\.[^"]+)"\s*\)/g,
  /require\(\s*"(\.[^"]+)"\s*\)/g,
];

/** 已入库的 `agent-work/*.mjs`。判据脚本的「入库」事实只能由 git 回答，所以读 `git ls-files`。 */
function trackedJudgeScripts(failures) {
  return new Promise((resolve) => {
    execFile("git", ["ls-files", "agent-work"], { encoding: "utf8" }, (err, stdout) => {
      if (err) {
        // 宁可红：判不出「文件是否入库」时，本条断言给不出任何结论，
        // 而「给不出结论却报绿」正是本仓禁止的那种假通过。
        failures.push(
          `判据可移植：\`git ls-files agent-work\` 跑不起来（${err.message.split("\n")[0]}）—— ` +
            "第 ② 条（import 目标是否入库）因此无法判定，不给结论。",
        );
        resolve([]);
        return;
      }
      resolve(
        stdout
          .split("\n")
          .map((l) => l.trim().replace(/\\/g, "/"))
          .filter((f) => f.endsWith(".mjs")),
      );
    });
  });
}

/** `node --check` 逐个子进程太慢，用一个小并发池：同一份真解析器，语义不打折 */
async function syntaxErrors(files) {
  const queue = [...files];
  const bad = [];
  const worker = async () => {
    for (;;) {
      const file = queue.shift();
      if (file === undefined) return;
      const detail = await new Promise((resolve) => {
        execFile(process.execPath, ["--check", file], (err, _out, stderr) =>
          resolve(err ? (stderr || err.message).trim().split("\n").slice(0, 3).join(" / ") : null),
        );
      });
      if (detail) bad.push({ file, detail });
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  return bad;
}

/**
 * @param {string[]} failures 收集到的违规。由 check.mjs 传进来 ——
 *   `failures` 是那个文件的局部变量，这里看不到，所以必须显式传。
 */
export async function assertJudgePortability(failures) {
  const files = await trackedJudgeScripts(failures);
  if (files.length === 0) {
    failures.push("判据可移植：一个入库的 `agent-work/*.mjs` 都没读到 —— 三条断言全是假通过");
    return;
  }

  // ① 语法
  for (const { file, detail } of await syntaxErrors(files)) {
    failures.push(
      `${file} 语法不过（\`node --check\`）：${detail}\n` +
        "    判据脚本没有任何运行者会替你发现它写坏了 —— 提交时是唯一的机会。",
    );
  }

  // ② 相对 import 的目标必须已入库
  const tracked = new Set(files);
  let resolved = 0;
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    const specs = RELATIVE_SPECS.flatMap((re) => [...code.matchAll(re)].map((m) => m[1]));
    for (const spec of new Set(specs)) {
      resolved++;
      const target = path.posix.join(path.posix.dirname(file), spec);
      if (!existsSync(target)) {
        failures.push(`${file} 引了不存在的 \`${spec}\`（${target} 不存在）`);
      } else if (!tracked.has(target)) {
        failures.push(
          `${file} 引了**没入库**的 \`${spec}\`（${target} ∈ 磁盘、∉ git）——\n` +
            "    `agent-work/` 是白名单制忽略：新增共用助手必须在 `.gitignore` 里显式 `!` 放行。\n" +
            "    漏放行的后果是「本地全绿、别人 clone 下来 import 失败」，而这条判据存在的理由\n" +
            "    恰恰是「别人能独立跑一遍」。",
        );
      }
    }
  }
  if (resolved === 0) {
    failures.push("判据可移植：一条相对 import 都没解析到 —— 第 ② 条是假通过（正则或路径写歪了）");
  }

  // ③ 机器绝对路径
  let scanned = 0;
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    scanned++;
    for (const m of code.matchAll(MACHINE_PATH)) {
      failures.push(
        `${file}:${code.slice(0, m.index).split("\n").length} 的字符串里写死了机器路径 \`${m[1]}\` ——\n` +
          "    判据脚本要能在别人的机器上起来；本机事实只能经环境变量推导，出口是 `agent-work/_chrome.mjs`。\n" +
          "    它已经失效过一次：写死 `chromium-1224` 的 10 个探针在本机 `chromium-1248` 下一条都起不来。",
      );
    }
  }
  if (scanned < 50) {
    failures.push(`判据可移植：只扫到 ${scanned} 个入库脚本（实测量级 80+）—— 第 ③ 条是假通过`);
  }
}

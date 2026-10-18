/**
 * 探针共用的**「本机事实」取法**：浏览器可执行文件。
 *
 * ## 为什么这些取法必须收敛在这一个文件里
 *
 * 2026-10-16 实测，两种同形失效：
 *   · 10 个探针写死 `ms-playwright/chromium-1224/...`，而本机只有 `chromium-1248`
 *     ⇒ 它们**一条都起不来**，且这个状态持续了一个版本周期没人知道；
 *   · 11 个探针写死全局 playwright 的绝对路径 `F:/WorkSoftware/nvm/v22.22.2/...`
 *     —— 那条路径绑在 **node 版本目录**上，node 一升级同样全灭。
 *
 * 两种失效同形：退出码非零。而「探针起不来」与「实现了缺陷」在结果上长得一模一样
 * —— 这正是本仓最忌讳的那种静默。判据脚本（MATT-1 目的地第 2 条：要能被别人独立跑一遍复现）
 * 里的本机路径只能有一个出口，就是这里；门禁盯着这一点：`tools/lint-guard/judge-portability.mjs`。
 *
 * ## 2026-10-17：`playwright` 已进 `devDependencies`，`playwrightRoot()` 随之退役
 *
 * 上一版两个函数都靠「本机事实」现推（版本目录里找最大号、从 `process.execPath` 反推
 * 全局安装）。当年这么写是因为 `playwright` **不在 `package.json` 里**，只有一份全局安装；
 * 现在它声明成 devDependency（`1.64.1`），模块解析由 node 负责 —— 探针里
 * `createRequire(import.meta.url)("playwright")` 就是全部。
 *
 * 那一版的欠账注释自己写着「哪天把它声明成 devDependency，这个函数就退成一行 import，
 * 而 11 个探针的调用点一个字都不用改」；2026-10-17 正是那天：**函数删掉，调用点改一行**。
 *
 * ## 2026-10-18：补上非 Windows 分支 —— CI 第一次真跑冒烟，当场红在这里
 *
 * 这一条是**实测出来的**，不是预判。仓库此前**从没跑过 CI**；PR #1 是第一次，
 * `run-smokes.mjs` 按 `/^smoke-.*\.mjs$/` 自动把 `smoke-visual.mjs`（唯一会起浏览器的冒烟）
 * 排进 25 脚本，于是它在 `ubuntu-latest` 上第一次执行即抛：
 *
 *     [FAIL] 视觉冒烟自身出错 — LOCALAPPDATA 未设置 —— 这个取法假定 Windows 的 ms-playwright 安装位置
 *
 * 也就是本节上一版末尾自己写下的那句欠账（「⚠ 这是唯一还带 Windows 形状的取法……真要把探针
 * 搬上 Ubuntu CI，改的是这一处」）。现在改了。
 *
 * ⚠ 但**只改取法不够**：CI 上还必须真把浏览器装出来。`playwright@1.64.1` 的
 * `package.json` 里**没有 `postinstall`**（实测 `scripts: undefined`），浏览器由 CLI
 * `playwright install` 显式下载 —— 所以 `.github/workflows/ci.yml` 里有对应的一步。
 * 少那一步的话，本函数会在「找不到可执行文件」处抛，报错清楚、但覆盖为零。
 *
 * ## 两条解析路径，Windows 扫描优先
 *
 *   ① **Windows**：扫 `%LOCALAPPDATA%/ms-playwright/chromium-<版本号>`，取**版本号最大**的那个。
 *      留着它是因为开发机上 `ms-playwright` 里可能装着多个修订号，而 playwright
 *      自己期望的那个未必是已装的那个 —— 本仓就栽过一次（全局那份 `1.59.1` 期望
 *      `chromium-1217`，机器上只有 `1248`）。取「已装的最新一份」绕开了修订号解析。
 *   ② **其它平台（Linux CI）**：交给 playwright 自己的 `chromium.executablePath()`。
 *      它按 `browsers.json` 的修订号 + 平台目录名解析，并尊重 `PLAYWRIGHT_BROWSERS_PATH`
 *      —— 这三件事手写一份只会写错。CI 每次都是干净安装，修订号必然对得上，正是它成立的前提。
 *
 * 顺序不能反：开发机上两条路指向同一个文件（2026-10-18 实测一致），但 ① 能容忍
 * 「装了两个修订号」这种开发机常态，② 不能。所以先 ①、取不到再 ②。
 *
 * ## 一个函数，**抛错**，不返回 null
 *
 * `null` 传下去只会变成 `chromium.launch({ executablePath: null })` 那种
 * 「报的是别的功能的错」的现场。取不到就当场说清楚缺什么、怎么补。
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * 开发机（Windows）的解析：取 `ms-playwright` 下**版本号最大**的那个 chromium。
 *
 * 版本号不写死 —— 目录名由 `playwright install` 决定（见文件头：它自己期望的修订号
 * 与本机装的那份可以不一致，所以这里不查 `browsers.json`，只取已装的最新一份）。
 *
 * 取不到返回 `undefined`（**不抛**）：`LOCALAPPDATA` 在非 Windows 上本来就没有值，
 * 那不是错误，只是该走另一条路径 —— 见 `pickChrome()`。
 */
function pickChromeWindows() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const root = path.join(localAppData, "ms-playwright");
  if (!existsSync(root)) return undefined;
  return readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .map((d) => path.join(root, d, "chrome-win64", "chrome.exe"))
    .find((p) => existsSync(p));
}

/**
 * 其它平台的解析：问 playwright 自己。
 *
 * ⚠ **懒加载** `playwright` —— 本文件被 16 个探针 import，在顶层 require 会让
 * 「playwright 没装」在 import 期就把它们一起打死，而其中多数并不需要浏览器。
 */
function pickChromeViaPlaywright() {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const exe = chromium.executablePath();
  if (existsSync(exe)) return exe;
  throw new Error(
    `playwright 期望的 chromium 不在 ${exe} —— 先跑 \`pnpm exec playwright install chromium\``,
  );
}

/**
 * 浏览器可执行文件。两条解析路径见文件头；都取不到就抛错说明缺什么。
 */
export function pickChrome() {
  return pickChromeWindows() ?? pickChromeViaPlaywright();
}

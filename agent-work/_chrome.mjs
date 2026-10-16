/**
 * 探针共用的**「本机事实」取法**：浏览器可执行文件、playwright 模块根。
 *
 * ## 为什么这些取法必须收敛在这一个文件里
 *
 * 2026-10-16 实测，两种同形失效：
 *   · 10 个探针写死 `ms-playwright/chromium-1224/...`，而本机只有 `chromium-1248`
 *     ⇒ 它们**一条都起不来**，且这个状态持续了一个版本周期没人知道；
 *   · 11 个探针写死全局 playwright 的绝对路径 `F:/WorkSoftware/nvm/v22.22.2/...`
 *     —— 那条路径绑在 **node 版本目录**上（`playwright` 不在 `package.json` 里，
 *     只有一份全局安装），node 一升级同样全灭。
 *
 * 两种失效同形：退出码非零。而「探针起不来」与「实现了缺陷」在结果上长得一模一样
 * —— 这正是本仓最忌讳的那种静默。判据脚本（MATT-1 目的地第 2 条：要能被别人独立跑一遍复现）
 * 里的本机路径只能有一个出口，就是这里；门禁盯着这一点：`tools/lint-guard/judge-portability.mjs`。
 *
 * ## 两个函数都**抛错**，不返回 null
 *
 * `null` 传下去只会变成 `chromium.launch({ executablePath: null })` 那种
 * 「报的是别的功能的错」的现场。取不到就当场说清楚缺什么、怎么补。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * 浏览器可执行文件：取 `ms-playwright` 下**版本号最大**的那个 chromium。
 *
 * 版本号不写死 —— 目录名由 `npx playwright install` 决定，本机已经滚过一次。
 * `LOCALAPPDATA` 缺失（非 Windows 或极简环境）⇒ 抛错，而不是回落到一个写死的用户名目录。
 */
export function pickChrome() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA 未设置 —— 这个取法假定 Windows 的 ms-playwright 安装位置");
  }
  const root = path.join(localAppData, "ms-playwright");
  const hit = existsSync(root)
    ? readdirSync(root)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
        .map((d) => path.join(root, d, "chrome-win64", "chrome.exe"))
        .find((p) => existsSync(p))
    : undefined;
  if (!hit) {
    throw new Error(
      `找不到 ms-playwright 下的 chromium（找过 ${root}，期望 chromium-<版本号>/chrome-win64/chrome.exe）—— ` +
        "先跑 `npx playwright install chromium`",
    );
  }
  return hit;
}

/**
 * playwright 模块根：**当前 node 自己的全局安装**，而不是某台机器的绝对路径。
 *
 * nvm-windows 的形状是 `<node>/node.exe` + `<node>/node_modules/`（`nodejs` 目录是指向
 * 当前版本的软链），所以从 `process.execPath` 推出来即可 —— 换 node 版本它跟着走，
 * 这正是写死 `nvm/v22.22.2` 做不到的。
 *
 * ⚠ 这是**欠账的取法**：`playwright` 至今不在 `package.json`（技术选型 §13 把它写在测试栈里，
 * 依赖却只有全局那份）。哪天把它声明成 devDependency，这个函数就退成一行 `import`，
 * 而 11 个探针的调用点一个字都不用改。
 */
export function playwrightRoot() {
  const dir =
    process.env.MN_PLAYWRIGHT_ROOT ??
    path.join(path.dirname(process.execPath), "node_modules", "playwright");
  const entry = path.join(dir, "index.js");
  if (!existsSync(entry)) {
    throw new Error(
      `找不到 playwright（探针的浏览器依赖只有全局安装，不在 package.json 里）：\n` +
        `  期望：${entry}\n` +
        "  修法：`npm i -g playwright`（再 `npx playwright install chromium`），" +
        "或设 `MN_PLAYWRIGHT_ROOT` 指向 playwright 的模块目录。",
    );
  }
  return entry;
}

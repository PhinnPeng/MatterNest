/**
 * 浏览器可执行文件路径**不写死版本号**的取法（探针共用）。
 *
 * 背景：一批旧探针写死了 `ms-playwright/chromium-1224/...`，而本机已经滚到 1248
 * （2026-10-16 实测：`ms-playwright` 下只有 `chromium-1248`）—— 于是它们**一条都起不来**。
 * 而「探针起不来」与「实现了缺陷」在结果上同形（都只有一个非零退出码），
 * 这正是本仓最忌讳的那种静默。所以统一走这里：取 `ms-playwright` 下版本号最大的那个 chromium。
 *
 * 用法：`const CHROME = pickChrome()` → `chromium.launch({ executablePath: CHROME })`。
 * 返回 `null` 表示本机没装（**调用方必须自己判**，别把 null 当成一个可用的路径）。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export function pickChrome() {
  const root = path.join(
    process.env.LOCALAPPDATA ?? "C:/Users/Administrator/AppData/Local",
    "ms-playwright",
  );
  if (!existsSync(root)) return null;
  const hit = readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .map((d) => path.join(root, d, "chrome-win64", "chrome.exe"))
    .find((p) => existsSync(p));
  return hit ?? null;
}

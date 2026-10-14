/**
 * 把 `.githooks/` 里的 hook 装进 `.git/hooks/`（2026-10-14，retro 候选 4①）。
 *
 * ## 为什么不用 husky
 *
 * husky 解决的是同一件事，代价是一个依赖 + 一套自己的目录约定。
 * 本仓的 hook 只有一个（pre-commit），而 Node 脚本复制文件是免费的 ——
 * 为一个 hook 引入一个依赖，是拿机制换机制。
 *
 * ## 为什么需要 `prepare`
 *
 * `.git/hooks/` **不随版本库走**（它在 `.git/` 里，clone 下来是模板）。
 * 所以 hook 的正文放在**入库的** `.githooks/`，由 `prepare` 在 `pnpm install`
 * 时复制过去。这样 hook 本身有版本历史、有 review，而安装是自动的。
 *
 * 已装过的机器：`pnpm prepare` 重跑一次即可（幂等）。
 *
 * ## 幂等与失败语义
 *
 * 已存在且内容相同 ⇒ 不动（不产生无意义的 mtime 变化）。
 * 已存在但内容不同 ⇒ 覆盖并打印一句（本地改过 hook 的人会想知道）。
 * 复制失败 ⇒ 非 0 退出，`pnpm install` 失败 —— 装不上 hook 是环境问题，
 * 不该静默成功然后让人以为有门禁。
 */

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, ".githooks");
const dstDir = join(root, ".git", "hooks");

let installed = 0;
let skipped = 0;
let overwritten = 0;

try {
  const hooks = (await readdir(srcDir)).filter((f) => !f.endsWith(".md"));
  if (hooks.length === 0) {
    console.error("install-githooks: .githooks/ 里没有 hook —— 本脚本是假通过");
    process.exit(1);
  }

  await mkdir(dstDir, { recursive: true });

  for (const name of hooks) {
    const src = join(srcDir, name);
    const dst = join(dstDir, name);
    const before = await readFile(dst, "utf8").catch(() => null);
    const body = await readFile(src, "utf8");

    if (before === body) {
      skipped++;
      continue;
    }
    if (before !== null) overwritten++;

    await writeFile(dst, body);
    // hook 必须可执行，否则 git 静默跳过它（不报错，只是不跑）
    await copyFile(src, dst).catch(() => {});
    installed++;
    console.log(`githooks: 已安装 .githooks/${name} → .git/hooks/${name}`);
  }

  // 兜底：确认真的可执行。Windows 上 copyFile 不保证 mode，
  // 而 git 在 Windows 走的是 shell 执行 —— 这里只报不修，
  // 因为本仓的 hook 是 `#!/bin/sh`，由 git 自己解释。
  console.log(
    `githooks: ${installed} 安装 / ${skipped} 已最新 / ${overwritten} 覆盖` +
      (overwritten ? "（覆盖前请确认本地没有未提交的 hook 改动）" : ""),
  );
} catch (e) {
  console.error(`githooks: 安装失败 —— ${e?.message ?? e}`);
  process.exit(1);
}

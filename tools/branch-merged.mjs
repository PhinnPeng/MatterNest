/**
 * 关票守卫：「这票的分支已并入集成分支了吗」——一条可当门禁跑的机械检查。
 *
 * ## 它防的是什么
 *
 * **「票关了」与「交付落到集成分支上」是两件事，而后者没有任何一步会替你检查。**
 * 2026-10-17 一次会话里连着踩了两次，形态同一个，两次都不是粗心，而是**中断后没回头**：
 *
 *   · 修复提交 `43407cd`（MATT-63）**从未并入**：一次 `git merge` 因主工作区有未提交改动
 *     而 abort；补完那次改动后**忘了重跑 merge**。分支上文件是新的、主工作区是旧的
 *     ⇒ 冒烟脚本每次崩在同一个参数错上，还往共享库留管理员账号（把 `db:check` C14 弄红）。
 *     抓到它的是全组冒烟的 `db:check` C14。
 *   · `ticket/matt67` **整支未并入**，票已关：更隐蔽 —— 该分支自己 `verify` 全绿、单测全绿，
 *     全组冒烟也不报错（导入页不在任何冒烟脚本的必经路径上）⇒ **代码根本不在集成分支里，
 *     而票是 Done**。清理 worktree 时手工核才发现。
 *
 * ## ⚠ 为什么必须是机械检查，而且这个机械检查曾写错过
 *
 * 「被打断」是这类施工的常态（并行 worktree + 后台代理 + 长任务），所以任何
 * 「必须回头做」的步骤都得有东西替你回头看 —— 靠「记得」两次都没兜住。
 *
 * 而本工具前身的那一版**是坏的**：`for b in ticket/*` 里的 `ticket/*` 是 **shell 文件名通配**，
 * 不是 git 分支通配。repo 里没有 `ticket/` 目录，通配符不展开，循环只跑一次、`$b` 是字面量
 * `ticket/*`：
 *
 *     $ for b in ticket/*; do git merge-base --is-ancestor "$b" HEAD && echo "✓ $b" || echo "✗ $b 未并入"; done
 *     fatal: Not a valid object name ticket/*
 *     ✗ ticket/* 未并入
 *
 * ⇒ **全并入和一个没并入都只印同一行 `✗`** —— 一条恒假的门禁比没有门禁更糟，它让下一个
 * 人以为这步是机械检查。所以本工具的分支名一律由 `git branch --list <glob>` 枚举，
 * 并且**扫到 0 个分支判失败**（见下），不允许「通配符写歪」退化成静默通过。
 *
 * ## canary：扫到 0 个分支 = 失败，不是通过
 *
 * 本仓对「扫到 0 处 ⇒ 看起来全绿」有真实戒心（`board-drift` 两维 canary、`judge-portability`
 * 三条假通过断言）。本工具同理：glob 匹配 0 个分支时，**判不出任何东西却报绿**正是这类
 * 假通过 —— 可能是 glob 写错了、可能在错的仓里跑、也可能分支真被删光了。三种都该有人看，
 * 所以一律非零退出并说明原因。
 *
 * ## 只读 / 离线
 *
 * 只跑 `git branch --list` 与 `git merge-base --is-ancestor`，不碰网络、不碰库、不改任何数据。
 *
 * 用法：`node tools/branch-merged.mjs ['<glob>']`（glob 省略时默认 `ticket/*`；
 * 含 `*` 时务必加引号，否则先被 shell 展开成文件名 —— 那正是上面那个事故的形状）。
 * 退出码：0 全部已并入；1 有分支未并入，或 canary 不通过，或 git 调用失败。
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_GLOB = "ticket/*";

/**
 * 判据本体：给定分支名列表，逐个问「它是 HEAD 的祖先吗」。
 *
 * 纯函数（不碰 git），两个真实事故的判据都在这里，可离线测：
 *   · 绿 ⇒ 该分支的提交**全在** HEAD 里，交付确实落到了集成分支上；
 *   · 红 ⇒ 分支上至少有一个提交不在 HEAD 里 —— 关票前必须先合并。
 *
 * @returns `{rows: {branch, merged}[], unmerged: string[], ok}`
 */
export function grade(branches, isAncestor) {
  const rows = branches.map((branch) => ({ branch, merged: isAncestor(branch) }));
  const unmerged = rows.filter((r) => !r.merged).map((r) => r.branch);
  return { rows, unmerged, ok: unmerged.length === 0 };
}

/** 枚举匹配 glob 的本地分支（`git branch --list` 是唯一的正确取法，见文件头）。 */
export function listBranches(glob, repoRoot = ".") {
  const out = spawnSync("git", ["branch", "--list", glob, "--format=%(refname:short)"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (out.status !== 0) {
    throw new Error(
      `git branch --list '${glob}' 失败（退出码 ${out.status}）：${(out.stderr ?? "").trim() || "无 stderr"}`,
    );
  }
  return (out.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** `branch` 是否为 HEAD 的祖先。三态：0 是、1 否、其它（如 128 不是有效对象名）是错误。 */
export function isAncestor(branch, repoRoot = ".") {
  const out = spawnSync("git", ["merge-base", "--is-ancestor", branch, "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (out.status === 0) return true;
  if (out.status === 1) return false;
  // ⚠ 不许把「问不出来」当成「没并入」或「已并入」：那是另一种假通过。原样抛出。
  throw new Error(
    `git merge-base --is-ancestor ${branch} HEAD 异常（退出码 ${out.status}）：` +
      `${(out.stderr ?? "").trim() || "无 stderr"}`,
  );
}

/* ── 入口 ──────────────────────────────────────────────────────────────── */

// 只有被**直接执行**时才跑 CLI（被 import 时安静退出）——
// 否则 `import { grade } from "./branch-merged.mjs"` 会在 import 期把整个进程带崩。
const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) main();

function main() {
  const glob = process.argv[2] ?? DEFAULT_GLOB;

  let branches;
  try {
    branches = listBranches(glob);
  } catch (e) {
    console.error(`[FAIL] ${e.message}`);
    process.exit(1);
    return;
  }

  // canary：0 个分支 ⇒ 判不出任何东西，必须红（见文件头）
  if (branches.length === 0) {
    console.error(
      `[FAIL] glob '${glob}' 一个分支都没匹配到 —— 本次不构成「全部已并入」的结论。\n` +
        "    排查：① glob 是不是写成了文件名形态（`for b in ticket/*` 那种，通配符不展开）；\n" +
        "    ② 是不是在错的仓库 / 错的 HEAD 上跑；③ 分支是不是真被删光了。\n" +
        `    正确取法是 git branch --list '<glob>'（本工具已在用），不是在 shell 里裸用通配符。`,
    );
    process.exit(1);
    return;
  }

  let result;
  try {
    result = grade(branches, (b) => isAncestor(b));
  } catch (e) {
    console.error(`[FAIL] ${e.message}`);
    process.exit(1);
    return;
  }

  console.log(`关票守卫：分支是否已并入 HEAD（glob '${glob}'，共 ${branches.length} 支）`);
  for (const { branch, merged } of result.rows) {
    console.log(merged ? `✓ ${branch}` : `✗ ${branch} 未并入`);
  }

  if (!result.ok) {
    console.error(
      `[FAIL] ${result.unmerged.length} 支未并入：${result.unmerged.join(" / ")}\n` +
        "    关票**之前**先合并；过滤到 Done 的票若其分支在这张清单里，票就是假的 Done。",
    );
    process.exit(1);
    return;
  }

  console.log(`全部 ${branches.length} 支已并入 HEAD。`);
}

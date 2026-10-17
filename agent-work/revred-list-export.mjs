/**
 * 反向红工具（MATT-64 列表导出 / F1-20 + F2-23）。
 *
 * 用法：node agent-work/revred-list-export.mjs <split-predicate|no-gate> [restore]
 *
 * 两个模式各摘掉**一条口径**，证明断言真的钉住了它（没红过一遍的断言不算数）：
 *
 *  · `split-predicate` —— 让导出**自己拼一套谓词**（漏掉归档二态那一项）。
 *    期望红：
 *      · 离线：`matters.spec.ts` 的「列表与导出走**同一个** where 构造器」；
 *      · 真库：`smoke-list-export.mjs` 的 ④ 两条（在办视图 3 vs 3 仍然相等，
 *        但归档档变成 3 vs 1 —— 那正是"两处各写一遍谓词"的静默形态：
 *        多数筛选恰好一样，错的只有少数几档）。
 *    **为什么必须红这条**：这是本票最要紧的 AC （导出集合与列表可见集合逐行一致）。
 *
 *  · `no-gate` —— 摘掉两个导出端点里 `canReadPlain` 的那道门（明文导出不再判特权）。
 *    期望红：
 *      · 离线：两条 `route.spec.ts` 的「无 canReadPlain ⇒ 403」；
 *      · 真库：`smoke-list-export.mjs` 的 ⑥ / ⑨ 两条（L2 的明文导出会变成 200）。
 *    **为什么必须红这条**：门被摘掉之后功能**看起来完全正常**（只有拿特权的人会发现
 *    "我怎么也能导明文"），而这正是权限草案 §7.3 要求留痕、IQ-12 要求门禁的那件事。
 *
 * ⚠ 还原一律 `restore`，不要用 `git checkout`（工作树里常年有未提交的改动）；
 *   备份后缀带本工具自己的名字（`-listexport`），与别的 revred 工具不会互相踩
 *   （撞同一个 `.bak` 的后果是**假绿**，revred-archive 那轮真的发生过）。
 *
 * ⚠ 同一文件多锚点时**按文件分组、组内降序应用**：先替换靠前的锚点会让后面锚点的
 *   偏移失效。本工具的 `no-gate` 就是两个文件各一个锚点，分组逻辑在下面通用地写着。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const F_MATTERS = "src/app/lib/server/services/matters.ts";
const F_ROUTE_MATTERS = "src/app/api/matters/export/route.ts";
const F_ROUTE_RISKS = "src/app/api/risk-matters/export/route.ts";
const BAK = (f) => `${f}.revred-listexport.bak`;

const DEFECTS = {
  "split-predicate": {
    mode: "split-predicate",
    file: F_MATTERS,
    tag: "split-predicate",
    // 锚点取"导出这一侧的那两行"：`mattersListWhere(actor, q)` 在 listMatters 里也有一处，
    // 所以必须连上下面那行（列表那侧是 `SORTABLE[q.sortBy ?? "updated_at"]`）才唯一。
    needle: `  const where = mattersListWhere(actor, q);
  const col = SORTABLE[q.sortBy];`,
    // 自己拼一套：丢掉 `archivedFilter`（归档二态）与 `missingMaterials`
    replacement: `  // 反向红（split-predicate）：导出自己拼一套谓词，漏掉归档二态
  const where = and(
    scopedWhere("matter", actor),
    q.status ? eq(matter.status, q.status) : undefined,
    keywordFilter("matter", q.keyword),
  );
  const col = SORTABLE[q.sortBy];`,
  },
  "no-gate-matters": {
    mode: "no-gate",
    file: F_ROUTE_MATTERS,
    tag: "no-gate-matters",
    needle: `    if (q.data.plain) {
      const denied = requirePrivilege(actor, "canReadPlain", "明文导出");
      if (denied) return denied;
    }`,
    // `void` 只为保住 import（`noUnusedLocals: true`，否则红的是编译错误而不是断言）
    replacement: `    // 反向红（no-gate）：明文导出不再判特权
    void requirePrivilege;`,
  },
  "no-gate-risks": {
    mode: "no-gate",
    file: F_ROUTE_RISKS,
    tag: "no-gate-risks",
    needle: `    if (q.data.plain) {
      const denied = requirePrivilege(actor, "canReadPlain", "明文导出");
      if (denied) return denied;
    }`,
    replacement: `    // 反向红（no-gate）：明文导出不再判特权
    void requirePrivilege;`,
  },
};

const ALL_FILES = [F_MATTERS, F_ROUTE_MATTERS, F_ROUTE_RISKS];
const mode = process.argv[2];
const doRestore = process.argv[3] === "restore" || mode === "restore";

if (doRestore) {
  let n = 0;
  for (const f of ALL_FILES) {
    if (existsSync(BAK(f))) {
      writeFileSync(f, readFileSync(BAK(f), "utf8"), "utf8");
      unlinkSync(BAK(f));
      n++;
    }
  }
  console.log(n ? `已还原 ${n} 个文件（来自备份），并删除备份` : "没有备份可还原");
  process.exit(0);
}

const entries = Object.values(DEFECTS).filter((d) => d.mode === mode);
if (!entries.length) {
  console.error(
    "用法：node agent-work/revred-list-export.mjs <split-predicate|no-gate> [restore]",
  );
  process.exit(2);
}

/** 同一文件多锚点：先全量校验命中 1 次，再按偏移**降序**替换 */
const byFile = new Map();
for (const e of entries) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

for (const [file, group] of byFile) {
  // 已存在备份 ⇒ 上一次注入还没还原。再注入会把"已注入版"备份成"干净版"，
  // 之后 restore 还原的是缺陷版（revred-archive 踩过）。宁可拒绝。
  if (existsSync(BAK(file))) {
    console.error(
      `已存在备份 ${BAK(file)} —— 上一次注入还没还原。先跑 \`node agent-work/revred-list-export.mjs restore\`。`,
    );
    process.exit(2);
  }
  const src = readFileSync(file, "utf8");
  const ordered = group
    .map((e) => ({ e, at: src.indexOf(e.needle) }))
    .sort((a, b) => b.at - a.at);
  for (const { e, at } of ordered) {
    const hits = src.split(e.needle).length - 1;
    if (at < 0 || hits !== 1) {
      console.error(
        `${e.tag}：锚点在 ${file} 命中 ${hits} 次（要恰好 1）—— 注入点已腐，请对照当前实现改本脚本。`,
      );
      process.exit(2);
    }
  }
  writeFileSync(BAK(file), src, "utf8");
  let out = src;
  for (const { e, at } of ordered) {
    out = out.slice(0, at) + e.replacement + out.slice(at + e.needle.length);
  }
  writeFileSync(file, out, "utf8");
  console.log(`已注入 [${mode}] → ${file}（${group.map((e) => e.tag).join("、")}）`);
}

console.log(
  `还原：node agent-work/revred-list-export.mjs restore   ← 别用 git checkout（会丢未提交的改动）\n` +
    `期望红：见本文件顶部这两个模式的清单（离线 vitest + agent-work/smoke-list-export.mjs）`,
);

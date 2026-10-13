/**
 * 反向红工具（**多模式**）：把批量导入的十一条口径逐条拆掉，看冒烟是不是真的在盯它。
 *
 * ## 用法（顺序不能反，本仓纪律：**没有反向红的冒烟等于没有冒烟**）
 *
 *   node agent-work/revred-import.mjs <mode>          # 注入
 *   node --env-file=.env agent-work/smoke-import.mjs  # ⇒ 必须红
 *   node agent-work/revred-import.mjs restore         # 还原
 *   node --env-file=.env agent-work/smoke-import.mjs  # ⇒ 必须绿
 *
 * 不带 mode 跑 `node agent-work/revred-import.mjs` 会列出全部模式与各自期望变红的断言。
 *
 * ## 十一种模式（每条对应票面一条 AC 或一条被写进实现的判断）
 *
 * | mode | 注入的缺陷 | 期望变红的断言 |
 * |---|---|---|
 * | `tpl-deprecated` | 模板的「来源」列收回**作废值** `customer_complaint` | 说明行不含「客户投诉」 |
 * | `l1-open` | `canImport` 恒真（L1 门被摘掉） | L2/L3/报告/批次四条 403 |
 * | `bulk-only` | 坏行改成丢弃整批（全有全无，Q42=A 的反面） | 事项导入 3/8/11 那一组 |
 * | `idempotent-off` | 跨批次内容查重查一个恒不命中的键 | 同文件重导一行都不新增 |
 * | `dupinfile-off` | 文件内重复检查摘掉 | 当事人 3 进 5 不进（变成 4 进 4 不进） |
 * | `amount-number` | 金额归一改成走 `Number()` | 18 位有效数字不丢分 |
 * | `owner-fallback` | 案件处理人缺省回落操作人 | 缺处理人 → required |
 * | `no-bulk-audit` | 汇总日志的动作名换掉 | 恰好一条 `BULK_IMPORT` |
 * | `bulk-payload` | 载荷键 `host_type` 改名 | 载荷五键与 §3.5 逐字一致 |
 * | `identity-off` | 计数不再自洽（跳过不计入 error_rows） | `total = imported + error` 恒等式当场抛 |
 * | `label-raw` | 报告的字段列退回内部键名 | 报告字段列是中文列名 |
 *
 * ## 四条踩过的规矩（与 `revred-notifications.mjs` 同源）
 *
 * ⚠ **还原一律用 `restore`，不要用 `git checkout`**（工作树里常年有别的 agent 的**未提交**
 *   改动 —— 本轮就有：MATT-43 的自动化规则正在同一棵树里改 `shared/enums/index.ts`）。
 * ⚠ **备份路径必须带本工具的名字**：曾与别的 revred 工具撞过同一个 `.bak`，
 *   两边同时注入时一方把另一方的注入提前还原 ⇒ **一次假绿**。
 * ⚠ **已存在备份时拒绝注入**：否则第二次注入会把"已注入版"当成干净版备份下来。
 * ⚠ **同一文件多锚点时按文件分组、组内降序应用**（T4 的工具栽在这里：第二个锚点把第一个
 *   的注入整段抹掉，脚本照样打印"已注入"，而那条断言**从未被钉过**）。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const F_SHARED = "src/shared/schema/import.ts";
const F_SVC = "src/app/lib/server/services/import.ts";
const F_GUARDS = "src/app/lib/server/scope/guards.ts";

/**
 * 一个条目 = 一处替换。`mode` 把条目归回同一个注入批次；
 * 同一文件多个条目由下面的分组逻辑处理（见文件头第 4 条规矩）。
 */
const ANCHORS = {
  "tpl-deprecated": {
    mode: "tpl-deprecated",
    file: F_SHARED,
    tag: "tpl-deprecated",
    needle: `      writable: RISK_MATTER_SOURCES_WRITABLE,`,
    replacement: `      writable: RISK_MATTER_SOURCES,`,
  },
  "l1-open": {
    mode: "l1-open",
    file: F_GUARDS,
    tag: "l1-open",
    needle: `  return actor.dataScope === ("all" satisfies DataScope);`,
    replacement: `  void actor;\n  return true;`,
  },
  "bulk-only": {
    mode: "bulk-only",
    file: F_SVC,
    tag: "bulk-only",
    needle: `    if (!built.ok) {
      await writeRow(batchId, kind, row.rowNo, null, "skipped", null, built.issues);
      skipRow(row.rowNo, built.issues);
      continue;
    }`,
    replacement: `    if (!built.ok) {
      throw new ImportFileError({ code: "bad_header", message: "反向红：整批拒收" });
    }`,
  },
  "idempotent-off": {
    mode: "idempotent-off",
    file: F_SVC,
    tag: "idempotent-off",
    // 换成一个**恒不命中**的键，而不是 `null`：后者会让下面的 `prior.rowNo` 变成类型错误
    needle: `    const prior = await findImportedByHash(kind, hash);`,
    replacement: `    const prior = await findImportedByHash(kind, "0".repeat(64));`,
  },
  "dupinfile-off": {
    mode: "dupinfile-off",
    file: F_SVC,
    tag: "dupinfile-off",
    needle: `    const earlier = seenInRun.get(hash);`,
    replacement: `    const earlier = seenInRun.get(hash + "-反向红");`,
  },
  "amount-number": {
    mode: "amount-number",
    file: F_SHARED,
    tag: "amount-number",
    /**
     * 锚点锚在**精度守卫那一行本身**（`normalizeAmount` 的正则），不是它上面那行通用守卫。
     *
     * 理由（MATT-44 的检查子代理提出，父代理采纳）：这条模式要模拟的失败是
     * 「金额归一走了 `Number()`，18 位有效数字静默丢分」，而**挡住它的就是这行正则**。
     * 锚它 ⇒ 注入直接作用在"守的是什么"上；锚上一行 ⇒ 注入是在守卫**之前**插一个早退，
     * 验的是"绕过守卫会红"，而不是"守卫本身在挡"。
     *
     * ⚠ 这行**含 `\d`**，所以它也是 `verify-anchors.mjs` 那条修复（提交 `2a2af02`）的
     * **活依赖**：那个工具原先不还原 `\\`，含正则的锚点会恒报"命中 0 次"（假红），
     * 而当时的应对是"把锚点改成无反斜杠的形态"——**被工具缺陷赶着改写法**。
     * 工具修好后，这里搬回正则行；若哪天预检又对它报假红，说明那个缺陷回来了。
     */
    needle: `  if (!/^\\d+(\\.\\d{1,2})?$/.test(s)) return null;`,
    replacement: `  if (!/^\\d+(\\.\\d{1,2})?$/.test(s)) return null;
  return String(Number(s));`,
  },
  /**
   * ⚠ 这个模式**必须三处一起摘**，而且第一版只摘了一处、跑出来是**绿的**。
   *
   * 三条都写着"案件的处理人必填"，各自都能独立挡住空值：
   *   ① 模板列元数据 `required: true`（决定表头星号与"缺列就拒整份文件"）；
   *   ② 逐行构建器里那句显式的 `r.text("ownerId", true)`；
   *   ③ 服务层 `createRecord` 的 guard（防 `createMatter` 回落到操作人）。
   *
   * 冗余本身是好事（任一处被改坏还有另外两处），但它同时意味着
   * **只摘一处测不出行为变化** —— 那次绿是"这条断言还没被验过"的假象。
   * 反向红要验的是**行为**（空处理人的案件行不进库、也不挂到操作人头上），
   * 所以三处一起摘；红出来的断言才真正对应票面那条口径。
   */
  "owner-fallback-template": {
    mode: "owner-fallback",
    file: F_SHARED,
    tag: "owner-fallback-template",
    needle: `      required: true,
      kind: "user",
      hint: "案件必须有处理人，填账号或姓名",`,
    replacement: `      required: false,
      kind: "user",
      hint: "案件必须有处理人，填账号或姓名",`,
  },
  "owner-fallback-builder": {
    mode: "owner-fallback",
    file: F_SHARED,
    tag: "owner-fallback-builder",
    needle: `  if (kind === "matter") r.text("ownerId", true);`,
    replacement: `  if (kind === "matter") r.text("ownerId");`,
  },
  "owner-fallback-guard": {
    mode: "owner-fallback",
    file: F_SVC,
    tag: "owner-fallback-guard",
    needle: `      if (!s(data.ownerId)) {
        return {
          ok: false,
          issue: { field: "处理人", code: "required", message: "案件必须填处理人，这一行没填" },
        };
      }`,
    replacement: `      // 反向红：案件处理人缺省回落操作人（历史案件全挂到导数据的人头上）`,
  },
  "no-bulk-audit": {
    mode: "no-bulk-audit",
    file: F_SVC,
    tag: "no-bulk-audit",
    needle: `      action: "BULK_IMPORT",`,
    replacement: `      action: "RISK_UPDATED",`,
  },
  "bulk-payload": {
    mode: "bulk-payload",
    file: F_SVC,
    tag: "bulk-payload",
    needle: `    host_type: p.hostType,`,
    replacement: `    host_kind: p.hostType,`,
  },
  "identity-off": {
    mode: "identity-off",
    file: F_SVC,
    tag: "identity-off",
    needle: `    errorRows += 1;
    if (replay) alreadyImportedRows += 1;`,
    replacement: `    if (replay) alreadyImportedRows += 1;`,
  },
  "label-raw": {
    mode: "label-raw",
    file: F_SVC,
    tag: "label-raw",
    // 锚点是 prettier 排版后的形态（单行）—— 排版变了这里就会在预检里红，正是想要的
    needle: `    issues: rowIssues && rowIssues.length > 0 ? labelIssues(hostType, rowIssues) : null,`,
    replacement: `    issues: rowIssues && rowIssues.length > 0 ? rowIssues : null,`,
  },
};

const modes = [...new Set(Object.values(ANCHORS).map((a) => a.mode))];
const mode = process.argv[2] ?? "";

if (mode === "" || mode === "list") {
  console.log("可用模式（用法：node agent-work/revred-import.mjs <mode>）：\n");
  for (const m of modes) {
    const entries = Object.values(ANCHORS).filter((a) => a.mode === m);
    console.log(`  ${m}`);
    for (const e of entries) console.log(`      · ${e.file}  (${e.tag})`);
  }
  console.log("\n还原：node agent-work/revred-import.mjs restore   ← 别用 git checkout");
  process.exit(0);
}

const backupOf = (file) => `${file}.revred-import.bak`;

if (mode === "restore") {
  let restored = 0;
  for (const file of new Set(Object.values(ANCHORS).map((a) => a.file))) {
    const bak = backupOf(file);
    if (!existsSync(bak)) continue;
    writeFileSync(file, readFileSync(bak, "utf8"), "utf8");
    unlinkSync(bak);
    console.log(`已还原 ${file}（来自备份），并删除备份`);
    restored++;
  }
  if (restored === 0) {
    console.error("没有备份可还原 —— 要么本来就没注入，要么备份被别的工具删了");
    process.exit(2);
  }
  process.exit(0);
}

if (!modes.includes(mode)) {
  console.error(`未知模式 ${mode}。可用：${modes.join(" / ")}`);
  process.exit(2);
}

const entries = Object.values(ANCHORS).filter((a) => a.mode === mode);
const files = [...new Set(entries.map((e) => e.file))];

// 已存在备份 ⇒ 上一次注入还没还原。再注入会把"已注入版"备份成"干净版"。
for (const f of files) {
  if (existsSync(backupOf(f))) {
    console.error(
      `已存在备份 ${backupOf(f)} —— 上一次注入还没还原。\n` +
        `先跑 \`node agent-work/revred-import.mjs restore\`，再注入。`,
    );
    process.exit(2);
  }
}

// 先全部校验命中次数，一处不合格就整体不动（免得留下半注入状态）
const plan = [];
for (const e of entries) {
  const src = readFileSync(e.file, "utf8");
  const hits = src.split(e.needle).length - 1;
  if (hits !== 1) {
    console.error(
      `锚点 ${e.tag} 在 ${e.file} 命中 ${hits} 次（要恰好 1）—— 注入点失效，请对照当前实现改本脚本。`,
    );
    process.exit(2);
  }
  plan.push({ ...e, at: src.indexOf(e.needle) });
}

for (const f of files) writeFileSync(backupOf(f), readFileSync(f, "utf8"), "utf8");

/** ⚠ 按文件分组、组内**降序**应用：一个文件只写一次，且从后往前改（见文件头第 4 条规矩） */
const byFile = new Map();
for (const p of plan) {
  if (!byFile.has(p.file)) byFile.set(p.file, []);
  byFile.get(p.file).push(p);
}
for (const [file, items] of byFile) {
  let buf = readFileSync(file, "utf8");
  for (const p of [...items].sort((a, b) => b.at - a.at)) {
    const at = buf.indexOf(p.needle);
    if (at < 0) {
      console.error(`注入 ${p.tag} 时在缓冲区里找不到锚点 —— 中止（备份还在，用 restore 还原）`);
      process.exit(2);
    }
    buf = buf.slice(0, at) + p.replacement + buf.slice(at + p.needle.length);
    console.log(`已注入 ${p.tag} → ${file}`);
  }
  writeFileSync(file, buf, "utf8");
}
// 自查：每条替换都必须在盘上出现，否则"已注入"是假的（T4 那个缺陷正是这么骗人的）
for (const p of plan) {
  const onDisk = readFileSync(p.file, "utf8");
  if (!onDisk.includes(p.replacement)) {
    console.error(`⚠ ${p.tag} 的替换没出现在盘上 —— 注入无效，请查本脚本的分组逻辑`);
    process.exit(2);
  }
}
console.log(
  `\n模式 ${mode} 注入完成（${plan.length} 处）。\n` +
    `  跑冒烟：node --env-file=.env agent-work/smoke-import.mjs   ⇒ 必须红\n` +
    `  还原：  node agent-work/revred-import.mjs restore          ← 别用 git checkout（会丢未提交的改动）`,
);

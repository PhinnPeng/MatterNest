/**
 * 反向红工具（多模式）：把 MATT-47 的**五条口径**各自拆掉一次，跑完再还原。
 *
 * 本仓纪律：**没有反向红的冒烟等于没有冒烟**。一条断言只有在"人为制造缺陷时它真的会红"
 * 之后才算数 —— 否则它可能只是在描述实现（`expect(true).toBe(true)` 那种形态）。
 *
 * ## 五个模式（每个只注入一处，互不重叠）
 *
 *   · `unconvert` —— 拆掉**撤销转案件前置**里的费用那一条（`risks.ts`）。
 *     期望红：案件有费用 → 撤销被拒（422 blocked 点名「费用」）。
 *     ⚠ 会连带红两条：被拒之后关联仍在、软删的费用不再挡撤销（第一次撤销成功了，
 *     链路状态与断言的前提不同了）。连带红本身也是证据：它说明那条前置真的在挡事。
 *   · `sum`       —— 把合计的出口从 `::numeric(18,2)::text` 换成 `::float8::text`
 *     （`expenses.ts`）。期望红：`0.10 + 0.20` 从 `"0.30"` 变成 `"0.3"`、
 *     空列表的 `"0.00"` 变成 `"0"`。**这就是"禁 float"那条断言在盯的东西。**
 *   · `plain-gate` —— 拆掉案件侧明文导出的 `can_read_plain` 门
 *     （`api/matters/[id]/export/route.ts`）。期望红：无特权者调明文导出拿到 200 而不是 403。
 *   · `mask`      —— 让脱敏档直接回明文（`exports.ts` 的 `twoTier`）。
 *     期望红：脱敏档里出现完整证件号（两处：案件侧与事项侧）。
 *   · `payload`   —— 从 `EXPORT` 载荷里去掉 `count`（`exports.ts`）。
 *     期望红：载荷形状断言（五键）与"不含行内容"那条（键集合恰好是那五个）。
 *
 * ## 用法（顺序不能反）
 *
 *   node agent-work/revred-expenses.mjs inject sum
 *   node --env-file=.env agent-work/smoke-expenses.mjs      # ⇒ 必须红，且只红上面点名的那几条
 *   node agent-work/revred-expenses.mjs restore             # 还原**全部**已注入的模式
 *   node --env-file=.env agent-work/smoke-expenses.mjs      # ⇒ 必须全绿
 *
 * 也可以一次注入多个模式再一起跑（`inject unconvert sum`），红的就是它们的并集。
 *
 * ⚠ **还原一律用 `restore`，不要用 `git checkout`**：本仓工作树里常年有**未提交**的改动
 *   （并行 agent 的产出），`git checkout` 会把它们一起丢掉。备份文件才是唯一权威。
 *
 * ⚠ **备份路径带本工具名 + 模式名**（`<file>.revred-expenses-<mode>.bak`）：
 *   曾与别的 revred 工具撞过同一个 `.revred.bak`，两边同时注入时一方把另一方的注入
 *   提前还原 ⇒ **一次假绿**。并且**已存在备份时拒绝注入**（否则第二次注入会把
 *   "已注入版"当成干净版备份下来，之后 restore 还原的是缺陷版）。
 *
 * 为什么用 Node 做替换而不是在 PowerShell 里：PowerShell 的反引号是转义符，
 * `sql\`${...}\`` 这种串会被吃掉、替换静默不命中；`Set-Content` 还会把 UTF-8 的中文
 * 写成别的编码（本工具第一版就是这么被写坏的 —— 注入没生效、冒烟却全绿，一次假绿）。
 * 「反向红不生效」比「没有反向红」更危险：它给出一个绿的假证据。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const F_RISKS = "src/app/lib/server/services/risks.ts";
const F_EXPENSES = "src/app/lib/server/services/expenses.ts";
const F_EXPORTS = "src/app/lib/server/services/exports.ts";
const F_MATTER_EXPORT = "src/app/api/matters/[id]/export/route.ts";

const MODES = {
  "unconvert": {
    tag: "unconvert-expense-blocker",
    file: F_RISKS,
    needle: `  if (await hasMatterExpenses(db, BigInt(caseId))) blockers.push("expenses");`,
    replacement: `  // 反向红注入：费用前置被拆掉（判定结果不再进 blockers）
  void hasMatterExpenses;`,
    expect: "「案件有费用 → 撤销被拒」红（并连带两条：关联仍在 / 软删后放行）",
  },
  "sum": {
    tag: "sum-float-out",
    file: F_EXPENSES,
    needle: `      sum: sql<string>\`coalesce(sum(\${t}.amount), 0)::numeric(18,2)::text\`,
      n: sql<number>\`count(*)::int\`,
    })
    .from(t)
    .where(where);`,
    replacement: `      sum: sql<string>\`coalesce(sum(\${t}.amount), 0)::float8::text\`,
      n: sql<number>\`count(*)::int\`,
    })
    .from(t)
    .where(where);`,
    expect: "「合计 0.10+0.20 = 0.30」红（变成 0.3）、「空列表合计 0.00」红（变成 0）",
  },
  "plain-gate": {
    tag: "plain-privilege-gate",
    file: F_MATTER_EXPORT,
    needle: `    if (q.data.plain) {
      const denied = requirePrivilege(actor, "canReadPlain", "明文导出");
      if (denied) return denied;
    }`,
    replacement: `    // 反向红注入：明文导出的特权门被拆掉
    void requirePrivilege;`,
    expect: "「无 can_read_plain 者调明文导出 → 403」红（拿到 200）",
  },
  "mask": {
    tag: "masked-tier-plain",
    file: F_EXPORTS,
    needle: `  const twoTier = (v: string | null) =>
    opts.plain ? (decryptField(v) ?? "") : maskValue(decryptField(v));`,
    replacement: `  // 反向红注入：脱敏档直接回明文
  const twoTier = (v: string | null) => decryptField(v) ?? "";`,
    expect: "「默认档是脱敏档」红 + 事项侧脱敏档红（两处都出现完整证件号）",
  },
  "payload": {
    tag: "export-payload-shape",
    file: F_EXPORTS,
    needle: `      payload: exportAuditPayload({
        targetType: host,
        scope: \`\${host}_file\`,
        rows,
        count: 1,
        plain: opts.plain,
      }),`,
    replacement: `      payload: exportAuditPayload({
        targetType: host,
        scope: \`\${host}_file\`,
        rows,
        plain: opts.plain,
      }),`,
    expect: "「两档都写 EXPORT（五键）」红 + 「载荷不含行内容（键集合恰好五个）」红",
  },
};

const args = process.argv.slice(2);
const cmd = args[0] ?? "inject";
const backupOf = (mode) => `${MODES[mode].file}.revred-expenses-${mode}.bak`;

/** 还原全部已注入的模式（备份文件还在 = 注入还没还原） */
function restoreAll() {
  let n = 0;
  for (const mode of Object.keys(MODES)) {
    const bak = backupOf(mode);
    if (!existsSync(bak)) continue;
    writeFileSync(MODES[mode].file, readFileSync(bak, "utf8"), "utf8");
    unlinkSync(bak);
    console.log(`已还原 ${MODES[mode].file}（模式 ${mode}）`);
    n++;
  }
  if (n === 0) {
    console.error("没有任何备份可还原 —— 要么本来就没注入，要么备份被别的工具删了");
    process.exit(2);
  }
  console.log(`共还原 ${n} 处。`);
}

if (cmd === "restore") {
  restoreAll();
  process.exit(0);
}

if (cmd !== "inject") {
  console.error(`未知命令 ${cmd}（只有 inject / restore）`);
  process.exit(2);
}

const picked = args.slice(1);
if (picked.length === 0) {
  console.error(
    `要指定模式：${Object.keys(MODES).join(" / ")}\n` +
      `用法：node agent-work/revred-expenses.mjs inject <mode> [mode…]`,
  );
  process.exit(2);
}
for (const mode of picked) {
  if (!MODES[mode]) {
    console.error(`未知模式 ${mode}（只有 ${Object.keys(MODES).join(" / ")}）`);
    process.exit(2);
  }
}

/** 先全部校验，再逐个写盘：任何一条锚点不合格就整体不动（半个注入最难收拾） */
const plan = [];
for (const mode of picked) {
  const m = MODES[mode];
  const bak = backupOf(mode);
  if (existsSync(bak)) {
    console.error(
      `已存在备份 ${bak} —— 模式 ${mode} 上一次注入还没还原。\n` +
        `先跑 \`node agent-work/revred-expenses.mjs restore\`，再注入。`,
    );
    process.exit(2);
  }
  const src = readFileSync(m.file, "utf8");
  const hits = src.split(m.needle).length - 1;
  if (hits !== 1) {
    console.error(
      `模式 ${mode}：锚点在 ${m.file} 里命中 ${hits} 次（要恰好 1）—— 注入点已腐，请对照当前实现改本脚本。`,
    );
    process.exit(2);
  }
  plan.push({ mode, m, src, bak });
}

for (const { mode, m, src, bak } of plan) {
  writeFileSync(bak, src, "utf8");
  writeFileSync(m.file, src.replace(m.needle, m.replacement), "utf8");
  console.log(`已注入缺陷 [${mode}] → ${m.file}`);
  console.log(`  期望红：${m.expect}`);
}
console.log(
  `\n下一步：node --env-file=.env agent-work/smoke-expenses.mjs   # ⇒ 必须红\n` +
    `还原：node agent-work/revred-expenses.mjs restore   ← 别用 git checkout（会丢未提交的改动）`,
);

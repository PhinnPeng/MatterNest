/**
 * 反向红工具（规则 1 结案自动归档，MATT-72 阻塞 1）。
 *
 * 用法：node agent-work/revred-rule1.mjs <no-flags|no-log|always> [restore]
 *
 * 三个模式各摘掉**一段接线**，逐个证明 `smoke-rule1-auto-archive.mjs` 的断言真的钉住了它。
 * 三段都能在"功能看着正常"的前提下静默失效 —— 尤其是前两个：页面照旧、接口照旧、
 * 单测照旧，只有真打 HTTP、真读库才看得见。
 *
 *  · `no-flags` —— 把归档写里的 `archiving: true` 改成 `false`（写状态但不落归档标志）。
 *    期望红：**2 条** —— ②的 `**B 真的被自动归档了**` 与 `\`archived_at\` 落下来了`。
 *    **为什么必须红这条**：这是本票的判据本身。而它若失效，接口仍回 200、
 *    `STATUS_CHANGED` 审计仍在、列表也看不出异常 —— 只有 `is_archived` 那一列不同，
 *    而没有任何界面元素会因为"这条案件没被归档"而报错。审计里的系统行反而**照样落**
 *    （③ 全绿），这正是要证明"②与③是两条独立的判据、不能互相顶替"。
 *
 *  · `no-log` —— 摘掉 `logSystemActivity` 那次调用（归档照做，系统审计不落）。
 *    期望红：**6 条**（2026-10-19 实测）—— ③ 的 5 条
 *    （`B 上有且只有一条 ARCHIVED 行`、`**那条 ARCHIVED 的 \`operator_id\` 是 NULL**`、
 *    payload 与 reason 两条、完备性那条）＋ ④ 的
 *    `**详情页里那条系统动作的 \`operator\` 是 null**`（读侧断言也靠这行存在）。
 *    ② 全绿。
 *    ⚠ **⑤ 那条 `C 上只有一条 ARCHIVED 行` 不会红**：C 走的是**人工**归档，
 *    落的是 `changeStatus` 里的 `logActivity`（`operator_id` = 那个人），
 *    与本次摘掉的 `logSystemActivity` 是两条独立的路 —— 这恰好证明了它们确实独立。
 *    **为什么必须红这条**：系统动作不落审计 = "谁把这条案件归档的"在库里查不到，
 *    而案件**确实被归档了**（状态是对的）。这种"做对了但没留痕"的错误，
 *    任何以终态为判据的测试都看不见。
 *
 *  · `always` —— 摘掉规则门（`shouldAutoArchive` 早退），规则关着也照归档。
 *    期望红：**2 条** —— ①的 `**A 没有被自动归档**` 与 `**A 上没有任何 ARCHIVED 行**`。
 *    **为什么必须红这条**：它是"规则 1 的开关是真的"这个结论的唯一支点。
 *    没有这条注入，①那两条关态断言可能**空过**（A 压根没走到归档分支，
 *    与"规则门挡住了"长得一样）—— 关态对照只有在"摘掉门就会红"时才成立。
 *
 * ⚠ 还原后别立刻跑冒烟：`next dev` 热更新有窗口（revred-convert 那轮踩过：
 *   还原后 5 秒跑出假红）。判定还原成功看第二次跑。
 * ⚠ 注入之后先跑 `node agent-work/revred-gate.mjs`（编译门）：本工具的三个注入都是
 *   语义级的、编译干净的，若它报编译红，说明锚点落错了地方。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F_AA = "src/app/lib/server/services/auto-archive.ts";
const BAK = `${F_AA}.revred.bak`;
const mode = process.argv[2];

if (mode === "restore" || process.argv[3] === "restore") {
  if (existsSync(BAK)) {
    writeFileSync(F_AA, readFileSync(BAK, "utf8"), "utf8");
    unlinkSync(BAK);
    console.log(`已还原 ${F_AA}`);
  } else {
    console.log("没有备份可还原");
  }
  process.exit(0);
}

const NEEDLES = {
  "no-flags": {
    file: F_AA,
    // ⚠ 锚点**不能含反引号**：本文件（以及锚点预检的抽取正则）按模板串读 needle，
    //   而 auto-archive.ts 的注释里满是 `code` 形态的反引号。取一段无注释、无反引号的代码。
    needle: `    archiving: true,
    now: args.now,`,
    replacement: `    archiving: false, // 反向红：写状态但不落归档标志（is_archived 不翻）
    now: args.now,`,
    tag: "no-archive-flags",
  },
  "no-log": {
    file: F_AA,
    needle: `  await logSystemActivity(tx, {
    matterId: args.hostId,`,
    // 用 `if (false)` 包住原调用而不是删掉：① 编译干净（不留未使用变量的红）；
    // ② 锚点只需覆盖前两行，不必把含反引号 reason 的整块抄进来。
    replacement: `  void logSystemActivity; // 反向红：系统审计不落（归档照做，查不到是谁干的）
  void readiness;
  if (false)
    await logSystemActivity(tx, {
      matterId: args.hostId,`,
    tag: "no-system-log",
  },
  "always": {
    file: F_AA,
    needle: `  if (
    !shouldAutoArchive(rule, {
      host: "matter",
      toStatusCode: args.toStatusCode,
    })
  ) {
    return { archived: false, reason: rule ? "not_hit" : "rule_missing" };
  }`,
    replacement: `  // 反向红：规则门被摘掉 —— 规则关着也照归档（"开关是真的"失去支点）
  if (false) {
    return { archived: false, reason: rule ? "not_hit" : "rule_missing" };
  }`,
    tag: "no-rule-gate",
  },
};

const entry = NEEDLES[mode];
if (!entry) {
  console.error(`未知模式：${mode ?? "(空)"}\n可用：${Object.keys(NEEDLES).join(" | ")} | restore`);
  process.exit(2);
}

const src = readFileSync(entry.file, "utf8");
const hits = src.split(entry.needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}

writeFileSync(BAK, src, "utf8");
writeFileSync(entry.file, src.replace(entry.needle, entry.replacement), "utf8");
console.log(`已注入缺陷 [${entry.tag}] → ${entry.file}（备份 ${BAK}）`);

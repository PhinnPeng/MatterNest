/**
 * 反向红工具（MATT-42 归档完备性 / F2-26）。
 *
 * 用法：node --env-file=.env agent-work/revred-archive.mjs <no-missing|no-filter|no-closing> [restore]
 *
 *  · `no-missing` —— 让 `missing` 恒为空数组（摘掉"判为缺"的那一步）。
 *    期望红：**4 条**（实测）——`缺项清单随 ARCHIVED 落库`、`第②项判缺`、`第③项判缺`、
 *    `missing 与 unavailable 分开列出`。它们是同一功能内的因果链：判缺那一步没了，
 *    所有"应当判缺"的断言一起红——**这里的连带红是正确信号**，不是噪声。
 *    **为什么必须红**：`missing_at_archive` 是 G4 指标"归档材料完整率"的唯一数据源。
 *    它恒空 = 指标恒 100%，而界面上一切正常（卡还是红的、清单还是列出来的）——
 *    只有审计里那份清单是假的。
 *
 *  · `no-closing` —— 让"目标语义是 closed"那一句恒假（不再写 `closing_date`）。
 *    期望红：**7 条**（实测，含连带）——首红是 `closing_date 自动写入`，
 *    随后是依赖"齐备案件"的几条（第②项、ready、归档后日期仍在…）。
 *    **为什么必须红**：这一列此前**没有任何路径能写**，于是第②项恒判缺、
 *    详情页「已结案」标记永不出现。它属于"声明了效果但没实现"——
 *    声明在 `shared/enums/status.ts` 里，是可读的承诺，不该靠人记得。
 *
 *  · `no-filter` —— 摘掉列表谓词里的两个判据（结案日期 / 未决节点）。
 *    期望红：**恰好 1 条** —— `**两出口一致：详情判齐备的案件，列表筛选找不到它**`。
 *    ⚠ 这条是**实测**的（初版文档写的是"详情判缺的案件，列表筛选找得到"那条，
 *    错了：谓词变成 `is_archived and true` 之后列表返回**全部**归档案件，
 *    所以"找得到 A"仍然绿，真正红的是"找不到 B"）。红错地方会让人以为验过了。
 *    **为什么必须红这条**：票面 AC 第一条就是"判定只实现一次，两个出口"。
 *    两个出口各写一份判定的漂移不会报错，只会让"列表说有缺、详情页说齐备"同时成立。
 *    这条断言是唯一能钉住它们一致的东西——而它现在**双向**都有（正交夹具 C/D 另钉子句级）。
 *
 *  · `no-closing` —— 让"目标语义是 closed"那一句恒假（不再写 `closing_date`）。
 *    期望红：**7 条**（实测，含连带）——首红是 `closing_date 自动写入`，
 *    随后是依赖"齐备案件"的几条（第②项、ready、归档后日期仍在…）。
 *    **为什么必须红**：这一列此前**没有任何路径能写**，于是第②项恒判缺、
 *    详情页「已结案」标记永不出现。它属于"声明了效果但没实现"——
 *    声明在 `shared/enums/status.ts` 里，是可读的承诺，不该靠人记得。
 *
 * ⚠ 还原后别立刻跑冒烟：`next dev` 热更新有窗口（revred-convert 那轮踩过）。
 *
 * ⚠ **备份路径必须与别的 revred 工具不同**。初版用 `matters.ts.revred.bak`，与
 * `revred-batch.mjs`（另一个 agent 写的，同一棵树）**逐字相同**：两边同时注入时，
 * 一方的 `restore` 会把另一方的注入提前还原并删掉备份 ⇒ **一次假绿**
 * （对方实测撞上过，我也在树里发现过"注入态残留"）。假绿比不验证更糟——
 * 它给的是"验过了"的错觉。所以后缀带上本工具的名字。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F_SVC = "src/app/lib/server/services/archive-readiness.ts";
const F_MATTERS = "src/app/lib/server/services/matters.ts";
// `resolveClosingDate` 2026-10-24 搬到 `matter-status-write.ts`（`status-change.ts` 要用它，
// 留在 `matters.ts` 会成环）。`no-closing` 这个模式的锚点跟着搬。
const F_STATUS_WRITE = "src/app/lib/server/services/matter-status-write.ts";
const BAK_SVC = `${F_SVC}.revred-archive.bak`;
const BAK_MATTERS = `${F_MATTERS}.revred-archive.bak`;
const BAK_STATUS_WRITE = `${F_STATUS_WRITE}.revred-archive.bak`;
const mode = process.argv[2];

if (mode === "restore" || process.argv[3] === "restore") {
  let n = 0;
  for (const [f, b] of [
    [F_SVC, BAK_SVC],
    [F_MATTERS, BAK_MATTERS],
    [F_STATUS_WRITE, BAK_STATUS_WRITE],
  ]) {
    if (existsSync(b)) {
      writeFileSync(f, readFileSync(b, "utf8"), "utf8");
      unlinkSync(b);
      n++;
    }
  }
  console.log(n ? `已还原 ${n} 个文件` : "没有备份可还原");
  process.exit(0);
}

const NEEDLES = {
  "no-missing": {
    file: F_SVC,
    needle: `  const missing = checks.filter((c) => c.state === "missing").map((c) => c.key);`,
    replacement: `  // 反向红：缺项恒空（G4 指标的唯一数据源变成恒 100%）
  const missing: ReadinessCheckKey[] = [];`,
    tag: "no-missing",
  },
  "no-filter": {
    file: F_SVC,
    needle: `    sql\`(
      \${matter.closingDate} is null
      or exists (
        select 1 from \${matterNode} n
        where n.matter_id = \${matter.id} and not n.is_deleted
          and \${inArray(sql\`n.status\`, [...NODE_OPEN_STATUSES])}
      )
    )\`,`,
    replacement: `    // 反向红：列表谓词不再判"缺什么"（与详情页那张卡的口径分叉）
    sql\`true\`,`,
    tag: "no-filter",
  },
  "no-closing": {
    file: F_STATUS_WRITE,
    // ⚠ 锚点只取"判断目标语义是不是 closed"那一句：它唯一、且不随注释与日期写法改字而腐。
    //   初版锚点框住了整个三目表达式（含注释），我在修 🔴 时一改注释它就匹配不到了——
    //   `verify-anchors.mjs` 当场抓到，所以没等到真跑才发现。
    //   **第二次改锚点**（MATT-69）：判定被抽成纯函数 `resolveClosingDate`，
    //   而那一行里的 `now.slice(0, 10)` 又被换成了 `businessDateKey(now)`——
    //   锚点连同它框住的表达式一起消失了（命中 0 次）。教训与初版同一条：
    //   **锚点只框住"要抽掉的那半句"，别框住它旁边的实现细节**。
    //   本仓已有先例：`revred-notifications` 的 `timezone` 锚在 `zh-cn.ts` 上，
    //   它同样只锚一个表达式、不带上下文。
    needle: `  if (targetSemantics === "closed") return currentClosingDate ?? businessDateKey(now);`,
    // `"__never__"` 恒假，但 TS 折不了（比 `false ?` 稳：后者可能被 lint 判为常量条件）
    replacement: `  if (targetSemantics === "__never__") return currentClosingDate ?? businessDateKey(now);`,
    tag: "no-closing",
  },
};

const spec = NEEDLES[mode];
if (!spec) {
  console.error(
    "用法：node --env-file=.env agent-work/revred-archive.mjs <no-missing|no-filter|no-closing> [restore]",
  );
  process.exit(2);
}

const bak = `${spec.file}.revred-archive.bak`;
const src = readFileSync(spec.file, "utf8");
const hits = src.split(spec.needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}
writeFileSync(bak, src, "utf8");
writeFileSync(spec.file, src.replace(spec.needle, spec.replacement), "utf8");
console.log(`已注入缺陷 [${spec.tag}] 到 ${spec.file}`);

/**
 * 反向红工具（MATT-42 归档完备性 / F2-26）。
 *
 * 用法：node --env-file=.env agent-work/revred-archive.mjs <no-missing|no-filter|no-closing> [restore]
 *
 *  · `no-missing` —— 让 `missing` 恒为空数组（摘掉"判为缺"的那一步）。
 *    期望红：`**缺项清单随 ARCHIVED 落库**` 与 `**齐备案件的 missing_at_archive 是空数组**`
 *    的**对照**关系塌掉——前者变空、后者仍空，于是"空数组 = 齐备"这句谎话成立。
 *    **为什么必须红这条**：`missing_at_archive` 是 G4 指标"归档材料完整率"的唯一数据源。
 *    它恒空 = 指标恒 100%，而界面上一切正常（卡还是红的、清单还是列出来的）——
 *    只有审计里那份清单是假的。
 *
 *  · `no-filter` —— 摘掉列表谓词里的两个判据（结案日期 / 未决节点）。
 *    期望红：`**两出口一致：详情判缺的案件，列表筛选找得到**`。
 *    **为什么必须红这条**：票面 AC 第一条就是"判定只实现一次，两个出口"。
 *    两个出口各写一份判定的漂移不会报错，只会让"列表说有缺、详情页说齐备"同时成立。
 *    这条断言是唯一能钉住它们一致的东西。
 *
 *  · `no-closing` —— 摘掉 `closing_date` 的自动写入。
 *    期望红：`**closing_date 自动写入**`（`SEMANTICS_RULES.closed.effect` 那句承诺）。
 *    **为什么必须红这条**：这一列此前**没有任何路径能写**，于是第②项恒判缺、
 *    详情页「已结案」标记永不出现。它属于"声明了效果但没实现"——
 *    声明在 `shared/enums/status.ts` 里，是可读的承诺，不该靠人记得。
 *
 * ⚠ 还原后别立刻跑冒烟：`next dev` 热更新有窗口（revred-convert 那轮踩过）。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F_SVC = "src/app/lib/server/services/archive-readiness.ts";
const F_MATTERS = "src/app/lib/server/services/matters.ts";
const BAK_SVC = `${F_SVC}.revred.bak`;
const BAK_MATTERS = `${F_MATTERS}.revred.bak`;
const mode = process.argv[2];

if (mode === "restore" || process.argv[3] === "restore") {
  let n = 0;
  for (const [f, b] of [
    [F_SVC, BAK_SVC],
    [F_MATTERS, BAK_MATTERS],
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
    needle: `    missing: checks.filter((c) => c.state === "missing").map((c) => c.key),`,
    replacement: `    // 反向红：缺项恒空（G4 指标的唯一数据源变成恒 100%）
    missing: [],`,
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
    file: F_MATTERS,
    needle: `    const closingDate = enteringClosed
      ? (cur.closingDate ?? now.slice(0, 10))
      : leavingClosed
        ? null
        : cur.closingDate;`,
    replacement: `    // 反向红：不写 closing_date（第②项恒判缺、"已结案"标记永不出现）
    void enteringClosed;
    void leavingClosed;
    const closingDate = cur.closingDate;`,
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

const bak = spec.file === F_SVC ? BAK_SVC : BAK_MATTERS;
const src = readFileSync(spec.file, "utf8");
const hits = src.split(spec.needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}
writeFileSync(bak, src, "utf8");
writeFileSync(spec.file, src.replace(spec.needle, spec.replacement), "utf8");
console.log(`已注入缺陷 [${spec.tag}] 到 ${spec.file}`);

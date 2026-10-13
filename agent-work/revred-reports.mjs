/**
 * 反向红工具（MATT-46 报表两卡 / F8-1 + F8-2）。
 *
 * 用法：node --env-file=.env agent-work/revred-reports.mjs <no-scope|no-archived|no-confirm|no-remind> [restore]
 *
 * 四个模式各摘掉**一条口径**，逐个证明 `smoke-reports.mjs` 里的断言真的钉住了它。
 * 没红过一遍的断言不算数：下面每一条都能在"功能看着正常"的前提下静默失效。
 *
 *  · `no-scope` —— 把 `scopeOf()` 里的范围谓词换成 `true`（**票面 AC 第 4 条**）。
 *    期望红（**7 条**，2026-10-13 形态改判那一轮实测；此前注释写 5 条是**旧的**脚本，
 *    那时还没有"L2 现在看得见这一条"与"与工作台的边界"两条）：
 *    `**L3 的报表是空的**`、`**L2 看不到别人的案件**`、`**L3 只看得见自己那条**`、
 *    `**L2 现在看得见这一条**`、`**L3 仍然看不见 A**`、`**与工作台的边界**`、
 *    `**L3 的节点卡只装自己那条**`。
 *    **为什么必须红这条**：报表没有"这一行"的概念，范围谓词漏了只会让数字变大、不会报错，
 *    界面上一切正常。而"报表要按可见行统计"正是本票存在的理由。
 *
 *  · `no-archived` —— 摘掉归档谓词（在办 / 已归档不再互斥）。
 *    期望红（**3 条**，实测）：`**归档视图里没有在办的行**`、
 *    `**在办视图 + 归档态筛选 ⇒ 一律 0**`、`**私有状态在归档视图里是空的**`。
 *    **为什么必须红这条**：归档是终态，混着看会让两张卡的数字与列表页对不上，
 *    而"混着看"与"二态"在只有一个归档案件时几乎看不出差别。
 *    ⚠ 断言只针对**本脚本自己的行**（私有状态/私有等级）：归档视图是共享的，
 *    别的流的冒烟会往里塞夹具（实测 `smoke-expenses` 直接 SQL 写 `is_archived=true` 而
 *    不动 `status`），所以"归档视图里只剩归档态的行"那种全量断言会假红。
 *
 *  · `no-confirm` —— 摘掉 `is_time_confirmed`（未确认时间的节点也算到期）。
 *    期望红（**3 条**，实测）：`**未确认时间的节点不进任何一档**`、
 *    `**九条夹具逐格对上夹具账**`、`**归档后从默认（在办）视图里消失**`。
 *    **为什么必须红这条**：这条纪律（只走带 `is_time_confirmed` 的 partial index 那一路）
 *    写在票面里，而违反它的表现是"临期数字偏大"——没有人会去核对那个数字。
 *
 *  · `no-remind` —— 把临期窗口从"节点自己的 `remind_days`"改成硬编码 7 天。
 *    期望红（**3 条**，实测）：`**同样还剩 5 天、但提醒档是 {3,1} → 算更远，不算临期**`、
 *    `**九条夹具逐格对上夹具账**`、`**与工作台的边界**`。
 *    **为什么必须红这条**：AC 第 1 条要求先定口径，而定的是"按节点提醒档"。
 *    硬编码 7 天在多数数据上给出同样的分档，只有"提醒档比 7 天窄"的节点才分得出来——
 *    那正是本仓"配置驱动"这条一贯做法的判据。
 *    ⚠ 注意 `{}` 空数组回落 7 天那两条断言**不会**红：硬编码 7 天与"空数组回落 7 天"
 *    在空档夹具上给出同一个答案——那正是"回落值写错成 30 天"才红得出来的地方。
 *
 * ⚠ 还原后别立刻跑冒烟：`next dev` 热更新有窗口（revred-convert 那轮踩过）。
 *   2026-10-13 又踩了一次：`restore` 后 5 秒就跑，头几条请求仍拿到注入态的模块
 *   （76 通过 / 4 失败），**再跑一次就全绿**。所以还原后的那次冒烟要当作"预热"，
 *   以紧跟其后的那一次为准。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const F = "src/app/lib/server/services/reports.ts";
const BAK = `${F}.revred.bak`;
const mode = process.argv[2];

if (mode === "restore" || process.argv[3] === "restore") {
  if (existsSync(BAK)) {
    writeFileSync(F, readFileSync(BAK, "utf8"), "utf8");
    unlinkSync(BAK);
    console.log(`已还原 ${F}`);
  } else {
    console.log("没有备份可还原");
  }
  process.exit(0);
}

const NEEDLES = {
  "no-scope": {
    needle: "  return scopedWhere(host, actor);",
    replacement: "  return sql`true`; // 反向红：范围谓词被摘掉（报表开始统计看不见的行）",
    why: "期望红：L2/L3 的可见性断言 —— 报表数字变大且不报错",
  },
  "no-archived": {
    needle: "  return archivedFilter(host, archivedOnly);",
    replacement: "  return sql`true`; // 反向红：归档谓词被摘掉（在办与已归档混着看）",
    why: "期望红：归档二态的两条断言 —— 归档行留在在办视图里",
  },
  "no-confirm": {
    needle: "    sql`${n.isTimeConfirmed}`,",
    replacement: "    sql`true`, // 反向红：未确认时间的节点也算进到期档",
    why: "期望红：未确认时间不进任何一档",
  },
  "no-remind": {
    // ⚠ 替换文本必须是**纯 SQL**：这个锚点在 sql 模板里，写 `// 注释` 会让整条查询语法错、
    // 报表直接 500——那是"把功能打挂"，不是"把口径改错"，反向红就失去意义了（本轮踩过一次）
    needle:
      "    when ${n.deadlineTime} < now() + make_interval(days => coalesce((select max(d) from unnest(${n.remindDays}) as t(d)), 7)) then 'soon'",
    replacement: "    when ${n.deadlineTime} < now() + interval '7 days' then 'soon'",
    why: "期望红：{3,1} 档的 5 天节点与工作台边界那两条断言",
  },
};

const spec = NEEDLES[mode];
if (!spec) {
  console.error(
    "用法：node --env-file=.env agent-work/revred-reports.mjs <no-scope|no-archived|no-confirm|no-remind> [restore]",
  );
  process.exit(2);
}

const src = readFileSync(F, "utf8");
const hits = src.split(spec.needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}
writeFileSync(BAK, src, "utf8");
writeFileSync(F, src.replace(spec.needle, spec.replacement), "utf8");
console.log(`已注入缺陷 [${mode}] 到 ${F}`);
console.log(spec.why);
console.log(`跑：node --env-file=.env agent-work/smoke-reports.mjs（先红）`);
console.log(`还原：node --env-file=.env agent-work/revred-reports.mjs restore`);

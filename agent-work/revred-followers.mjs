/**
 * 反向红工具（MATT-56 关注组）：拆掉 ADR-0003 那道**可见性门**，确认对应断言转红。
 *
 * 用法：node agent-work/revred-followers.mjs [restore]
 *
 * 注入的缺陷：把 `loadRiskForStaff` 里的调用方**一律当 L1**（`dataScope:"all"`）——
 * 可见性谓词恒不限制，"看不见这条记录的人也能把自己关注进去"，
 * 正是 ADR-0003 警告的那个洞（拿到/枚举到事项 id 即可自取读写）。
 *
 * 为什么不直接删 `scopedWhere(...)`：那会让 `actor` 参数悬空，tsc 的
 * `noUnusedParameters` 当场报错——**红的是编译不是断言**，那是假证据。
 * 这个形状保留 `actor` 引用、保留软删过滤，只把范围放开，编译干净。
 *
 * 认**缺陷**的签名：判据查的是注入标记**在不在**（照 revred-t1.mjs 的教训：
 * 判据要认缺陷的样貌，不是正确代码的样貌）。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F = "src/app/lib/server/services/risks.ts";
const BAK = `${F}.revred.bak`;
const restore = process.argv[2] === "restore";

if (restore) {
  if (!existsSync(BAK)) {
    console.error("没有备份可还原");
    process.exit(2);
  }
  writeFileSync(F, readFileSync(BAK, "utf8"), "utf8");
  unlinkSync(BAK);
  console.log("已还原");
  process.exit(0);
}

const src = readFileSync(F, "utf8");
// ⚠ 锚点必须唯一。`.where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(id))))`
//   这一行在 `getRiskMatter` 里也出现一次，裸 `.replace` 会命中**更早**那处（738 行），
//   拆错地方 ⇒ 假证据（第一轮就是这么"注入成功却全绿"的）。
//   用带 `return row ?? null;` 的三行块定位 loadRiskForStaff 那道门——那句只此一处。
const needle =
  '    .where(scopedWhere("risk_matter", actor, eq(riskMatter.id, BigInt(id))))\n' +
  "    .limit(1);\n" +
  "  return row ?? null;";
const replacement =
  '    .where(\n' +
  '      scopedWhere("risk_matter", { ...actor, dataScope: "all" }, eq(riskMatter.id, BigInt(id))),\n' +
  "    ) // 反向红：把每个调用方都当 L1 ⇒ 可见性门恒不限制\n" +
  "    .limit(1);\n" +
  "  return row ?? null;";
const hits = src.split(needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}
const out = src.replace(needle, replacement);
if (out === src) {
  console.error("未找到 loadRiskForStaff 的可见性门");
  process.exit(2);
}

writeFileSync(BAK, src, "utf8");
writeFileSync(F, out, "utf8");
console.log("已注入缺陷 [visibility-gate]，备份 " + BAK);

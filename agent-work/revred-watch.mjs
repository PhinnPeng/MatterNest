/**
 * 反向红工具（MATT-63 收藏 ⭐）：拆掉 `hostVisible` 那道**可见性门**，确认对应断言转红。
 *
 * 用法：node agent-work/revred-watch.mjs [restore]
 *
 * 注入的缺陷：让 `hostVisible` **恒返回 true** —— "看不见这条记录的人也能收藏它"，
 * 正是范围谓词门要防的那个洞（拿到/枚举到宿主 id 即可收藏、并在「我收藏的」里看到标题）。
 *
 * 为什么是"恒真"而不是删掉调用：删掉会让 `actor` 参数悬空，tsc 的
 * `noUnusedParameters`（或 unused import）当场报错——**红的是编译不是断言**，
 * 那是假证据（`revred-followers.mjs` 头注记过同一个教训）。
 * 这个形状保留全部引用，只把判定放开，编译干净。
 *
 * 认**缺陷**的签名：判据查的是注入标记**在不在**（照 `revred-t1.mjs` 的教训：
 * 判据要认缺陷的样貌，不是正确代码的样貌）。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F = "src/app/lib/server/services/watch.ts";
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

/**
 * ⚠ 锚点必须唯一。`hostVisible` 的函数体只有一处，但"只框住要抽掉的那半句"
 * 是本仓锚点纪律（见 `revred-rule9.mjs` 里那两次改锚点的记录）——所以只框
 * `return Boolean(row);` 那一行连同它上面那条查询的最后一行 `.limit(1);`，
 * 而**不动**函数的签名与注释（改了签名会让编译红成别的样子）。
 */
const needle = "    .where(scopedWhere(host, actor, eq(t.id, BigInt(hostId))))\n    .limit(1);\n  return Boolean(row);";
const replacement =
  "    .where(scopedWhere(host, actor, eq(t.id, BigInt(hostId))))\n" +
  "    .limit(1);\n" +
  "  return true; // 反向红：可见性门恒放行 ⇒ 看不见也能收藏";

const hits = src.split(needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}
const out = src.replace(needle, replacement);
if (out === src) {
  console.error("未找到 hostVisible 的可见性门");
  process.exit(2);
}

writeFileSync(BAK, src, "utf8");
writeFileSync(F, out, "utf8");
console.log("已注入缺陷 [watch-visibility-gate]，备份 " + BAK);

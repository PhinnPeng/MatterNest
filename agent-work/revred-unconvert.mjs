/**
 * 反向红工具：把 risks.ts 里那一行 preset 排除条件换成恒真，跑完再还原。
 *
 * 为什么用 Node 而不在 PowerShell 里做替换：PowerShell 的反引号是转义符，
 * `sql\`${...}\`` 这种串会被吃掉，替换静默不命中 —— 已经因此白跑三次。
 * 「反向红不生效」比「没有反向红」更危险：它给出一个绿的假证据。
 */
import { readFileSync, writeFileSync } from "node:fs";

const F = "src/app/lib/server/services/risks.ts";
const NEEDLE = "sourceKind} <> 'preset'";
const src = readFileSync(F, "utf8");

const idx = src.indexOf(NEEDLE);
if (idx < 0) {
  console.error(`未找到目标片段 ${NEEDLE} —— 代码可能已改，先看清楚再跑反向红`);
  process.exit(2);
}

// 只换**反引号内的模板内容**，保留行首缩进与行尾逗号。
// 前两版分别栽在「整行替换吞了逗号」和「PowerShell 吃掉反引号」上，
// 两次都产出一个「因为编译不过而红」的假证据。
const lineStart = src.lastIndexOf("\n", idx) + 1;
const lineEnd = src.indexOf("\n", idx);
const line = src.slice(lineStart, lineEnd);
const open = line.lastIndexOf("`", line.indexOf("<>"));
const close = line.indexOf("`", open + 1);
if (open < 0 || close < 0) {
  console.error(`没能定位模板字符串：${line}`);
  process.exit(2);
}
const patched = line.slice(0, open + 1) + "1 = 1" + line.slice(close);

if (patched === line) {
  console.error(`行替换未命中：${line}`);
  process.exit(2);
}

const backup = `${F}.revred.bak`;
writeFileSync(backup, src, "utf8");
writeFileSync(F, src.slice(0, lineStart) + patched + src.slice(lineEnd), "utf8");
console.log(`已注入缺陷：\n  改前 ${line.trim()}\n  改后 ${patched.trim()}\n还原文件：${backup}`);
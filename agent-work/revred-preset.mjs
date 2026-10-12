/**
 * 反向红工具：把建事项的「不生成预设节点」改回生成（注入缺陷），跑完再还原。
 *
 * 用 Node 而不是 PowerShell 做替换：PowerShell 的反引号是转义符，
 * `sql\`${...}\`` 这种串会被吃掉，替换静默不命中 —— 已因此白跑三次。
 * **无效的反向红比没有更危险**：它给出一个绿的假证据。
 *
 * 注入的缺陷要**能编译**且**只影响这一条语义**。前几版分别栽在
 * 「整行替换吞了逗号」「注释掉代码行」「用了此 zod 版本没有的方法」上，
 * 三次都产出一个「因为编译不过而红」的假证据。
 */
import { readFileSync, writeFileSync } from "node:fs";

const F = "src/app/lib/server/services/risks.ts";
const src = readFileSync(F, "utf8");

// 在建事项里重新插回预设节点调用（案件侧那段不动 —— 只认第一处事务内的锚点）
const anchor = "await linkRiskParties(tx, id, partyPlan.rows, BigInt(actor.userId));";
const at = src.indexOf(anchor);
if (at < 0) {
  console.error("未找到 linkRiskParties 锚点");
  process.exit(2);
}
// 判断"是否已注入"只能看**代码行**，不能看注释：本文件旁边的注释里就写着
// `planPresetNodesFor("risk_matter")` 这个字符串（解释为什么删掉它），
// 用 includes 全文件搜索会把注释当成代码，守卫直接误报。
// —— 这本身是同一个毛病的又一次实例：检查的不是它以为的东西。
const codeHasCall = src
  .split("\n")
  .some((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && l.includes('planPresetNodesFor("risk_matter")'));
if (codeHasCall) {
  console.error("代码里已经存在该调用（非注释），先还原再跑");
  process.exit(2);
}

const insert =
  'await insertPlannedNodes(tx, "risk_matter", id, await planPresetNodesFor("risk_matter"), BigInt(actor.userId));';
const at2 = src.indexOf("\n", at) + 1;

const backup = `${F}.revred.bak`;
writeFileSync(backup, src, "utf8");
writeFileSync(F, src.slice(0, at2) + insert + "\n" + src.slice(at2), "utf8");
console.log(`已注入缺陷：建事项重新生成预设节点\n还原文件：${backup}`);
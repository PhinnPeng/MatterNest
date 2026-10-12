/**
 * 反向红工具：把 `riskCreateSchema.parties` 拆回"只引用已登记当事人"，
 * 跑完再还原。
 *
 * 为什么用 Node 而不在 PowerShell 里做替换：PowerShell 的反引号是转义符，
 * `sql\`${...}\`` 这种串会被吃掉，替换静默不命中 —— 已经因此白跑三次。
 * 「反向红不生效」比「没有反向红」更危险：它给出一个绿的假证据。
 *
 * 注入的缺陷要**能编译**且**只影响这一条语义**：前两版分别栽在
 * 「整行替换吞了逗号」和「注释掉代码行」上，两次都产出一个
 * 「因为编译不过而红」的假证据。
 */
import { readFileSync, writeFileSync } from "node:fs";

const F = "src/shared/schema/hosts.ts";
const src = readFileSync(F, "utf8");

// 目标：风险事项侧那一行 parties 定义（案件侧那行字面量相同，用 risk 段落之后的第一次命中定位）
const marker = "export const riskCreateSchema";
const sectionStart = src.indexOf(marker);
if (sectionStart < 0) {
  console.error("未找到 riskCreateSchema");
  process.exit(2);
}

const needle = "parties: z.array(partyLinkSchema).default([]),";
const at = src.indexOf(needle, sectionStart);
if (at < 0) {
  console.error("未找到风险事项侧的 parties 定义");
  process.exit(2);
}

// 换成"只接受 partyId"：快速新增那条路被掐断，但语法完全合法。
// 用数组级 refine 而不是改 schema 形状——改形状容易写出这个 zod 版本没有的方法
// （`innerType` 在此版本不存在），那会让整个 suite 崩在 import 上，是假红。
const replacement = `parties: z.array(partyLinkSchema).refine((xs) => xs.every((x) => !!(x as { partyId?: string }).partyId), { message: "反向红注入" }).default([]),`;

const backup = `${F}.revred.bak`;
writeFileSync(backup, src, "utf8");
writeFileSync(F, src.slice(0, at) + replacement + src.slice(at + needle.length), "utf8");
console.log(`已注入缺陷（风险事项侧 parties 收紧为只接受 partyId）：\n  还原文件：${backup}`);
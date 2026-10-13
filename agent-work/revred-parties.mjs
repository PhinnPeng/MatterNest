/**
 * 反向红工具：把 `insertNewParties` 的**加密**拆掉（密文列直接写明文），跑完再还原。
 *
 * 目标缺陷只有一个语义：证件号/手机号"看起来还在写"，但落库的是明文、盲索引为空。
 * 它**能编译、能跑通建案**，所以只有冒烟脚本的
 *   「证件号是密文（`v1:` 信封）」与「盲索引落库（64 位 hex）」
 * 两条断言会红 —— 那正是我们要证明"这两条断言真的在盯这件事"。
 *
 * 用法（顺序不能反，本仓纪律：**没有反向红的冒烟等于没有冒烟**）：
 *
 *   node agent-work/revred-parties.mjs
 *   node --env-file=.env agent-work/smoke-parties.mjs      # ⇒ 必须红（断言②）
 *   git checkout src/app/lib/server/services/parties.ts    # 还原（备份文件在下面打印）
 *   node --env-file=.env agent-work/smoke-parties.mjs      # ⇒ 必须绿
 *
 * 为什么用 Node 做替换而不是在 PowerShell 里：PowerShell 的反引号是转义符，
 * `sql\`${...}\`` 这种串会被吃掉、替换静默不命中 —— 已经因此白跑三次。
 * 「反向红不生效」比「没有反向红」更危险：它给出一个绿的假证据。
 *
 * ⚠ 本文件原先注入的是另一条缺陷（把 `riskCreateSchema.parties` 收紧成"只接受 partyId"，
 * 用于 MATT-49 的当事人追加路径）。那条已被本次替换掉；要用回去的话，注入语句是：
 *   `parties: z.array(partyLinkSchema).refine((xs) => xs.every((x) => !!(x as { partyId?: string }).partyId), …).default([]),`
 * 打在 `src/shared/schema/hosts.ts` 的 `riskCreateSchema` 段里（旧版全文见 git 历史）。
 */
import { readFileSync, writeFileSync } from "node:fs";

const F = "src/app/lib/server/services/parties.ts";
const src = readFileSync(F, "utf8");

// 目标：insertNewParties 里那两行（加密 + 盲索引）。标记取整段，避免误命中 createParty 里的同名行。
const marker = "export async function insertNewParties";
const at = src.indexOf(marker);
if (at < 0) {
  console.error("未找到 insertNewParties —— 反向红注入点失效，请对照当前实现改本脚本");
  process.exit(2);
}

const needle = `        idNumber: idNumber ? encryptField(idNumber) : null,
        idNumberHash: idNumber ? blindIndex(idNumber) : null,`;
const hit = src.indexOf(needle, at);
if (hit < 0) {
  console.error(
    "未找到加密那两行（格式可能被 prettier 改过）—— 反向红注入点失效，请对照当前实现改本脚本",
  );
  process.exit(2);
}

// 换成"明文直写 + 索引为空"：语法完全合法，建案照常 201，只有密文/哈希两条断言会红
const replacement = `        idNumber,
        idNumberHash: null,`;

const backup = `${F}.revred.bak`;
writeFileSync(backup, src, "utf8");
writeFileSync(F, src.slice(0, hit) + replacement + src.slice(hit + needle.length), "utf8");
console.log(
  `已注入缺陷（insertNewParties 改为明文落库 + 盲索引为空）：\n` +
    `  还原：git checkout ${F}（或 cp ${backup} ${F}）\n` +
    `  期望：smoke-parties.mjs 的「证件号是密文」「盲索引落库」两条红，其余不受影响`,
);

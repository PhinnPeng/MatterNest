/**
 * 反向红工具：把 `insertNewParties` 的**加密**拆掉（密文列直接写明文、盲索引为空），跑完再还原。
 *
 * 目标缺陷只有一个语义：证件号/手机号"看起来还在写"，但落库的是明文、盲索引为空。
 * 它**能编译、能跑通建案**，所以只有冒烟脚本的
 *   「证件号是密文（`v1:` 信封）」与「盲索引落库（64 位 hex）」
 *   两条断言会红（实测还有第三条连带：`L1 用完整证件号也能搜到`）。
 *   那正是我们要证明"这些断言真的在盯这件事"。
 *
 * ## 用法（顺序不能反，本仓纪律：**没有反向红的冒烟等于没有冒烟**）
 *
 *   node agent-work/revred-parties.mjs            # 注入
 *   node --env-file=.env agent-work/smoke-parties.mjs      # ⇒ 必须红（实测 3 条）
 *   node agent-work/revred-parties.mjs restore    # 还原
 *   node --env-file=.env agent-work/smoke-parties.mjs      # ⇒ 必须绿
 *
 * ⚠ **还原一律用 `restore`，不要用 `git checkout`**（初版文档教的正是后者）。
 *   本仓工作树里常年有**未提交**的改动（并行 agent 的产出），`git checkout` 会把它们
 *   一起丢掉——本轮就差点因此丢掉 `listParties`/`exportParties` 那处刚修好的
 *   `42702 column reference "id" is ambiguous`。备份文件才是唯一权威。
 *
 * ⚠ **备份路径必须与别的 revred 工具不同**：曾与 `revred-batch.mjs` 撞过同一个
 *   `matters.ts.revred.bak`，两边同时注入时一方会把另一方的注入提前还原 ⇒ **一次假绿**。
 *   这里后缀带 `-parties`；并且**已存在备份时拒绝注入**（否则第二次注入会把"已注入版"
 *   当成干净版备份下来，之后 restore 还原的是缺陷版——`revred-archive` 踩过这个）。
 *
 * 为什么用 Node 做替换而不是在 PowerShell 里：PowerShell 的反引号是转义符，
 * `sql\`${...}\`` 这种串会被吃掉、替换静默不命中 —— 已经因此白跑三次。
 * 「反向红不生效」比「没有反向红」更危险：它给出一个绿的假证据。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const F = "src/app/lib/server/services/parties.ts";
const BACKUP = `${F}.revred-parties.bak`;
const mode = process.argv[2] ?? "inject";

if (mode === "restore") {
  if (!existsSync(BACKUP)) {
    console.error(`没有备份可还原（${BACKUP} 不存在）—— 要么本来就没注入，要么备份被别的工具删了`);
    process.exit(2);
  }
  writeFileSync(F, readFileSync(BACKUP, "utf8"), "utf8");
  unlinkSync(BACKUP);
  console.log(`已还原 ${F}（来自备份），并删除备份`);
  process.exit(0);
}

if (mode !== "inject") {
  console.error(`未知模式 ${mode}（只有 inject / restore）`);
  process.exit(2);
}

// 已存在备份 ⇒ 说明上一次注入还没还原。再注入会把"已注入版"备份成"干净版"，
// 之后 restore 还原的就是缺陷版（revred-archive 踩过）。宁可拒绝。
if (existsSync(BACKUP)) {
  console.error(
    `已存在备份 ${BACKUP} —— 上一次注入还没还原。先跑 \`node agent-work/revred-parties.mjs restore\`，再注入。`,
  );
  process.exit(2);
}

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

// 换成"明文直写 + 索引为空"：语法完全合法，建案照常 201，只有密文/哈希那几条断言会红
const replacement = `        idNumber,
        idNumberHash: null,`;

writeFileSync(BACKUP, src, "utf8");
writeFileSync(F, src.slice(0, hit) + replacement + src.slice(hit + needle.length), "utf8");
console.log(
  `已注入缺陷（insertNewParties 改为明文落库 + 盲索引为空）\n` +
    `  还原：node agent-work/revred-parties.mjs restore   ← 别用 git checkout（会丢未提交的改动）\n` +
    `  期望：smoke-parties.mjs 的「证件号是密文」「盲索引落库」（+「完整证件号也能搜到」连带）红`,
);

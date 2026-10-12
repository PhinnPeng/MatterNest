/**
 * 反向红工具（MATT-57 富文本）：把正文重新塞进审计，确认「审计不落正文」那条断言会红。
 *
 * 用法：node agent-work/revred-rich-text.mjs [restore]
 *
 * 注入的缺陷：`consider()` 里去掉正文豁免分支，让 description/measure 像 name 一样
 * 把 from/to 值写进 `field_diffs` —— 审计表就此变成明文书的存放处（ADR-0002 的禁令）。
 * 这是**安全断言**，必须证明门禁真能抓住它，否则那条断言只是装饰。
 *
 * 锚点唯一性（revred-followers 的教训：锚点不唯一 ⇒ 拆错地方 ⇒ 假证据）：
 * 用 `if (BODY_FIELDS.has(key)) bodyChanged.push(key);` 定位，那句全仓只有一处。
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
const needle =
  "    if (BODY_FIELDS.has(key)) bodyChanged.push(key);\n    else diffs[key] = { from: cur[key], to: v };";
// 缺陷：正文除了记进 bodyChanged，**还**把 from/to 值写进 field_diffs ——
// 审计表就此变成明文书存放处。保留 `BODY_FIELDS`/`bodyChanged` 的引用，
// 否则 noUnusedLocals 会报编译错（红的是编译不是断言，那是假证据）。
const replacement =
  "    if (BODY_FIELDS.has(key)) bodyChanged.push(key);\n" +
  "    diffs[key] = { from: cur[key], to: v }; // 反向红：正文又落进审计了";
const hits = src.split(needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}
const out = src.replace(needle, replacement);

writeFileSync(BAK, src, "utf8");
writeFileSync(F, out, "utf8");
console.log("已注入缺陷 [body-in-audit]，备份 " + BAK);

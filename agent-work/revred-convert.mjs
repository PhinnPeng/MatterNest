/**
 * 反向红工具（MATT-39 转案件）：注入 **P0-1 违规**——让案件金额继承事项敞口，
 * 确认「金额逐案自填 / 不继承」两条断言会红。
 *
 * 用法：node agent-work/revred-convert.mjs [restore]
 *
 * 为什么要红这一条：master P0-1 是**已验收裁定**（"金额不继承、逐案自填"），
 * 而它是那种"改错了没人会当场发现"的口径——案件照样建出来，只是标的额悄悄变成了
 * 事项的敞口，等对账时才发现。所以必须证明门禁真能抓住它。
 *
 * 锚点唯一性：`amount: input.amount?.trim() || "0",` 在 convertToCase 里只此一处
 *（另一处金额赋值在 matter 建案路径，形状不同）。
 *
 * ⚠ 还原后**别立刻跑冒烟**：`next dev` 是热更新，还原写入到模块重新编译之间有窗口，
 *   那期间请求仍打到**注入版**上，会看到"已还原却还红"的假象（本轮真踩到：
 *   还原后 5 秒跑出 43/3，再跑就 46/0）。判定还原成功要看第二次跑。
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
const needle = '        amount: input.amount?.trim() || "0",';
const replacement =
  '        amount: src.amount || input.amount?.trim() || "0", // 反向红：金额继承敞口（P0-1 违规）';
const hits = src.split(needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}

writeFileSync(BAK, src, "utf8");
writeFileSync(F, src.replace(needle, replacement), "utf8");
console.log("已注入缺陷 [amount-inherit]，备份 " + BAK);

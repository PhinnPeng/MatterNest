/**
 * 反向红工具（MATT-19 跨卡复制）：把「排除 id 类字段」那一行摘掉，
 * 确认 probe-convert-form 的「案号没被抄」断言会红。
 *
 * 用法：node agent-work/revred-copycard.mjs [restore]
 *
 * 为什么要红这一条：抄错案号**不会报错**——库层「非唯一、重复只提示不阻止」是给
 * "不同法院案号体系重号"留的口子，于是复制粘贴批量重号能一路存进去，等对账时才发现。
 * 静默错误必须由断言守，不能靠注释守。
 *
 * ⚠ 还原后别立刻跑探针：`next dev` 热更新有窗口，那期间请求仍打到注入版
 *（revred-convert 那轮踩过：还原后 5 秒跑出假红）。判定还原成功看第二次跑。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F = "src/app/(desk)/risk-matters/convert-dialog.tsx";
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
const needle = "    delete copyable.caseNo; // 案号是 id 类字段：不抄（理由见上）";
const replacement = "    // 反向红：案号也一起抄了（id 类字段未排除）";
const hits = src.split(needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}

writeFileSync(BAK, src, "utf8");
writeFileSync(F, src.replace(needle, replacement), "utf8");
console.log("已注入缺陷 [copy-caseNo]，备份 " + BAK);

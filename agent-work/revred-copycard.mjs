/**
 * 反向红工具（MATT-19 跨卡复制）：把白名单复制改成"整份 spread"，
 * 确认 `probe-convert-form` 的「案号没被抄」断言会红。
 *
 * 用法：node --env-file=.env agent-work/revred-copycard.mjs [restore]
 *
 * 为什么要红这一条：抄错案号**不会报错**——库层「非唯一、重复只提示不阻止」是给
 * "不同法院案号体系重号"留的口子，于是复制粘贴批量重号能一路存进去，等对账时才发现。
 * 静默错误必须由断言守，不能靠注释守。
 *
 * ⚠ **2026-10-13 改过注入点**：MATT-19 后来把"spread 再删掉案号"的黑名单实现换成了
 * `shared/schema/hosts.ts` 的白名单函数 `copyConvertCard`（黑名单会随字段增长而漏），
 * 而本工具原先注入的是 `convert-dialog.tsx` 里那行 `delete copyable.caseNo`——
 * 那行已经不存在了，于是**锚点静默失效**：工具会在真跑时"拒绝注入"退出，
 * 而人只会以为反向红验过了。改注入白名单函数之后重新对准。
 *
 * 这类"锚点随被注入代码一起腐"的问题现在有 `agent-work/_check-anchors.mjs` 兜住
 * （不需要数据库，跑反向红之前先验一遍）。
 *
 * ⚠ 还原后别立刻跑探针：`next dev` 热更新有窗口，那期间请求仍打到注入版
 *（revred-convert 那轮踩过：还原后 5 秒跑出假红）。判定还原成功看第二次跑。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F = "src/shared/schema/hosts.ts";
const BAK = `${F}.revred.bak`;
const restore = process.argv[2] === "restore" || process.argv[3] === "restore";

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
const needle = `  const picked: Record<string, unknown> = {};
  for (const f of CONVERT_CARD_COPYABLE_FIELDS) {
    if (f in source) picked[f] = source[f];
  }
  return { ...target, ...picked } as T;`;
const replacement = `  // 反向红：整份 spread（id 类字段未排除 ⇒ 案号会被抄到其余卡）
  return { ...target, ...source } as T;`;
const hits = src.split(needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入，避免拆错地方`);
  process.exit(2);
}

writeFileSync(BAK, src, "utf8");
writeFileSync(F, src.replace(needle, replacement), "utf8");
console.log("已注入缺陷 [copy-everything]，备份 " + BAK);

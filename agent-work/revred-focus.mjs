/**
 * 反向红工具（MATT-33 第二件）：把「聚焦首个错字段」换回原来的吞错误写法，
 * 确认 probe-v6-tails 的「首个错误字段拿到焦点」断言会红。
 *
 * 用法：node agent-work/revred-focus.mjs [restore]
 *
 * 为什么要红这一条：`scrollToFirstError` **只滚不聚焦**，而"标红了"与"焦点过去了"
 * 在截图与人工点检里看起来一模一样（错误框都在视口内）。也就是说这个缺陷**看不出来**，
 * 只能由断言抓——正是本票第二件的全部内容。
 *
 * ⚠ 还原后别立刻跑探针：`next dev` 热更新有窗口（revred-convert 那轮踩过）。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const F = "src/app/(desk)/risk-matters/risk-create-dialog.tsx";
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
const needle = "    const values = await validateAndFocusFirst(form);";
// 保留 `validateAndFocusFirst` 的引用（`void` 一行）：否则 noUnusedLocals 报 TS6133，
// 红的是**编译**不是断言——按本仓纪律那是假证据（revred-rich-text 也踩过同一条）。
const replacement =
  "    const values = await form.validateFields().catch(() => null); // 反向红：吞掉错误对象\n" +
  "    void validateAndFocusFirst; // 反向红：保留引用，避免变成编译红";
const hits = src.split(needle).length - 1;
if (hits !== 1) {
  console.error(`锚点命中 ${hits} 次（要恰好 1 次）—— 拒绝注入`);
  process.exit(2);
}

writeFileSync(BAK, src, "utf8");
writeFileSync(F, src.replace(needle, replacement), "utf8");
console.log("已注入缺陷 [no-focus]，备份 " + BAK);

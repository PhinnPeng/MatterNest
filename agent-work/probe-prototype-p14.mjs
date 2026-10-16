/**
 * P14 批量导入原型的**视觉与行为探针**（一次性产物）。
 *
 * 只做两件事，因为原型没有服务端可测：
 *   ① 三个变体各自能渲染出该有的结构（A 单栏堆叠 / B 左右两栏 / C 上传塌成细 bar）；
 *   ② 三种关键状态下页面**说了该说的话**（正常态的三计数、重导态的"一行都没有新增"、
 *      非 L1 态的 403 文案），并且**不出现旁白**（副标题纪律：标题下的第二行说明）。
 * 观感靠截图人看，脚本只断结构与文案。
 *
 * 用法：node agent-work/probe-prototype-p14.mjs
 *   （先起静态服务器： 在 prototype worktree 根跑
 *     node F:/WorkSpace/MatterNest/agent-work/prototype-server.mjs 3941）
 */
import { createRequire } from "node:module";
import { pickChrome, playwrightRoot } from "./_chrome.mjs";

const require = createRequire(playwrightRoot());
const { chromium } = require("playwright");
const CHROME = pickChrome();
const P14 = "http://127.0.0.1:3941/src/app/%28desk%29/config/prototype-p14-import.html";

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${extra ? " — " + extra : ""}`);
  }
};

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

for (const [variant, probe] of [
  ["A", ".vA .stack"],
  ["B", ".vB .grid"],
  ["C", ".vC"],
]) {
  await page.goto(`${P14}?variant=${variant}`, { waitUntil: "load" });
  await page.waitForTimeout(120);
  ok(`变体 ${variant} 渲染出该有的结构`, (await page.locator(probe).count()) > 0);
  const box = await page.locator(".content").boundingBox();
  ok(`变体 ${variant} 没有横向溢出`, box.width <= 1366 - 212, `content 宽 ${box.width}`);
}

// 状态：正常（812 / 41）
await page.goto(`${P14}?variant=A`, { waitUntil: "load" });
await page.click('#playbar button[data-state="ok"]');
await page.waitForTimeout(120);
const txt = await page.locator(".content").innerText();
ok("正常态给出三个计数（853 / 812 / 41）", txt.includes("853") && txt.includes("812") && txt.includes("41"));
ok("正常态列出未导入的行，带行号 / 字段 / 原因三列", /行号[\s\S]*字段[\s\S]*原因/.test(txt));
ok("原因用的是实现里的中文文案（不是占位）", txt.includes("是本企业名称") && txt.includes("不认识"));
ok("报告下载入口在结果区里", (await page.locator('button:has-text("下载错误报告")').count()) > 0);
ok(
  "字段与取值收在折叠区（落点④），不在页头讲规则",
  (await page.locator("details.fields-wrap summary").first().innerText()).includes("字段与取值"),
);
ok(
  "标题下没有第二行说明（副标题纪律）",
  !/批量导入[\s\S]{0,80}(一次性|历史台账|把旧|本页)/.test(
    await page.locator(".topbar").innerText(),
  ),
);

// 状态：同文件重导
await page.click('#playbar button[data-state="replay"]');
await page.waitForTimeout(120);
const replayTxt = await page.locator(".content").innerText();
ok("重导态说清「一行都没有新增」", replayTxt.includes("一行都没有新增"));

// 状态：非 L1 拒绝
await page.click('#playbar button[data-state="denied"]');
await page.waitForTimeout(120);
const deniedTxt = await page.locator(".content").innerText();
ok("非 L1 态给出拒绝原因与下一步", deniedTxt.includes("全局数据范围") && deniedTxt.includes("全局经办"));
ok("非 L1 态顶栏标记无 L1 范围", (await page.locator("#scopeTag").innerText()).includes("无 L1"));

// 文件级错误态
await page.click('#playbar button[data-state="fileerr"]');
await page.waitForTimeout(120);
const errTxt = await page.locator(".content").innerText();
ok("文件级错误态点名哪一列不认，并说下一步", errTxt.includes("不认识的列") && errTxt.includes("下载对应模板"));

// 三个变体各截一张（正常态）
for (const variant of ["A", "B", "C"]) {
  await page.goto(`${P14}?variant=${variant}`, { waitUntil: "load" });
  await page.click('#playbar button[data-state="ok"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `agent-work/p14-import-variant-${variant}.png`, fullPage: false });
  console.log(`截图：agent-work/p14-import-variant-${variant}.png`);
}
// 重导态 + 拒绝态各一张（都用变体 C，状态差异最显眼）
for (const [state, name] of [["replay", "replay"], ["denied", "denied"]]) {
  await page.goto(`${P14}?variant=C`, { waitUntil: "load" });
  await page.click(`#playbar button[data-state="${state}"]`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `agent-work/p14-import-${name}.png`, fullPage: false });
  console.log(`截图：agent-work/p14-import-${name}.png`);
}

await browser.close();
console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);

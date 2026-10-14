/**
 * 禁令⑧ 冒烟脚本卫生（2026-10-14，retro 候选 ①）。
 *
 * ## 这条断言防的是什么
 *
 * 本轮出过一次**静默塌陷**：`smoke-notifications.mjs` 有一行
 * `await call("POST", …, { to: "closed" })` 丢弃了返回值。那一步实际返 422
 * （事项冻结裁定生效），于是它没产生通知，而往下四条断言全部塌成 `items=0` ——
 * 报出来的是「通知链路坏了」，真因却是脚本没跟上裁定。
 *
 * **根因不是忘了检查，是「拿到结果却不看」这件事没有任何机制会说话。**
 * `pnpm verify` 的五道里没有一道读 `agent-work/*.mjs` 的语义：
 * `anchors:check` 只从 `revred-*.mjs` 抽 needle 字面量，
 * `lint-guard` 的两条源码断言只扫 `src/**`。
 *
 * ## 规则：每次调用都必须**显式**
 *
 * 一个独立的 `await call(...)` 语句只有两种合法形态：
 *
 *   const res = await call(...)          ← 结果被接住（无论用不用）
 *   await call(...) // discard: <理由>   ← 丢弃，但写明为什么
 *
 * 裸的 `await call(...)` 一律不允许。
 *
 * ⚠ **为什么是「显式」而不是「下一行必须跟断言」**：第一版想过后者，
 * 写完发现它**抓不到本轮这个 bug** —— 那一处的下一行恰恰就是 `ok(...)`。
 * 下一行有没有断言，和**被丢弃的那一步有没有被检查**，是两件事：
 * 断言可能在检查后面第三行的另一次调用。改成「显式」之后，
 * 每一处丢弃都必须自己交代理由，于是本轮那处会逼出
 * 「这一步只为触发副作用」或「这里其实漏了断言」——两个都是有价值的话。
 *
 * 代价：仓里现存 21 处需要逐个判��。但那正是这条门禁的收益，
 * 而不是它的成本：**它在替读脚本的人回答「这里为什么不看结果」。**
 *
 * ## 这条断言抓不到什么（别高估它）
 *
 * 同一份 retro 还发现 `smoke-risk.mjs:116` 的
 * `const [closedNames] = await sql\`…\`` —— 解构把行数组换成了第一行对象，
 * `closedNames.length === 2` **恒假**。
 *
 * **这条门禁抓不到它，也不假装能抓**：恒假断言在**语法上与正确写法同形**
 * （`const [row] = await sql` 是标准惯用法）。只有「拿到了却完全没用」
 * 才是可扫的形状；「用错了地方」要靠评审。
 */

import { readdir, readFile } from "node:fs/promises";

const SMOKE_DIR = "agent-work/";

/** 显式说明为什么丢弃 —— 有理由的丢弃是允许的 */
const DISCARD = /\/\/\s*discard:/;

/**
 * 从第 `from` 行起找到这条**语句**真正结束的那一行。
 *
 * ⚠ 这一步是必须的：仓里大量 `call` 是多行调用，参数对象跨行
 * （`await call("POST", url, cookie, {` / `  to: closed.code,` / `});`）。
 * 不知道语句在哪结束，就会把参数续行当成下一行，然后报一堆误伤。
 *
 * 简化做法：只看**行首形态**——续行要么以 `});` / `);` 收尾，要么是缩进的内容行。
 * 与其做一个要处理模板串 `${…}` 的完整状态机（第一版栽在这里：
 * 9 处命中里 8 处是 `to: …,` 参数行），不如只问一个问题：
 * **下一个缩进块的开头在哪？**
 *
 * @returns {number} 语句结束所在行号（含）
 */
function endOfStatement(lines, from) {
  const baseIndent = lines[from].match(/^\s*/)[0].length;
  for (let i = from + 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === "" || t.startsWith("//")) continue;
    const indent = raw.match(/^\s*/)[0].length;
    // 缩进回到本层或更浅 ⇒ 上一句结束了
    if (indent <= baseIndent) return i - 1;
  }
  return lines.length - 1;
}

/**
 * @param {string[]} failures 收集到的违规。由 check.mjs 传进来 ——
 *   `failures` 是那个文件的局部变量，这里看不到，所以必须显式传，不能自己 new 一个。
 */
export async function assertSmokeHygiene(failures) {
  const entries = await readdir(SMOKE_DIR);
  const files = entries.filter((f) => /^smoke-.*\.mjs$/.test(f));
  if (files.length === 0) {
    failures.push("冒烟卫生：一个 smoke-*.mjs 都没读到，整条断言是假通过");
    return;
  }

  let scanned = 0;
  for (const f of files) {
    const lines = (await readFile(`${SMOKE_DIR}${f}`, "utf8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 只看「整行就是这一个调用」的独立语句；`const x = await call(...)` 天然不匹配
      // （它以 const/let/var 开头），所以不需要单独放行 —— 见文件末尾「抓不到什么」
      if (!/^\s*await\s+call\(/.test(line)) continue;

      // ⚠ `scanned` 数的是「**看到的语句**」，不是「违规数」。
      // 它必须在两个过滤**之前**自增：第一版把它放在 DISCARD 之后，于是
      // scanned === 0 恰好是**仓库干净**的状态，canary 反过来在正确时报红
      // （代理在 2026-10-14 抓到）。这条断言的价值全在 canary 上，
      // canary 一旦反了，整条门禁就变成了「永远红」或「被无脑改成永不红」。
      scanned++;

      if (DISCARD.test(line)) continue;

      const end = endOfStatement(lines, i);
      // 丢弃的理由写在多行调用的**收尾行**上也算数（`}); // discard: …`）
      if (end !== i && DISCARD.test(lines[end])) continue;

      failures.push(
        `${SMOKE_DIR}${f}:${i + 1} 裸的 \`await call(...)\` —— 结果拿到了却没人看。\n` +
          `    本轮就栽在这一形状上：一步静默失败，把后面所有断言都带偏，\n` +
          `    报出来的是别的功能的红，而真因（这一步的返回值）从头到尾没出现。\n` +
          `    改法二选一：\`const res = await call(...)\` 接住（用不用都算接住）；\n` +
          `    或在收尾行写 \`// discard: <为什么这一步不需要看结果>\`。`,
      );
    }
  }

  if (scanned === 0) {
    failures.push(
      "冒烟卫生：扫到 0 处裸 `await call(...)` —— 规则或路径写歪了，本条断言是假通过" +
        "（与 A/B/C/D2 同一道防：规则写歪了不等于违规不存在）",
    );
  }
}

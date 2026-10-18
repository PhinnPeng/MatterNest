/**
 * 反向红的**编译门** —— 注入之后、跑冒烟之前跑一次（不需要数据库，但需要 `tsc`）。
 *
 * 用法：
 *   node agent-work/revred-watch.mjs visibility-gate
 *   node agent-work/revred-gate.mjs          # ← 这道门
 *   node --env-file=.env agent-work/smoke-watch.mjs   # ⇒ 必须红
 *
 * 退出码：0 = 编译干净（可以信这次的红）；1 = 编译红（这次的红不算证据）；2 = 环境不对。
 *
 * ## 为什么需要它 —— 以及本仓此前记错的那条机制（2026-10-18 实测更正）
 *
 * 本仓在四处（`revred-staff` / `revred-watch` / `revred-batch` 的头注 + 两份 retro）写着：
 *
 *   > 编译失败时 dev server 继续发旧产物，冒烟会**假绿**。
 *
 * **这条是错的。** 2026-10-18 在真 dev server（:3777）+ 真库上实测三种注入形态：
 *
 * | 注入形态 | `tsc` | 冒烟结果 | 结论 |
 * |---|---|---|---|
 * | `visibility-gate` 原样（带 `void row;`） | 干净 | 30/3，三条都是断言红 | 红得是地方 |
 * | 同上但删掉 `void row;`（TS6133） | **红** | 30/3，**一字不差的三条断言红** | 类型错不影响发版 |
 * | `return (true;`（语法错） | 红 | **每条路由 500**，冒烟红成一片 | **假红** |
 *
 * 原因：Turbopack **不做类型检查**，只剥类型。所以类型错既不会让 dev server 停摆，
 * 也不会让它发旧产物 —— 模块照常按新代码跑。真正编译不过的是**语法错**与
 * **名字解析不到**，而它们的表现是 **500**，不是旧产物。
 *
 * `revred-staff` 记的那次「编译红 + 28/0 全绿」也因此不成立：同一段注释往下两行就写着
 * 「修成可编译之后**仍然全绿**」——绿的原因是那个 `findUnassignable` 调用**本来就冗余**
 * （该模式随后被删，见 `matters.ts` 门 4 的注释），与编译红没有因果关系。
 * 两件各自为真的事，被接成了一条假的因果。
 *
 * ## 真正的危险是**反方向**
 *
 * 注入写坏了 ⇒ 模块编译不出来 ⇒ **每条路由 500** ⇒ 冒烟红 ⇒
 * 你以为「断言抓住了这个缺陷」。**那是假证据**，而且它比假绿更难发现：
 * 假绿你会去查，假红你会直接记一笔「验过了」。
 * `agent-work/_revred-loop.ps1` 那种自动循环只数 `red=N`，完全看不出来。
 *
 * ## 它管什么、不管什么
 *
 * 管：`tsc --noEmit` 能报的一切 —— 语法、名字解析、类型。
 * 不管：**语义**。注入写对了但锚点落在无关的地方，编译一样干净，门放行，
 * 红的也不是你要验的那条断言。这道门只把「红得不是地方」里**最便宜的一类**挡掉。
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";

const TSC = "node_modules/typescript/bin/tsc";

/**
 * 扫出**正在生效的注入**。判据是备份文件：每个 revred 工具注入前都把原文写到
 * `<被改的文件>.revred-<工具>.bak`（约定见 `revred-watch.mjs` 的 `bakOf`），
 * 还原时删掉。所以「有 `.bak` 且名字里带 revred」⇔ 那处注入还在树上。
 *
 * ⚠ 分两类，别混：`revred-heartbeat.mjs` 注入的是**数据库行**不是源码，
 *   它的 `agent-work/revred-heartbeat.bak` 存的是原行。判据用「剥掉后缀之后
 *   那个路径在磁盘上存在吗」——源码备份必然指向一个真文件，行快照不指向任何文件。
 *   混进来的后果是「有注入在生效」这句话在源码没被动过时也成立。
 *
 * ⚠ 为什么非要这个：没有它，「编译干净」这句话在**没注入**时也成立，
 *   于是忘注入 + 跑门 + 见绿 ⇒ 以为注入验过了。这道门的绿只对**注入期**有意义。
 */
function activeInjections() {
  const sources = [];
  const others = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!name.endsWith(".bak") || !name.includes("revred")) continue;
      // `watch.ts.revred-watch.bak` → `watch.ts`；`matters.ts.revred.bak` → `matters.ts`
      const target = name.replace(/\.revred[a-z0-9-]*\.bak$/, "");
      if (target !== name && existsSync(`${dir}/${target}`)) {
        sources.push({ target: `${dir}/${target}`, bak: p });
      } else {
        others.push(p);
      }
    }
  };
  for (const root of ["src", "agent-work"]) {
    if (existsSync(root)) walk(root);
  }
  return { sources, others };
}

const { sources: injected, others: nonSource } = activeInjections();

console.log("反向红编译门");
console.log("");
if (injected.length === 0) {
  console.log("· 树上没有**源码注入**在生效（没找到指向真文件的 `*.revred*.bak`）——");
  console.log("  这道门只管注入期：此刻的绿**不能**当作「某个注入编译干净」的证据。");
} else {
  console.log(`· 树上有 ${injected.length} 处源码注入在生效：`);
  for (const { target, bak } of injected) console.log(`    ${target}  ← 备份 ${bak}`);
}
if (nonSource.length) {
  console.log(`· 另有 ${nonSource.length} 处非源码注入（数据库行快照，不进编译门）：`);
  for (const p of nonSource) console.log(`    ${p}`);
}

if (!existsSync(TSC)) {
  console.error(`\n🔴 找不到 ${TSC} —— 这道门给不出结论，不要当它放行了。`);
  process.exit(2);
}

const t0 = Date.now();
const run = spawnSync(process.execPath, [TSC, "--noEmit"], { encoding: "utf8" });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
console.log(`· tsc --noEmit：${secs}s，退出码 ${run.status}`);

if (run.status === 0) {
  console.log("\nGATE-OK 编译干净 —— 这次冒烟若红，红的才可能是断言。");
  process.exit(0);
}

/**
 * 把诊断行归到文件上，好回答那个真正要问的问题：
 * **错在我注入的那个文件里吗？**
 */
const injectedTargets = new Set(injected.map((i) => i.target.replace(/\\/g, "/")));
const lines = out.split("\n").filter(Boolean);
console.log("\n🔴 GATE-FAIL 编译红 —— 这次冒烟的红**不能算断言红**：\n");
for (const line of lines) {
  const file = line.match(/^([^(]+)\(/)?.[1]?.replace(/\\/g, "/");
  const mine = file && injectedTargets.has(file);
  console.log(`  ${line}`);
  if (mine) console.log("      ↑ 这个文件正在被注入 —— 是注入写坏了，不是实现有缺陷");
}
console.log(
  "\n  编译不出来的模块会让**每条路由都返 500**，冒烟照样红成一片，" +
    "\n  而你会以为「断言抓住了缺陷」。先把注入改到能编译，再跑冒烟。" +
    "\n  （类型错不会让 dev server 发旧产物 —— 2026-10-18 实测；坏的是语法与名字解析。）",
);
process.exit(1);

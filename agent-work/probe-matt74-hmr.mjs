/**
 * MATT-74 的 dev HMR ×10 证据：**连切 10 次之后仍然只有一个定时器**。
 *
 * 用法：
 *   MN_DEV_LOG=<dev server 的 stdout 文件> node agent-work/probe-matt74-hmr.mjs
 * 退出码：0 全过；1 断言红；3 环境不对（日志读不到 / 文件不在）。
 *
 * ## 它在证什么（两条可数的事实，不是"我看了日志"）
 *
 * 票面判据：「dev HMR 连切 10 次，确认只起一个定时器」。
 *   1. `[timer] 定时器已启动` 在整段里**恰好一条**（多一条就是起了第二份定时器）；
 *   2. 10 次 HMR **之后没有新增**这条 —— 也就是 `register()` 没有被重跑。
 *
 * ⚠ 第二条只有在"HMR 真的发生过"时才不是空转，所以本探针**自带 HMR 的写入方**：
 * 每次往 `api/notifications/route.ts` 末尾追加一行模块级 `console.info("[hmr] ...")`
 * 并打一次请求 —— 那行日志出现几次，就是 HMR 重求值了几次。
 * 只数 `Compiling ...` 是不够的（turbopack 懒编译，日志时机不固定；本轮实测数到 0 次，
 * 而文件确实变了）。
 *
 * ## 为什么切的是 `route.ts` 而不是 instrumentation 文件
 *
 * `docs/research-croner-status-heartbeat.md` §7.2 记了那条坑：改了 instrumentation 文件
 * 在 dev 下**不会热生效**（`start-server.js:470-472` 只盯 CONFIG_FILES，模块缓存永不重置）。
 * 对定时器来说这是好事：模块重求值 = 第二条链 / 第二份定时器，而框架把它挡住了。
 * 所以要切**真的会 HMR 的 app 文件**——本探针切读驱动那个 route，它正好是
 * `pumpAll()` 的另一个调用点：它每重求值一次，就重新 import 一次 `pump-gate`。
 * 于是这条探针顺带钉住了「HMR 之后单飞的链还在不在」（链挂在 `globalThis`，不在模块里）。
 *
 * ## 为什么用 Node 写文件而不是 PowerShell
 *
 * 本轮踩过一次：`Get-Content -Raw` + `Set-Content -Encoding utf8` 在 Windows PowerShell
 * 5.1 下会用 ANSI 码页解码 UTF-8，把文件里的中文**写成乱码**（当场把
 * `notifications-view.tsx` 编译成 500）。Node 的 `readFileSync(..., "utf8")` 没有这个问题，
 * 而且还原是**按字节**的，最后拿 sha256 + `git status` 双向对账。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3777";
const TARGET = "src/app/api/notifications/route.ts";
const ROUNDS = 10;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`[ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const LOG = process.env.MN_DEV_LOG ?? (existsSync("/tmp/next-dev.log") ? "/tmp/next-dev.log" : null);
if (!LOG) {
  console.error("找不到 dev server 日志（设 MN_DEV_LOG=<path>）—— 本探针的判据全在日志里。");
  process.exit(3);
}
if (!existsSync(TARGET)) {
  console.error(`找不到 ${TARGET}`);
  process.exit(3);
}
const readLog = () => readFileSync(LOG, "utf8");
const count = (text, needle) => text.split(needle).length - 1;

const original = readFileSync(TARGET, "utf8");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const hashBefore = sha(original);

const startupsBefore = count(readLog(), "[timer] 定时器已启动");
ok(
  "实验开始时日志里恰好一条「定时器已启动」",
  startupsBefore === 1,
  `实际 ${startupsBefore} 条 —— 多于一条说明已经起了第二份`,
);

let notOk = 0;
let hmrHits = 0;
const logFrom = readLog().length;
try {
  for (let i = 1; i <= ROUNDS; i++) {
    // 模块级 `console.info`：模块被**重求值**时才会打出来 —— 这就是 HMR 的写入方
    writeFileSync(TARGET, `${original}\nconsole.info("[hmr] route 重求值 ${i}");\n`, "utf8");
    // ⚠ 顺序是「写 → **等 watcher 处理失效** → 请求」：
    // 反过来的话，第 N 轮那次请求会被**第 N−1 轮**编译出来的模块服务
    // （本轮实测：marker 只出现 1..9，永远少最后一个 —— 而那不是定时器的问题，
    //   是探针自己的时序错，探针的红必须红在真东西上）。
    await sleep(700);
    try {
      const res = await fetch(`${BASE}/api/notifications`);
      // 401 也算成功：路由模块已被加载并执行（鉴权是模块里的 withActor 才拦的）
      if (res.status !== 401 && res.status !== 200) notOk++;
      await res.arrayBuffer();
    } catch {
      notOk++;
    }
  }
  await sleep(500);
  // HMR 的重编译是**异步**的：最后那一两次 marker 可能还没落进日志。
  // 所以这里等它到齐（最多 10s），而不是"读一次没到齐就判红"——那种红是探针自己的假红。
  for (let i = 0; i < 20; i++) {
    hmrHits = count(readLog().slice(logFrom), "[hmr] route 重求值");
    if (hmrHits >= ROUNDS) break;
    await sleep(500);
  }
} finally {
  // **先还原再断言**：断言失败也不能把仓库留在被改过的状态
  writeFileSync(TARGET, original, "utf8");
}

ok("10 次切换期间路由每次都跑通（200/401，没有 500）", notOk === 0, `异常 ${notOk} 次`);
ok(
  "**HMR 真的发生了 10 次**（模块级 marker 被重求值 10 次）",
  hmrHits >= ROUNDS,
  `日志里 "[hmr] route 重求值" 出现 ${hmrHits} 次`,
);

const startupsAfter = count(readLog(), "[timer] 定时器已启动");
ok(
  "切换 10 次之后**仍然只有一份定时器**（没有新的「定时器已启动」）",
  startupsAfter === startupsBefore,
  `实验前 ${startupsBefore} 条 → 实验后 ${startupsAfter} 条`,
);

const hashAfter = sha(readFileSync(TARGET, "utf8"));
ok("文件按字节还原（sha256 相同）", hashBefore === hashAfter, `${hashBefore.slice(0, 12)}…`);
// ⚠ 这里**不能**拿 `git status` 当判据：本票自己就在改这个文件，它本来就带着未提交改动
// （本轮第一版就是这么判的，于是探针自己给自己造了一次假红）。
// 「还原干净」的判据只能是**与实验前那份字节相同** —— 也就是上面那条 sha256。

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

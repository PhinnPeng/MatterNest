/**
 * 应用内定时器的 **Next 入口**（MATT-74 / T4e）。全部实现在 `./instrumentation-node.ts`。
 *
 * ## 为什么这个文件里只有一次 `require`（这是本轮实测出来的、研究文档没写对的地方）
 *
 * Next 会为**两个 runtime 各编一份 instrumentation**，而且**没有 Edge 路由也会编**：
 * `dist/build/entries.js:189-197` 用
 * `isEdgeServer ? 'edge-instrumentation.js' : 'instrumentation.js'` 建两个 entry。
 *
 * ⚠ 这与 `docs/research-portable-scheduler.md` §3.4「Edge 旁路不会触发」**不完全一致**：
 * 不触发的只是 Edge 的 **`register()` 调用**，而 Edge 的 **instruction 编译永远会发生**。
 * 本轮实测的第一版就是「把 croner / 服务层静态 import 进来」，dev 启动当场报：
 *
 * ```
 * ⚠ ./src/app/lib/server/services/notifications.ts:1:1
 * Warning: A Node.js module is loaded ('node:crypto' ...) which is not supported in the Edge Runtime.
 * Ecmascript file had an error
 * Import trace:  Edge Instrumentation:
 *   ./src/app/lib/server/services/notifications.ts
 *   ./src/app/lib/server/services/pump-gate.ts
 *   ./src/instrumentation.ts
 * ```
 *
 * 所以 Node 侧的东西**一个都不能静态 import**——连 `import { Cron } from "croner"` 也不行
 * （它现在是纯 JS，但把「谁会被拖进 Edge 包」这件事交给库的实现细节去保证，是运气不是设计）。
 *
 * ## 为什么是 `require`（同步），而不是官方指南里的 `await import()`
 *
 * 官方两份文档给了两种写法：
 *   · 指南（`02-guides/instrumentation.md:52-84`）用 `await import('./instrumentation-node')`
 *     —— 那会让 `register` 变成 **async**，正文里就多了一个 await（前置件 1 要的是**同步返回**）；
 *   · 参考（`03-api-reference/.../instrumentation.md:127-145`）用
 *     `return require('./register.node')` —— **同步**，本文件走的是这条。
 *
 * `require` 是同步的，于是「server ready ⇒ 定时器已经起来了」这条更强的性质也保住了
 * （`await import()` 只能保证「ready 之前**开始**加载」）。前置件 1 的完整论证见
 * `instrumentation-node.ts` 的头注。
 *
 * ## 为什么判断写成 `if (NEXT_RUNTIME !== 'edge') { require(...) }`
 *
 * `dist/build/define-env.js:80` 把 `process.env.NEXT_RUNTIME` 定义成**字面量**
 * （`isEdgeServer ? 'edge' : isNodeServer ? 'nodejs' : ''`）。所以在 Edge 那一份编译里
 * 这个条件被折叠成 `if (false) { ... }`，**整块（含那次 require）被 DCE 掉**，
 * Node 模块一个都不进 Edge 包。
 *
 * ⚠ 刻意**不**写成 `if (NEXT_RUNTIME !== 'nodejs') return`：那样「runtime 值不是预期」
 * 会变成**静默不起定时器**——而静默不跑与「没人该收」在库里长得一模一样
 * （`api/notifications/route.ts` 自己写了这句话）。现在只有 Edge 走早退，
 * 其余任何 runtime 都会去加载 Node 模块并**响亮地失败**（缺模块 ⇒ 抛 ⇒ 框架 `exit 1`）。
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "edge") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同步要求见上（前置件 1）
    const node = require("./instrumentation-node") as typeof import("./instrumentation-node");
    node.registerNode();
  }
}

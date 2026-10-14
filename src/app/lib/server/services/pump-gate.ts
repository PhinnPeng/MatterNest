import { scanArchiveIncomplete } from "./archive-reminder";
import { pumpNotifications } from "./notifications";

/**
 * 轮询的**进程内单飞**（MATT-74 前置件 4）。
 *
 * ## 它防的是哪种失败
 *
 * 「两份 pump 同时跑」：`protect: true` 只挡**定时器自己**的重入，挡不住
 * 「定时器 × 读驱动」——`GET /api/notifications` 那条读驱动还在（一期不收敛它），
 * 于是每 5 分钟一次定时器与每个用户的读请求可以同时各跑一份完全相同的扫描。
 * 两份同时跑不会产生重复通知（`dedupe_key` 唯一键吸收，MATT-35 已实测），
 * 代价在**连接与锁**上：两边同时对同一个 `dedupe_key` 发
 * `INSERT … ON CONFLICT DO NOTHING`，输家阻塞在赢家的行锁上直到赢家**整个事务**提交，
 * 而那个事务里还串着 N 次投递行插入（`notifications.ts:801-848`）——
 * 「等锁」于是被放大成「等一个事务」，这段时间两边各占着池里的一条连接。
 * `PG_POOL_MAX=10`（`.env.example:18`）在十人企业下够用，但这份白等没有理由发生。
 *
 * ## 为什么必须是**第三个**模块，而不是加在 `notifications.ts` 里
 *
 * 一次「pump」= `pumpNotifications()` + `scanArchiveIncomplete()` 两件（与
 * `api/notifications/route.ts` 原来的两行逐字相同）。规则 9 刻意**不并进**
 * `pumpNotifications()`，因为那会形成 `notifications.ts ↔ archive-reminder.ts`
 * 的循环 import（`api/notifications/route.ts:50-52` 写了这条理由）。
 * 所以两者只能在**同时 import 它们俩**的第三个模块里合流。
 *
 * ⚠ **定时器绝不能反向 import `src/instrumentation.ts`**：那会把一个带 `setInterval`
 * 的模块拖进 app 的 import 图，而 HMR 按模块重求值 ⇒ **起第二份定时器**
 * （`docs/research-portable-scheduler.md` §3.3 的第 2 个坑——框架的单例只防住了
 * 「register 重跑」，没防住「被 app 代码 import」）。这也是这个模块存在的第二个理由。
 *
 * ## 单飞形态：**排队**，不是「跳过」也不是「合并进在飞的那一次」
 *
 * 三种形态的差别只在**调用者拿到什么**：
 *
 * | 形态 | 调用者 |
 * |---|---|
 * | 跳过（研究文档的最小实现） | 直接返回，**这一次没有 pump 发生** |
 * | 合并进在飞的那一次 | 拿到**早于它到达**的那一次的结果 |
 * | **排队（本实现）** | 拿到**属于它自己的、起点晚于它到达**的一次 |
 *
 * 前两种都会把读驱动的语义从「返回前一定跑过一次完整 pump」改成「可能没跑/跑的是
 * 别人那次」。而这条语义正是 `agent-work/smoke-notifications.mjs:363-379` 逐字钉住的
 * 东西（「事件要等消费侧跑过才有」）：被跳过的那次 GET 会让
 * 「转案件后事件数=1」偶发变红，**而代码完全正确**。
 * 本仓的纪律里假红比漏报更坏（`agent-work/verify-anchors.mjs:30-35`），
 * 所以这里付的代价是「并发时排队」，换来的是「每一次调用都真的 pump」。
 *
 * 排队的上界不是无限的：一次 `GET /api/notifications` 本来就要等自己那一份 pump，
 * 而现在最坏要等「前一份 + 自己这份」。前一份的量级来自 MATT-35 实测
 * （稳态 SQL 侧 ~31ms；outbox 积压满 50 行时约 3.5s）——与今天
 * 「两份 pump 撞同一把行锁、各自等在赢家的事务上」是同一量级。
 * 本机实测（共享 dev 库、12 并发 × 4 轮）：单轮最慢 6.2s（= 12 份 pump 串起来），
 * 全部 200、无重复投递、池峰值 13 条（含探针自己与别的进程）。**串行的代价是真的**，
 * 换来的是「读驱动那次 pump 永不被静默跳过」——取舍写在上面那张表里。
 *
 * ## ⚠ 状态必须挂 `globalThis`，模块级 `let` 在这里**静默失效**
 *
 * Next 给 instrumentation entry 与 route handler 各一份模块实例（实测：同一 pid 下
 * 定时器 `inst=w8yu9`、读驱动 `inst=gpra6`）⇒ 模块级的链各有一份，单飞跨不过它们。
 * 详见下面 `globalThis` 那段（含诊断证据）。这是研究文档 §8.2 第 4 条那个
 * 「最小实现」在本仓**不成立**的地方。
 *
 * ## 链上的失败不影响后面
 *
 * `tail` 自己吞掉成败（`.then(dec, dec)`），所以一次失败不会把队列卡死，
 * 也不会变成 `unhandledRejection`；**失败照样原样交给它的调用者**
 * （读驱动那条会让这次 GET 500，与今天一致；定时器那条会记日志且不写心跳）。
 */

/** 一次 pump 的全部计数。三个字段都直接来自服务层现成的返回类型，不另造 DTO */
export type PumpResult = Awaited<ReturnType<typeof pumpNotifications>> & {
  archive: Awaited<ReturnType<typeof scanArchiveIncomplete>>;
};

/** 一次 pump 本体：三个扫描的顺序与 `route.ts` 原来那两行逐字相同 */
async function pumpOnce(): Promise<PumpResult> {
  const { outbox, scan } = await pumpNotifications();
  const archive = await scanArchiveIncomplete();
  return { outbox, scan, archive };
}

/** 链上调用者的身份，**只进日志**（见下） */
export type PumpCaller = "read" | "timer";

/**
 * 单飞的状态挂在 **`globalThis`** 上，不是模块级 `let` —— 这是本轮**实测**出来的硬要求。
 *
 * 诊断证据（同一进程、同一时刻各打一条）：把「模块实例标记」打出来，定时器那一份是
 * `pid=61764 inst=w8yu9`，而读驱动那一份是 `pid=61764 inst=gpra6` ——
 * **同一个 pid、两个模块实例**。原因是 Next 给 instrumentation entry 与每个 route handler
 * 各自一份 bundle/模块图（dev 的 turbopack 与构建产物都如此；instrumentation 是独立 entry，
 * 见 `dist/build/entries.js:189-197`），于是模块级的 `tail` / `pending` 各有一份，
 * 而**单飞跨不过它们** ⇒ 定时器与读驱动照样各跑一份完整 pump。
 *
 * 这一点推翻了 `docs/research-portable-scheduler.md` §8.2 第 4 条给的**最小实现**
 * （「一个模块级 `let inFlight: Promise<void> | null`」）：那个写法在单 entry 的脚本里成立，
 * 在这里**静默失效**——失效形态正是本仓最讨厌的那种：日志里没有排队行，而一切看起来都正常。
 *
 * 挂 `globalThis` 之后它同时是 **HMR 免疫**的：模块重求值不会造出第二条链
 * （要的正是这个——第二条链等于没有单飞）。
 */
type GateState = { tail: Promise<unknown>; pending: number };

/** 键名带前缀，避免与别的 globalThis 使用者撞名（本仓此前没有第二处） */
const GATE_KEY = "__matternest_pump_gate__";

type GlobalWithGate = typeof globalThis & { __matternest_pump_gate__?: GateState };

function gateState(): GateState {
  const g = globalThis as GlobalWithGate;
  g[GATE_KEY] ??= { tail: Promise.resolve(), pending: 0 };
  return g[GATE_KEY];
}

/**
 * 把一个「跑一次」的函数包成「不并发」的版本。
 *
 * 单独导出只为让单测能塞一个**假泵**进来（与 `db/client.ts:56`
 * `assertSessionConventions` 「导出只为让单测能塞一个假池」同一条纪律）：
 * 这条单飞的形态（**排队**而不是跳过）只有能被断言才守得住——而
 * 「两个 gate 实例共用同一条链」那条（`pump-gate.spec.ts`）正是上面 `globalThis` 的守卫。
 *
 * `caller` 只进日志：并发压测要证的**不是**「有过排队」，而是
 * 「**定时器那一份**被排在了读驱动之后」——不带标签的话日志只能证明前者
 * （12 个并发读请求自己就会排成一队），那条判据会退化成一句跑了个寂寞的绿灯。
 */
export function createPumpGate<T>(runOnce: () => Promise<T>): (caller: PumpCaller) => Promise<T> {
  return function gated(caller: PumpCaller) {
    const state = gateState();
    if (state.pending > 0) {
      /**
       * 这一行是「单飞到底生效没有」的**唯一运行时证据**：
       * 排队是正常路径（并发 pump 是常态），但它若**从不出现**，
       * 说明这一段单飞根本没被走过（或者两人同时打开通知中心这件事从没发生过）。
       * 级别用 info：「并发时排队」正是设计要的结果，不是异常。
       */
      console.info(`[pump] ${caller} 这一次排在其后（链上 ${state.pending} 次）`);
    }
    state.pending += 1;
    const run = state.tail.then(runOnce);
    const settled = () => {
      state.pending -= 1;
    };
    // 链尾必须吃掉成败：留下 rejected 的 tail 会让下一次 pump 直接继承失败，
    // 而失败本身已经原样返回给 run 的调用者了（不吞掉、不重复上报）
    state.tail = run.then(settled, settled);
    return run;
  };
}

/**
 * 全局唯一的那道闸：定时器（`src/instrumentation-node.ts`）与读驱动
 * （`api/notifications/route.ts`）共用。⚠ 两者拿到的是**不同的模块实例**
 * （见上面 `globalThis` 那段），所以"共用"靠的是 `globalThis` 上的状态，不是这个变量本身。
 */
export const pumpAll = createPumpGate(pumpOnce);

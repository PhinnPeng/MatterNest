# croner 能否直接确认其状态？——可观测性事实核查

> 研究日期 2026-10-13 · 调研对象 `croner@10.0.1`（npm tarball 实际产物）+ Next.js 16.3.6（`node_modules/next/dist/docs/`）
>
> 承接 `docs/research-portable-scheduler.md`（已确立 `croner@10.0.1` 的选型与 `instrumentation.ts` 的四个前置件）。**本文不重复该文的选型论证**，只回答一个窄问题：**croner 自己能不能报告「我还活着」？**
>
> 一手来源口径：库的能力取自 npm 上 `croner-10.0.1.tgz` 的 `dist/croner.d.ts` 与 GitHub tag `10.0.1`（commit `adc86215e92e4f7cceaf8127dfcd1b514ef7bafc`）的 `src/croner.ts`；行为结论**全部由在本机 Node 22.22.2 上实跑 `croner@10.0.1` 得到**，脚本见附录 A。无二手博客。

---

## 1. 问题

用户直接问：**「croner 能否直接确认其状态」**——即：croner 是否自带一个 API，能让别的代码判断「这个定时器还活着吗」？如果能，数据库心跳表（ticket MATT-74 决定的方案：单行、泵成功后写入时间戳 + 计数、`db:check` 探针在超过 15 分钟时变红，并区分「从未运行」与「已停摆」）是否就不必要了？

---

## 2. 短答

**croner 有一个纯粹进程内的状态查询面（`isRunning()` / `isBusy()` / `isStopped()` / `currentRun()` / `previousRun()` / `msToNext()`），但它没有任何跨进程、跨崩溃、或「上次是否成功」的能力。** 更关键的是三个已核实的事实：**① 没有 `lastRun()` 这个方法**（正确名字是 `previousRun()`），**② `previousRun()` 在回调抛异常时照样前进**——它记录「跑过一次」，不记录「跑成功过」，**③ `isRunning()` 不读取底层 timer 句柄**——把 timer 弄没了它仍然返回 `true`。

因此 croner 的状态面**无法替代**数据库心跳表：`previousRun()` 恰好能回答「上次跑完了没有」，但它活在同一个进程、同一个地址空间里，进程一死它就没了，而这正是需要外部证据的那一种故障。

---

## 3. croner 状态 API 全表

以下签名逐字取自 `croner@10.0.1` 的 `dist/croner.d.ts`，实现取自 tag `10.0.1` 的 `src/croner.ts`。

### 3.1 实例方法（`class Cron<T = undefined>`）

| 方法 | 精确签名（`dist/croner.d.ts`） | 实现位置 | 它能告诉你什么 |
|---|---|---|---|
| `isRunning()` | `isRunning(): boolean` （`:600`） | `src/croner.ts:357-366` | 「**本可触发**」：未 paused ∧ 有回调 ∧ 未 kill ∧ 能算出下一次。**不是**「有活着的 timer」 |
| `isStopped()` | `isStopped(): boolean` （`:606`） | `src/croner.ts:373-375` | `_states.kill` 是否为 true（即是否被 `stop()` 永久停掉） |
| `isBusy()` | `isBusy(): boolean` （`:612`） | `src/croner.ts:382-384` | 回调**此刻是否正在执行中**（`_states.blocking`） |
| `currentRun()` | `currentRun(): Date \| null` （`:618`） | `src/croner.ts:391-393` | 最近一次触发的**开始**时刻；从未跑过为 `null` |
| `previousRun()` | `previousRun(): Date \| null` （`:624`） | `src/croner.ts:400-402` | 最近一次触发的**结束**时刻（见 §4.3）；从未跑过为 `null` |
| `msToNext()` | `msToNext(prev?: CronDate<T> \| Date \| string): number \| null` （`:630`） | `src/croner.ts:409-422` | 距下一次触发的毫秒数；算不出为 `null` |
| `runsLeft()` | `runsLeft(): number \| undefined` （`:667`） | `src/croner.ts:567-569` | `_states.maxRuns` 剩余次数；不限次数时为 `Infinity` |
| `nextRun()` | `nextRun(prev?: CronDate<T> \| Date \| string \| null): Date \| null` （`:548`） | `src/croner.ts`（`nextRun`） | 推算的**下一次**时刻（纯计算，与是否真跑过无关） |
| `nextRuns()` | `nextRuns(n: number, previous?: Date \| string): Date[]` （`:556`） | 同上 | **纯模式推算**的未来 n 次 |
| `previousRuns()` | `previousRuns(n: number, reference?: Date \| string): Date[]` （`:564`） | 同上 | ⚠ **纯模式推算**的过去 n 次，**不是执行历史**（见 §4.6） |
| `stop()` | `stop(): void` （`:637`） | `src/croner.ts:430-447` | 永久停止；置 `kill`、清 timer、从 `scheduledJobs` 摘除 |
| `pause()` | `pause(): boolean` （`:643`） | `src/croner.ts:454-458` | 暂停；返回 `!kill`，即**已死则返回 false** |
| `resume()` | `resume(): boolean` （`:649`） | `src/croner.ts:465-469` | 恢复；返回 `!kill` |
| `trigger()` | `trigger(): Promise<void>` （`:663`） | `src/croner.ts:560-562` | 手动跑一次。**不**走调度、**不**递减 `maxRuns` |

### 3.2 实例属性

| 属性 | 签名 | 可用性 |
|---|---|---|
| `name` | `name: string \| undefined` （`:520`） | 公开可读；给了 `name` 才会进 `scheduledJobs` |
| `options` | `options: CronOptions<T>` （`:521`） | 公开可读，含 `context`、`protect`、`catch` 等全部配置 |
| `_states` | `private _states` （`:522`） | **私有**，TS 层面不可访问；运行时存在，键为 `kill/blocking/previousRun/currentRun/once/currentTimeout/maxRuns/paused/pattern` |
| `fn` | `private fn?` （`:523`） | **私有** |

### 3.3 模块级导出

| 导出 | 签名 | 说明 |
|---|---|---|
| `scheduledJobs` | `scheduledJobs: Cron<any>[]` （`:501`） | 全局命名任务表。**只装 `name` 的任务**（实测：无名任务不进去，具名任务进去且可用 `find(j => j.name === ...)` 取回） |

### 3.4 **不存在**的东西（逐项实测确认）

| 提问里点名的成员 | 是否存在 | 实测依据 |
|---|---|---|
| `lastRun()` | ❌ **不存在** | `typeof job.lastRun === "undefined"`（探针 A）。正确名字是 `previousRun()` |
| `isPaused()` | ❌ **不存在** | `typeof job.isPaused === "undefined"`（探针 A） |
| `onTick` / `emit` / `on` / `off` / `addEventListener` | ❌ **全部不存在** | 五者 `typeof` 均为 `undefined`（探针 A）；`dist/croner.js` 全文 grep `emit\|EventEmitter\|onTick\|process\.on` **零命中** |
| 「上次成功/失败」状态 | ❌ **不存在** | `_states` 只有 9 个键（`src/croner.ts:63-86`），无 `lastError` / `success` / `status`；跑失败后 dump `_states` 与跑成功后完全同形（探针 B） |

---

## 4. 语义与坑（逐条，含出处）

### 4.1 ⚠️ 头号坑：`isRunning()` **不读** timer 句柄

`isRunning()` 的实现（`src/croner.ts:357-366`）：

```ts
public isRunning(): boolean {
  const nextRunTime = this.nextRun(this._states.currentRun);
  const isRunning = !this._states.paused;
  const isScheduled = this.fn !== void 0;
  // msLeft will be null if _states.kill is set to true, so we don't need to check this one, but we do anyway...
  const notIsKilled = !this._states.kill;
  return isRunning && isScheduled && notIsKilled && nextRunTime !== null;
}
```

四个条件里**没有一个**是 `_states.currentTimeout`。而真正持有 timer 的是 `schedule()`（`src/croner.ts:505`）：`this._states.currentTimeout = setTimeout(() => this._checkTrigger(target), waitMs)`。

**实测（探针 C）**：把 `_states.currentTimeout` 置为 `undefined`（模拟 timer 丢失/被 GC/句柄失效）后——

```
X2 armed timer? _states.currentTimeout is an object (setTimeout handle)
X2 isRunning=true isStopped=false
X2 after nulling the timeout handle: isRunning=true msToNext=3201
```

即：**timer 已经没了，`isRunning()` 依然返回 `true`**。它的语义是「**这台机器在配置上允许我触发**」，不是「**有一个活着的定时器在等我**」。

**反向的坑同样存在（探针 D）**：一个 `paused: true` 的任务**确实持有活着的 `setTimeout`**，但 `isRunning()` 返回 `false`：

```
X3 paused job: timer armed? YES ; isRunning=false isStopped=false
```

⇒ **`isRunning()` 在两个方向上都不等价于「timer 活着」**：该 true 时可能没 timer，该 false 时可能有 timer。**它回答的是「我是否被允许触发」，不是「我是否还会触发」。**

### 4.2 `isRunning()` 在 `stop()` 之后 —— **报告里的说法不成立**

**核实结论：`croner@10.0.1` 上，`stop()` 之后 `isRunning()` 返回 `false`，不是 `true`。**

实测（探针 E）：

```
X4 fresh:            isRunning=true  isStopped=false isBusy=false
X4 after 1 run:      isRunning=true  isStopped=false previousRun=2026-10-13T14:28:01.800Z
X4 AFTER stop():     isRunning=false isStopped=true  previousRun=2026-10-13T14:28:01.800Z
```

机制是**双重保险**，两条都成立：

1. `stop()` 置 `_states.kill = true`（`src/croner.ts:434`）⇒ 命中 `notIsKilled = !this._states.kill`；
2. `_next()` 在 `kill` 为真时返回 `null`（`src/croner.ts:643`：`(this._states.kill) ||`）⇒ 命中 `nextRunTime !== null` 失败。

作者自己在 `src/croner.ts:362` 留了注释说明这一点：「msLeft will be null if `_states.kill` is set to true, so we don't need to check this one, but we do anyway...」。

**维护者 issue tracker 上没有对应 issue**：GitHub Search API 对 `repo:Hexagon/croner isRunning` 只返回 1 条结果，是 PR #291（Node 时区 hour-24 修复），与本问题无关（`https://api.github.com/search/issues?q=repo:Hexagon/croner+isRunning&per_page=30&sort=created&order=desc`，取于 2026-10-13）。

> ⚠️ **一条重要的区分**：`isRunning()` 返回 `false` **不能**推出「定时器死了」。它有四种原因，全部返回同一个 `false`：(a) 被 `stop()`；(b) 被 `pause()`；(c) 没传回调函数（`isScheduled` 为假）；(d) 算不出下一次（`maxRuns` 用尽 / `stopAt` 已过 / 模式不可能）。**要区分 (a) 必须另配 `isStopped()`；要区分 (b) 没有 API（`isPaused()` 不存在）。**

### 4.3 ⚠️ `previousRun()` 是「完成时刻」，且**失败也照样前进**

两处独立的坑：

**(a) 它记的是结束时间，不是开始时间、也不是计划槽位。**
`_trigger()` 的收尾（`src/croner.ts:547-554`）：

```ts
} finally {
  this._states.previousRun = new CronDate<T>(initiationDate, this.getTz());
  this._states.blocking = false;
}
```

而 `initiationDate` **永远是 `undefined`**——两个调用点都不传参：`_checkTrigger` 里是 `this._trigger()`（`src/croner.ts:587`，注释明写「We do not await this」），`trigger()` 里是 `await this._trigger()`（`src/croner.ts:561`）。`new CronDate(undefined)` 取当前时刻。实测（探针 F，一个刻意 sleep 200ms+ 的长任务）：

```
T1 during a LONG run: currentRun=14:29:28.293Z previousRun=null
T1 after completion:   currentRun=14:29:28.293Z previousRun=14:29:28.508Z
```

⇒ `previousRun` 是**结束时**的墙上时钟。快任务两者相差不到 1ms（实测 T2 完全相同），**这正是这个区别容易被忽略的原因**。

**(b) 它在 `finally` 里赋值 ⇒ 抛异常也前进。** 因为抛错路径和正常路径共用同一个 `finally`，`previousRun()` **不携带任何成败信息**。实测（探针 B，成功任务与失败任务各跑一次）：

```
F1 success job: previousRun=2026-10-13T14:27:23.318Z isBusy=false
F1 FAILURE job: previousRun=2026-10-13T14:27:23.318Z isBusy=false
```

**结论：croner 只有「上次跑完了没有」，没有「上次跑成了没有」。** 要判成败只能自己在回调体里写。

**(c) 命名有误导性**：`previousRun()` 恒等于「**最近一次**」，不是「前一次」。实测（探针 G，连跑三次）三次的值单调递增贴合最近一次；运行第 N 次期间它持有的是第 N−1 次。**它就是事实上的 `lastRun()`。**

### 4.4 `previousRun()` / `currentRun()` 能否挺过 `stop()`

**能，两者都挺过。** `stop()`（`src/croner.ts:430-447`）只做三件事：置 `kill`、`clearTimeout(currentTimeout)`、从 `scheduledJobs` 摘除。**它不重置任何时间戳。** 实测（探针 H）：

```
S1 previousRun BEFORE stop = 2026-10-13T14:27:23.317Z
S1 previousRun AFTER  stop = 2026-10-13T14:27:23.317Z  -> survives? true
S1 currentRun  AFTER  stop = 2026-10-13T14:27:23.317Z  -> survives? true
S1 isRunning=false isStopped=true
```

⇒ 停掉之后**仍能读到最后的运行时刻**。但这个「存活」是**纯内存的**：进程一退就没了。

### 4.5 `isBusy()` 与 `isRunning()` 的区别

- `isBusy()` = `_states.blocking`（`src/croner.ts:382-384`），在 `_trigger` 开头置 `true`（`:519`）、`finally` 里置 `false`（`:553`）。**只覆盖回调执行期间**。
- `isRunning()` 是**配置态**（能否触发），与回调是否在跑无关。**两者正交**：一个健康运行中的任务是 `isRunning()=true, isBusy()=true`；一个 `paused` 任务是 `isRunning()=false, isBusy()=false`。
- 实测（探针 I，刻意让回调悬挂）：`isBusy=true isRunning=true previousRun=null` ⇒ **`isBusy()=true && previousRun()=null` 是「卡住/仍在跑」的唯一可观测信号**，且它只在**同一进程内**有人去问时才存在。

### 4.6 ⚠️ `previousRuns()` 是**模式推算**，不是执行历史

`previousRuns(n, reference?)`（`dist/croner.d.ts:564`）由 `_enumerateRuns` 从 pattern + 墙上时钟反推。实测（探针 J，一个**从未运行过**的午夜任务）：

```
E1 job NEVER ran. previousRuns(3)=["2026-10-12T16:00:00.000Z","2026-10-11T16:00:00.000Z","2026-10-10T16:00:00.000Z"]
E1   job.previousRun()=null  <- 真正「跑过没有」的信号是 null
```

官方文档也这样标注（`https://croner.56k.guru/usage/examples` 「List previous scheduled runs」节）：「Get previous 5 **scheduled** times (useful for audit/logging)」——**scheduled**，不是 *executed*。

⇒ **绝不能用 `previousRuns()` 判断「泵有没有真的跑」。** 它对「定时器从建立起就没动过」和「跑得好好的」返回同样的数组。**唯一真实的历史信号是 `previousRun()`。**

### 4.7 `pause()` / `resume()` 的返回值是唯一的「死了」信号

二者返回 `!this._states.kill`（`src/croner.ts:457` / `:468`）。实测（探针 K，对已 `stop()` 的任务调用）：`pause()=false resume()=false`。官方示例（`https://croner.56k.guru/usage/examples`「Naming jobs」）也依赖这个返回值判断任务是否已被停掉。

⚠️ 但 `resume()` 有副作用：调用它会把 `paused` 改回 `false`（`src/croner.ts:466`）。**它不是只读探针，不能拿来做健康检查而不产生副作用。**

### 4.8 `maxRuns` 与 `trigger()` 的一个不对称

`maxRuns` 只在**计划触发**时递减（`_checkTrigger`，`src/croner.ts:582-584`）；`trigger()` 走的是 `await this._trigger()`，**不碰 `maxRuns`**。实测（探针 L）：

```
C1 after 1 manual trigger: runsLeft=1 isRunning=false
C1 after 1 SCHEDULED trigger: runsLeft=0 isRunning=false
```

另外实测澄清了一条容易误读的现象：`maxRuns: 1` 的**全新**任务 `isRunning()` 返回的是 **`true`**（不是 false）——`maxRuns=1 > 0`，尚有额度。只有额度耗尽后 `_next()` 才返回 `null`，`isRunning()` 才转 `false`。

---

## 5. 未捕获异常时 croner 做什么，`protect` 到底挡什么

### 5.1 回调抛错

`_trigger()`（`src/croner.ts:526-546`）分两条路：

- **配了 `catch`**：`try { await this.fn(...) } catch (_e) { if (isFunction(this.options.catch)) { try { this.options.catch(_e, this) } catch { /* 静默吞掉 */ } } }`。异常被吞，**定时器继续**。注意 `catch` 回调自身抛错也被静默忽略（`:536-538` 注释：「Silently ignore errors thrown by the catch callback so they do not disrupt the job execution flow or leave the blocking state stuck」）。
- **没配 `catch`**：直接 `await this.fn(...)`，异常逃逸出 `_trigger` 这个 async 函数。而 `_checkTrigger` 调用它时**不 await**（`src/croner.ts:586-587`，注释明写「We do not await this」）⇒ 变成 **`unhandledRejection`**。实测（探针 M）：

```
[B2] unhandledRejection observed: boom-no-catch
[B2] after uncaught throw in callback: isBusy=false previousRun=2026-10-13T14:26:06.217Z <- finally still ran
```

⚠️ 这与 `docs/research-portable-scheduler.md` §6.1② 的既有结论一致且互为印证：**Node ≥15 默认 `--unhandled-rejections=throw`，一次未捕获拒绝会带走整个 Next 进程**；而 `try/catch` 包在 `register()` 外层对 async 回调体无效。**`catch` 选项在这里不是「日志增强」，是「进程存活」的开关。**

无论成败，`finally` 都会执行 ⇒ `blocking` 复位、`previousRun` 前进。**这正是 §4.3(b) 的成因。**

### 5.2 `protect` 挡的是什么

`_checkTrigger`（`src/croner.ts:576-593`）：

```ts
const shouldRun  = !this._states.paused && now.getTime() >= target.getTime(),
      isBlocked = this._states.blocking && this.options.protect;
if (shouldRun && !isBlocked) { /* 递减 maxRuns 并触发 */ }
else { if (shouldRun && isBlocked && isFunction(this.options.protect)) { setTimeout(() => this.options.protect(this), 0); } }
```

⇒ `protect` 挡的**只有一件事**：上一轮回调尚未结束时的**自身重入**（overrun）。它**不**挡与进程内其他代码（如读驱动的请求侧 pump）的并发，也不挡进程崩溃、事件循环阻塞、DB 不可达。

⚠️ 一个容易踩的点：`isBlocked = this._states.blocking && this.options.protect` 的类型是 `boolean | ProtectCallbackFn`。`protect: true` 时被跳过的那一轮**没有任何回调**——静默丢弃。官方示例给的是函数形式以便打印（`https://croner.56k.guru/usage/examples`「Overrun protection」）。**若 pump 每 5 分钟一次而单次耗时超过 5 分钟，`protect: true` 会让超出的轮次静默消失，而 `previousRun()` 仍在前进——从 croner 的状态面上完全看不出发生过丢轮。**

---

## 6. croner 能不能发现自己的失败或自己的缺席？

### 6.1 进程崩溃 / 挂起 / 定时器静默不起 —— 逐条

| 故障形态 | 同进程内是否有 API 能发现 | 依据 |
|---|---|---|
| 进程 crash / OOM / 被 kill | ❌ 无。**进程本身没了，状态面随之消失**，无任何外部可读痕迹 | 全部状态是内存字段（`src/croner.ts:63-86`） |
| 进程 hang（事件循环阻塞） | ❌ 无。定时器不触发 ⇒ `previousRun()` 冻结，但**没有任何代码能跑到去读它** | 阻塞期间事件循环不派发 |
| 回调内部死锁 / 永不 resolve | ⚠️ 只能靠 `isBusy()`——但**必须在同进程内有人去问** | 实测探针 I：`isBusy=true` |
| timer 句柄丢失、`setTimeout` 未被调度 | ❌ **`isRunning()` 察觉不到**（§4.1） | 实测探针 C |
| 从未创建（`register()` 静默 `try/catch` 吞掉异常） | ❌ 无实例可问 | — |
| `maxRuns` 耗尽 | ✅ `isRunning()` 转 `false` + `runsLeft()===0` | 实测探针 L |

### 6.2 根本限制（以及 croner 是否超出了它）

**根本限制成立**：一个进程内的观察者无法报告自己进程的死亡——这是逻辑必然，不是 croner 的缺陷。能突破它的只有**进程外的见证者**：数据库行、文件、metrics endpoint、IPC 消息。

**croner 在这个限制之内没有提供任何额外能力**：没有事件发射器、没有 `onTick`/`onComplete`/`onError` 钩子、没有 metrics 集成、没有心跳上报。检索 `dist/croner.js` 全文，`emit` / `EventEmitter` / `onTick` / `addEventListener` / `process.on` / `heartbeat` / `health` / `monitor` **全部零命中**。

### 6.3 官方是否给出「证明我的定时器在跑」的推荐模式

**没有。** croner 官方文档站只有 6 个页面（`https://croner.56k.guru/` 导航：Overview / Installation / Usage[Basics, Pattern, Configuration, Examples] / Migration / Contributing / Sponsors），GitHub `master` 的 `docs/src/` 目录树里也**只有** `index.md`、`installation.md`、`migration.md`、`contributing.md`、`sponsors.md`、`usage/{basics,pattern,configuration,examples}.md`——**没有任何 health / monitoring / heartbeat 页面**（GitHub trees API 取于 2026-10-13）。

文档里与「状态」最接近的两处，都是**使用示例**而非**推荐模式**：

1. 「Act at completion」（`https://croner.56k.guru/usage/examples`）：
   ```ts
   // Will there be no executions?
   if (!job.nextRun() && !job.previousRun()) {
       console.log('No executions scheduled');
   }
   ```
   —— 这是在**任务内部**用它自己的 `nextRun()/previousRun()` 做判断，不是外部监控。
2. 「Naming jobs」（同页）：用 `name` + `scheduledJobs` 做进程内的具名查找与恢复。

**两者都不是「证明定时器还活着」的机制**——它们都要求观察者与被观察者在同一进程内。

---

## 7. Next.js `instrumentation.ts` 的相关约束

### 7.1 仓库既有认知的复核（对照 `node_modules/next/dist/docs/`）

`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md:18` 原文：

> The file exports a `register` function that is called **once** when a new Next.js server instance is initiated, and must complete before the server is ready to handle requests. `register` can be an async function.

| 既有说法 | 复核结果 |
|---|---|
| `register()` 每 server 实例调用一次 | ✅ 文档明写 "called **once** when a new Next.js server instance is initiated"（`instrumentation.md:18`） |
| `must complete before the server is ready` | ✅ 文档明写（同行）。⚠️ 该文档**未**说明「complete」的确切含义；`docs/research-portable-scheduler.md` §3.1 已从 `dist/esm/server/lib/router-utils/instrumentation-globals.external.js:21-39` 的 `await instrumentation.register()` 推出「完成 = 返回值 settle」，该结论本文复核无误 |
| 可以是 async | ✅ 文档明写 "register can be an async function"（同行） |
| 模块级单例 ⇒ dev HMR 不会起第二份 | ✅ 该文件为 **模块级 `let`** 缓存且全仓无重置（`instrumentation-globals.external.js:6,8-13,50-56`，见既有报告 §3.3）。⚠️ 这条是**读 Next 源码**得出的，不是 `instrumentation.md` 文档写的；文档只在 `02-guides/instrumentation.md` 建议「在 `register` 内部 `await import()`，不要放文件顶部」 |
| Next 文档是否警告不要在 `instrumentation.ts` 里跑长驻定时器 | ❌ **没有警告，也没有任何相反的鼓励**。`instrumentation.md` 全文只谈 `register` 与 `onRequestError` 两个导出，`NEXT_RUNTIME`（`:127`）用于区分 Node/Edge runtime，版本史（`:147-153`）到 `v15.0.0` 为止。**该文件是文档中关于此主题的全部内容** |

### 7.2 一个与可观测性直接相关的、文档里没写的点

`instrumentation.md` 的定位是「integrate **observability tools** into your application」（`:10`）——它是**上报数据**的地方，不是**被观测**的地方。**Next 没有任何内建机制去知道「我注册的 `register()` 里那个定时器还活着吗」**，框架在 `register()` 返回之后就不再持有该函数的任何引用（`extendInstrumentationAfterRegistration()` 之后便与之无关）。

另有一条既有报告已核实、本次复核其前提仍成立的事实：**改了 `instrumentation.ts` 在 dev 下不会热生效**（dev 自动重启只盯 `CONFIG_FILES`，`dist/esm/server/lib/start-server.js:470-472`，且模块缓存永不重置）。这条与可观测性直接相关——**「我改了代码，定时器行为没变」且无任何报错**，正是 croner 状态面帮不上忙的那一类静默故障。

---

## 8. 对「心跳表是否还必要」这个问题，能确定的事实边界

以下**只列事实，不做架构建议**（取舍由项目负责人决定）：

1. **croner 的整个状态面是进程内存字段**（`src/croner.ts:63-86`，共 9 个键）。进程退出 ⇒ 全部归零。
2. **`isRunning()` 不检查 timer 是否存在**（§4.1，实测），因此**它无法区分「timer 健康」与「timer 已丢失但配置仍允许触发」**。
3. **`previousRun()` 不区分成功与失败**（§4.3b，实测），因此**它无法区分「泵跑成功」与「泵抛异常」**——两者产出字节相同的状态。
4. **`previousRun()` 不挺过进程死亡**（§4.4 只证明它挺过 `stop()`；进程死亡是另一回事，状态在内存里）。
5. **没有官方推荐的心跳/健康模式**（§6.3，文档站与 repo 的 `docs/src/` 均无此内容）。
6. **croner 没有事件发射器或钩子**可供外部订阅（§6.2，grep 零命中 + 运行时 `typeof` 实测）。

⇒ 就「croner 自身提供的证据」而言：它能覆盖「**这一轮回调有没有开始/结束**」和「**我是否被配置允许继续触发**」，但**不能**覆盖「**上一轮有没有成功**」与「**我所属的进程是否还活着**」。后两者恰好是跨进程探针要回答的问题。

---

## 9. 一手来源清单

**croner@10.0.1（一手产物）**

- npm tarball `croner-10.0.1.tgz`（`npm pack croner@10.0.1`，取于 2026-10-13），解包得：
  - `package/dist/croner.d.ts`：`:501`（`scheduledJobs`）、`:519-691`（`class Cron` 全体成员）、`:548,556,564,581,588,594,600,606,612,618,624,630,637,643,649,655,663,667`
  - `package/dist/croner.js`：全文 grep `isRunning|isStopped|isBusy|_states|scheduledJobs|pause|resume|msToNext`；grep `onTick|emit|EventEmitter|addEventListener|process\.on|health|heartbeat|monitor` **零命中**
  - `package/README.md`：`:112`（Status 节起始）、`:117-126`（Status 逐条）、`:139`（stop 与 scheduledJobs）、`:152`（name）、`:165`（protect）
  - `package/package.json`：`:36`（`engines.node >=18.0`）、`:53-70`（exports/types）
- GitHub tag `10.0.1`（commit `adc86215e92e4f7cceaf8127dfcd1b514ef7bafc`），`src/croner.ts`：
  - `:57`（`scheduledJobs` 定义）、`:63-86`（`CronState` 全部 9 个字段）、`:109-113`（`class Cron` 成员可见性）
  - `:357-366`（`isRunning`）、`:373-375`（`isStopped`）、`:382-384`（`isBusy`）、`:391-393`（`currentRun`）、`:400-402`（`previousRun`）、`:409-422`（`msToNext`）
  - `:430-447`（`stop`）、`:454-458`（`pause`）、`:465-469`（`resume`）、`:476-513`（`schedule`，`:505` 为 `setTimeout`）、`:518-555`（`_trigger`，`:527-546` 错误分支、`:547-554` finally）、`:560-562`（`trigger`）、`:567-569`（`runsLeft`）、`:576-597`（`_checkTrigger`）、`:602-643`（`_next`，`:643` 的 kill 短路）
- 运行时实测：Node **v22.22.2** + `croner@10.0.1`（`npm install` 后本地安装），脚本见附录 A，**结论均可复现**

**croner 官方文档与仓库（取于 2026-10-13）**

- `https://croner.56k.guru/`（首页 Features 与导航结构；无 health/monitoring 入口）
- `https://croner.56k.guru/usage/configuration`（全部配置项表）
- `https://croner.56k.guru/usage/examples`（「List previous scheduled runs」「Job controls」「Act at completion」「Naming jobs」「Error handling」「Overrun protection」六节全文）
- `https://api.github.com/repos/Hexagon/croner/git/trees/master?recursive=1`（确认 `docs/src/` 下**无** health/monitoring 文档）
- `https://api.github.com/repos/Hexagon/croner/tags?per_page=15`（确认 `10.0.1` tag 存在及其 commit sha）
- `https://api.github.com/search/issues?q=repo:Hexagon/croner+isRunning&per_page=30&sort=created&order=desc`（`total_count: 1`，唯一命中为 PR #291「Fix Node.js timezone test failures caused by hour 24 midnight formatting」，与本问题无关）
- `https://api.github.com/search/issues?q=repo:hexagon/croner+isRunning+in:title,body&per_page=25`（`total_count: 0`）

**Next.js 16.3.6（`node_modules/next/`）**

- `dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`：`:10`（定位为 observability 集成）、`:18`（register once / must complete / can be async）、`:127`（NEXT_RUNTIME）、`:147-153`（版本史）
- `dist/docs/01-app/02-guides/instrumentation.md`（register 内部 import 的官方建议，既有报告 §3.3 已引 `:52-68`）
- `dist/esm/server/lib/router-utils/instrumentation-globals.external.js`（模块级缓存 `:6,8-13` / `await register()` `:21-39` / promise 缓存 `:50-56`）——经既有报告引用，本次未重新逐行复核，见 §7.1 的限定语
- `dist/esm/server/lib/start-server.js:470-472`（dev 重启只盯 CONFIG_FILES）

**本仓**

- `package.json`：全文 grep `croner` **零命中**；`scripts.db:check = "node tools/db-check.mjs"`
- `src/instrumentation.ts`：**当前不存在**（`Test-Path` 为 false）
- `docs/`：grep `MATT-74` **零命中**——该工单号目前只存在于本任务描述中，仓库内无对应记录

---

## 10. 未解 / 无法核实的问题

1. **「croner 在 stop 后仍报告 running」的说法，我无法复现，也找不到出处。** 在 10.0.1 上实测为 `isRunning()=false`（§4.2），源码有两重保证，且维护者 tracker 无此 issue。**但我没有排查这个说法的来源**——它可能来自更早的 croner 版本（例如 6.x/7.x 的实现），也可能来自把 `isRunning()` 与 `isBusy()` 混为一谈。**若该说法在本项目内有具体出处，值得回溯出处再下结论。**
2. **`isRunning()` 与 `msToNext()` 的一致性未做穷举验证。** 我验证了「两者都由 `_next()` 派生」，但没有遍历 `maxRuns`/`startAt`/`stopAt`/`interval`/`once` 各组合下二者是否可能分叉。
3. **`unref: true` 与 Next 进程共存的边界未测。** 既有报告已指出 Next 本身常驻、影响有限；我没有实测「unref 后 Next 进程是否可能提前退出」。
4. **croner 的 `previousRun()` 在跨 DST 场景下的取值未测。** `Asia/Shanghai` 自 1991 年起无夏令时，本项目走不到该分支，但结论不外推到有 DST 的时区。
5. **未评估 pm2 / Uptime Kuma / ZWave JS / TrueNAS 这四个 croner 官方案例项目如何做健康检查**（croner 首页 Features 列出）。它们是下游用法而非 croner 的一手文档，但可能存在可借鉴的模式。**若需要，这是下一步最值得查的方向。**
6. **未核实 croner 11.x（`11.0.0-dev.*` 已存在的 tag）是否改动了状态面。** 本文全部结论限定于 `10.0.1`。

---

## 附录 A：实测脚本

全部脚本位于 `%TEMP%\opencode\croner-probe\`，环境 Node v22.22.2 + `croner@10.0.1`（本地 `npm install`）。

| 脚本 | 验证的结论 | 本文小节 |
|---|---|---|
| `probe.mjs` | 方法清单、无 `lastRun`/`isPaused`/`onTick`、无名任务不进 `scheduledJobs`、`stop()` 后 `isRunning()=false` | §3.4、§4.2 |
| `probe2.mjs` | `stop()` 前后状态、`previousRun()` 在失败时前进、`maxRuns` 行为、`previousRuns()` 是纯推算 | §4.3、§4.6 |
| `probe3.mjs` | `previousRun`/`currentRun` 挺过 `stop()`、成功与失败状态同形、`_states` 无错误字段、`isBusy()` 是悬挂的唯一信号 | §4.4、§4.5、§6.2 |
| `probe4.mjs` | **`isRunning()` 不读 `currentTimeout`**（置空后仍 true）、paused 任务持有 timer 却 `isRunning()=false`、**stop 后 `isRunning()=false`**、死任务 `pause()/resume()` 返回 false | §4.1、§4.2、§4.7 |
| `probe5.mjs` | `previousRun` 记的是**完成**时刻、`previousRun()` 恒为「最近一次」 | §4.3 |

复现方式：

```powershell
cd $env:TEMP\opencode\croner-probe
npm init -y; npm install croner@10.0.1
node probe4.mjs
```

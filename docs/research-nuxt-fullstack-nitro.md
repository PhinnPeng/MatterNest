# 调研：Nuxt 全栈（Nitro server routes 作为后端）主张核验

> 状态：**已完成，一手来源核验**。对应 `tech-stack-decision.md` §11（备选路线：Nuxt 全栈）与 §11.4 的 spike S1/S2。
> 本文只做事实核验，不改代码、不改 §2 的结论表。每条主张标注 **VERIFIED / PARTIALLY VERIFIED / NOT SUPPORTED / UNABLE TO CONFIRM**。

---

## 0. 版本基线（先钉死，后面所有结论都挂在这组版本上）

用 npm registry 直接解析依赖树（`https://registry.npmjs.org/<pkg>/latest`），2026-09 实测：

| 包 | 版本 | 说明 |
|---|---|---|
| `nuxt` | **4.5.2** | 当前 latest；Nuxt 5 仍是 development（`future.compatibilityVersion: 5`） |
| `@nuxt/nitro-server` | 4.5.2 → 依赖 `nitropack ^2.13.4` + `h3 ^1.15.11` | **Nuxt 用的是 Nitro 2，不是 Nitro 3** |
| `nitropack` | **2.13.4** | Nitro v2 稳定线；自身依赖 `croner ^10.0.1`、`unenv 2.0.0-rc.24` |
| `nitro`（Nitro 3） | 3.0.260903-beta | 仍是 beta；`nitro.build` 文档站已经改成**只描述 Nitro 3** |
| `h3` | 1.15.11（dist-tag `1x`）；latest dist-tag 是 2.0.1-rc.32 | Nuxt 用 1.x |
| `drizzle-orm` | **0.45.3** | |
| `drizzle-kit` | **0.31.11** | |

**由此得出的第一条注意**：`nitro.build/docs/tasks` 现在讲的是 Nitro 3 beta 的 API（`import { defineTask } from "nitro/task"`、`defineHandler`、`nitro task list`）。Nuxt 4.5.2 实装的是 `nitropack@2.13.4`（`import { defineTask } from 'nitropack'`／自动导入、`nitro.experimental.tasks`）。v2 文档站（`nitro.unjs.io`）已不可达，本文对 Nitro v2 的引用一律指向官方仓库 **`nitrojs/nitro` 的 `v2` 分支文档** 与 **`nitropack@2.13.4` 的已发布产物源码**（两者都是一手来源）。h3 v1 文档站地址是 `https://v1.h3.dev/`（`h3.dev` 已是 v2）。

核验方法（可复现）：

1. Nuxt / Nitro / h3 官方文档站直接取 markdown 原文：`https://nuxt.com/raw/docs/4.x/<page>.md`、`https://nitro.build/raw/docs/<page>.md`，以及整站 `https://nuxt.com/llms-full.txt`、`https://orm.drizzle.team/llms-full.txt`。
2. Nitro/h3/drizzle 的行为断言，除文档外一律用 **npm tarball 里的发布产物**（`nitropack@2.13.4/dist/**`、`h3@1.15.11/dist/index.mjs`、`drizzle-orm@0.45.3/pg-core/*.d.ts`）核对，不看第三方文章。
3. Drizzle DDL 一项做了**实机生成**：临时目录 `npm i drizzle-orm@0.45.3 drizzle-kit@0.31.11` + `npx drizzle-kit generate`，把生成的 SQL 原文贴在下面（未写入本仓库）。

---

## 1. `shared/` 目录与 `#shared` 别名 —— **VERIFIED**

来源：
- https://nuxt.com/docs/4.x/directory-structure/shared （原文：`https://nuxt.com/raw/docs/4.x/directory-structure/shared.md`）
- https://nuxt.com/docs/3.x/directory-structure/shared
- https://nuxt.com/docs/4.x/getting-started/upgrade
- https://nuxt.com/docs/4.x/directory-structure/server

### 1.1 能否被 app 与 `server/api/` 双向导入：能

> "The `shared/` directory allows you to share code that can be used in both the Vue app and the Nitro server."

文档给出的正是我们想要的用法：`shared/utils/capitalize.ts` 同时被 `app/app.vue` 与 `server/api/hello.get.ts` 使用（两侧示例都在页上）。

### 1.2 引入版本与稳定性

> "The `shared/` directory is available in **Nuxt v3.14+**."

- 未标注 experimental，无 feature flag。唯一的功能门槛在 **Nuxt 3**：3.x 页面写明自动导入默认不开——
  > "Auto-imports are not enabled by default in Nuxt v3 to prevent breaking changes in existing projects. To use these auto-imported utils and types, you must first set `future.compatibilityVersion: 4` in your `nuxt.config.ts`."
- 在 **Nuxt 4**（本项目会用的版本）无此限制，`shared/utils/`、`shared/types/` 默认自动导入。

### 1.3 文档明示的限制（比传闻更严）

| 限制 | 原文 |
|---|---|
| 不能 import Vue / Nitro 代码 | "Code in the `shared/` directory **cannot import any Vue or Nitro code**." |
| 原因（两个独立 bundle） | "Nuxt builds two separate bundles: the Vue app (client and server-side rendering) and the Nitro server (API routes, server middleware, server plugins). They are bundled independently and run in different contexts." |
| Node / server-only 代码不能进客户端 | "Server-only code (such as Node APIs, Nitro utilities, or server route handlers) **must not run in the browser**. Importing it into your app can break the client build … or leak server logic into the client bundle." |
| 只有两个目录被扫描 | "Only files in the `shared/utils/` and `shared/types/` directories will be auto-imported. Files nested within subdirectories of these directories will **not** be auto-imported unless you add these directories to `imports.dirs` and `nitro.imports.dirs`." |
| 其余文件用别名显式导入 | "Any other files you create in the `shared/` folder must be manually imported using the `#shared` alias (automatically configured by Nuxt)" —— `import capitalize from '#shared/capitalize'` |
| `server/` 侧的镜像约束 | `server` 页：`Do not import Vue app code (components, composables, or other app-only utilities) in your server routes or utilities, and do not import server-only code in your app.` |

**要点**：`shared/` 的合法内容是「纯 TS：类型、常量、枚举、无副作用的纯函数、Zod schema」。这条对 §11.2 的「枚举/DTO 单一事实源」是**正面**的；但它也意味着 shared 里**不能**放任何依赖 `useRuntimeConfig`、`defineEventHandler`、Vue 运行时的东西。跨边界的 `import type` 文档明确「may appear to work」但建议仍放 `shared/types/`。

### 1.4 Nuxt 4 目录布局变了没有？变了，但不影响 `shared/` 与 `#shared`

Upgrade 指南（Nuxt 4 章节）：

> "the new Nuxt default `srcDir` is `app/` by default" / "`serverDir` now defaults to `<rootDir>/server` rather than `<srcDir>/server`" / "a new `shared/` directory is available for code shared between the Vue app and the Nitro server"
> "Make sure your `nuxt.config.ts`, `content/`, `layers/`, `modules/`, `public/`, **`shared/`** and **`server/`** folders **remain outside the `app/` folder**, in the root of your project."
> "the `~` alias now points to the `app/` directory by default (your `srcDir`)"

- `#shared` 别名在 4.x 文档中仍是当前写法（未改名）；另有 `#server` 别名（**v4.3** 起）但只能用于 `server/` 内部：`The #server alias can only be used within the server/ directory. Importing from #server in client code will result in an error.`
- 迁移非强制：`migration is *not required*. If you wish to keep your current folder structure, Nuxt should auto-detect it.` 例外是自定义 `srcDir` 的情况。

结论：**S1 通过**。枚举/DTO 单源这件事不需要跨 package。

---

## 2. Nitro scheduled tasks —— **PARTIALLY VERIFIED**（多副本重复触发在代码层已确认，文档没有明说）

来源：
- Nitro v2 官方文档（对应 Nuxt 4.5 实装的 nitropack 2.x）：https://github.com/nitrojs/nitro/blob/v2/docs/1.guide/10.tasks.md
- Nitro v3 文档（当前站点）：https://nitro.build/docs/tasks
- 产物源码：`nitropack@2.13.4/dist/runtime/internal/task.mjs`、`dist/presets/node/runtime/node-server.mjs`、`dist/presets/node/runtime/node-cluster.mjs`、`dist/core/index.mjs`
- Nuxt 侧：https://nuxt.com/docs/4.x/directory-structure/server （`nitro` 透传 + 警告）

### 2.1 声明方式与准确选项名（nitropack 2.13.4）

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  nitro: {
    experimental: { tasks: true },        // 必需：tasks 仍是实验特性
    scheduledTasks: {                     // 选项名就是 scheduledTasks（不是 tasks.cron，也不是 cronite）
      '0 3 * * *': ['reminder:scan'],     // cron -> task 名数组；也接受单个字符串
    },
  },
})
```

```ts [server/tasks/reminder/scan.ts]  // 路径名拼接为 task 名：reminder:scan
export default defineTask({
  meta: { name: 'reminder:scan', description: '节点到期扫描' },
  run({ payload, context }) {
    // payload.scheduledTime 由调度器注入
    return { result: 'ok' }
  },
})
```

文档原文：`Tasks support is currently experimental.`（v2、v3 两版都这么写，并挂 `nitrojs/nitro#1974`）。形状：`scheduledTasks` 把 cron 表达式映射到「单个 task 名字符串或数组」；v3 文档补了一句 `When multiple tasks are assigned to the same cron expression, they run in parallel.`，以及调度触发时 payload 自动带 `scheduledTime`。

`defineTask` / `runTask` 在 server 上下文里是**自动导入**的（`nitropack@2.13.4/dist/core/index.mjs` 的 imports 表：`{ from: "nitropack/runtime/internal/task", imports: ["defineTask", "runTask"] }`），无需 import 语句。

**平台支持（v2 原文）**：`dev`, `node-server`, `bun`, `deno-server` 由 **croner** 引擎驱动；`cloudflare_module` 用原生 Cron Trigger。（v3 文档额外列出 `node_cluster`。）我们目标 preset 是 `node-server` → 走 croner，即**进程内定时器**。

### 2.2 手动触发：`nitro run-task` 已经改名，而且是 dev-only

- 旧写法 `nitro run-task <name>` 在 2.13.4 里**不存在**。CLI 子命令是 `nitro task list` / `nitro task run <name> --payload "{}"`（v2 文档 + `dist/cli/index.mjs`、`dist/cli/run.mjs` 实测）。
- 且它是 **dev 专用**：`dist/cli/run.mjs` 调用 `nitropack/core` 的 `runTask`，后者 `POST` 到 `/_nitro/tasks/<name>`，而 `_getTasksContext()` 要求 `.nitro/nitro.json` 里有活着的 dev pid，否则抛 `Missing info file ... (is dev server running?)`。文档同样写明：`It is only possible to run these commands while the dev server is running.`
- 生产环境要手动触发，只能自己写鉴权后的 handler 调 `runTask()`——文档示例正是这么教的（`// IMPORTANT: Authenticate user and validate payload!`）。`/_nitro/tasks*` 端点也属于 dev server。

### 2.3 关键问题：多副本会不会重复触发？——会，N 份进程 = N 次

**文档层面**：v2 文档没有正面回答这个问题，只写了并发生命周期：
> "Each task can have **one running instance**. Calling a task of same name multiple times in parallel, results in calling it once and all callers will get the same return value."
> "Nitro tasks can be running multiple times and in parallel."

Nitro v3 文档把「per server instance」写明了（这正是我们关心的限定语）：
> "Task runs are deduplicated by **task name**: each task can have at most one running instance **per server instance**."

**代码层面（一手、决定性）**，`nitropack@2.13.4/dist/runtime/internal/task.mjs`：

```js
const __runningTasks__ = {};                 // 模块级 Map：去重只在单个进程内有效
export function startScheduleRunner() {
  if (!scheduledTasks || scheduledTasks.length === 0 || isTest) return;
  for (const schedule of scheduledTasks) {
    const cron = new Cron(schedule.cron, async () => { /* runTask(...) */ });
  }
}
```

`dist/presets/node/runtime/node-server.mjs`（生产入口，模块顶层执行）：

```js
if (import.meta._tasks) {
  startScheduleRunner();
}
```

即：**每个跑起来的 Node 进程都会注册自己的 croner 定时器**。Docker Compose 里 `replicas: 3` → 同一分钟触发 3 次；用 `node_cluster` preset 更糟，`node-cluster.mjs` 里 `Number.parseInt(process.env.NITRO_CLUSTER_WORKERS) || os.cpus().length` 个 worker 各自 fork、各自跑 node-server 入口 → 触发次数 = worker 数。`__runningTasks__` 去重救不了（进程私有）。

**结论**：`pg_try_advisory_lock` 单飞**不是可选项，是必需项**（§3.5 的方案在这条上不用改）。同时 `isTest` 短路说明测试环境调度器默认不跑。

### 2.4 task 与 API 路由是否同一 runtime/deployment：是

- task 从 `server/tasks/` 扫描，与 `server/api/` 打进**同一个 server bundle**；调度器在同一个进程模块顶层启动（见 2.3）。
- 因此 task 里 `import` 的模块级单例（Drizzle `pg` 连接池、`useRuntimeConfig()`）与 API 路由是**同一份**。文档给的正向证据：`server/api/migrate.ts` 直接 `await runTask("db:migrate", { payload })` —— 同进程函数调用，不是跨服务 RPC。
- 反向含义（要写进约定）：定时扫描与请求处理**共享事件循环与连接池**。扫描里跑重 SQL/大事务会直接抬 p99 延迟；扫描失败会在同进程里 `console.error('Error while running scheduled task ...')`（源码里 catch 掉了，不会 crash 进程，但也没有重试/告警原语）。

### 2.5 Nuxt 文档里查不到 tasks

`nuxt.com/docs/4.x/directory-structure/server` **没有** Server Tasks 章节（3.x 也没有）；Nuxt 全站文档 grep `scheduledTasks` 为 0 命中。Nuxt 只给了透传口：

```ts
export default defineNuxtConfig({
  // https://nitro.build/config
  nitro: {},
})
```

并附带一条对我们做技术债预算很重要的警告：
> "This is an advanced option. Custom config can affect production deployments, as the configuration interface might change over time **when Nitro is upgraded in semver-minor versions of Nuxt**."

即：**定时任务这一层是建立在「实验特性 + 随 Nuxt minor 版本可能变动的配置面」之上**，而且 Nuxt 官方文档不负责解释它。

---

## 3. SPA / 关闭 SSR —— **VERIFIED**

来源：https://nuxt.com/docs/4.x/guide/concepts/rendering

- 全局：`export default defineNuxtConfig({ ssr: false })` —— 原文 `You can enable client-side only rendering with Nuxt in your nuxt.config.ts`。
- 按路由：`routeRules`，官方示例正是后台场景 `'/admin/**': { ssr: false }`，属性表里写 `ssr: boolean - Disables server-side rendering of the HTML for sections of your app and make them render only in the browser`。
- 文档明确的**必备配套**（不是可选）：
  > "If you do use `ssr: false`, you should also place an HTML file in `~/spa-loading-template.html` with some HTML you would like to use to render a loading screen that will be rendered until your app is hydrated."
- 已文档化的取舍：CSR 的缺点列表为 Performance（"The user has to wait for the browser to download, parse and run JavaScript files"）、SEO、Offline；优点里第一条直接点名我们的场景 —— "**Development speed**: … we don't have to worry about the server compatibility of the code"，并且 "good choice for heavily interactive **web applications** … such as **SaaS, back-office applications**"。
- 一个 build 期行为（对包体有利，但要理解）：`ssr: false` 覆盖的 page 会被从 server bundle 里剔除；只要有任何路径可能在服务端渲染它（例如 `''/admin/**': {ssr:false}` 又叠加 `'/admin/report': { ssr: true }'`、页面有 alias、父壳渲染仍走 SSR 的子页），就仍然保留。原文标注 `This is a build-time optimization only`。

**admin dashboard 的实际坑（文档支撑 + 明确标注为推断）**：
1. 首屏是空壳 HTML + loading 模板，`ssr: false` 时**没有任何服务端渲染的 HTML 可用来做「未登录直接 302」**。文档只承诺了「渲染直到 hydrate 前用 spa-loading-template 的内容」；因此**登录跳转必然发生在客户端**（Nuxt app middleware），用户会先看到一帧空白/loading。规避方式是把鉴权判断前移到 `server/middleware`（对 `/api/**` 生效）或让根路由先渲染一个极小的登录壳——这两条是我方的架构推论，不是文档保证。
2. hydration：`ssr: false` 无 SSR 阶段，不存在 hydration mismatch 类问题（文档的 CSR 描述即「Vue.js generates HTML elements after the browser downloads and parses all the JavaScript」）。反过来说，`<ClientOnly>` / `NuxtClientFallback` 这类为 SSR 服务的组件在这个模式下不需要。
3. 内部系统无 SEO 需求 → 文档列出的 CSR 缺点对本项目基本不成立。§11.1 对理由①的「撤回」判断，与文档一致。

---

## 4. server middleware 语义与错误处理 —— **VERIFIED**

来源：
- https://nuxt.com/docs/4.x/directory-structure/server （Server Middleware / Error Handling / Status Codes）
- https://github.com/nitrojs/nitro/blob/v2/docs/1.guide/2.routing.md （Middleware / Error handling）
- https://v1.h3.dev/guide/event-handler （h3 v1：Middleware / Error Handling）
- 产物源码：`h3@1.15.11/dist/index.mjs`（`createAppEventHandler`、`createError` 的 JSDoc）、`nitropack@2.13.4/dist/runtime/internal/app.mjs`、`dist/runtime/internal/error/prod.mjs`、`dist/rollup/index.mjs`

### 4.1 middleware：每个请求都跑（含未匹配路由），可以短路，但**不该**短路

Nuxt 文档：
> "Middleware handlers will run on **every request before any other server route** to add or check headers, log requests, or extend the event's request object."
> "Middleware handlers **should not return anything** (nor close or respond to the request) and only inspect or extend the request context or throw an error."

Nitro v2 文档（更直白）：
> "Middleware are defined exactly like route handlers with the only exception that they **should not return anything**. Returning from middleware behaves like returning from a request - **the value will be returned as a response and further code will not be ran**."
> "Returning anything from a middleware will close the request and should be avoided! Any returned value from middleware will be the response and further code will not be executed however **this is not recommended to do!**"
> "Middleware are executed on every request."（要限定作用域需自己在 handler 里判断 path）
> 执行顺序：`Middleware are executed in directory listing order`，可用数字前缀控制（并注意字符串排序，10 会排在 1 后面）。

源码层确认「未匹配路由也会跑」：`nitropack/dist/runtime/internal/app.mjs` 里，middleware 通过 `h3App.use(middlewareBase, handler)` 注册，路由则是后面的 `router` 层（`h3App.use(config.app.baseURL, router.handler)`）；`h3@1.15.11` 的 `createAppEventHandler` 按 stack 顺序执行，全部 layer 跑完仍未 handled 才 `throw createError(...)`（404）。所以 `server/middleware/*` 一定在 404 之前执行。
h3 v1 文档另有态度性建议：`Middleware pattern is not recommended for h3 in general. Side effects can affect global application performance and make tracing logic harder.` → 我们的横切约束（scope 判定、审计）更适合**显式包装函数**，middleware 只做识别/上下文注入，与 §11.2「显式 `withScope(event, handler)`」的判断一致。

### 4.2 精确状态码：完全可控

Nuxt 文档：`To return other error codes, throw an exception with createError`：

```ts
throw createError({ status: 400, statusText: 'ID should be an integer' })
```

h3 1.15.11 的 `createError` 入参（发布产物 JSDoc 原文示例）：

```
throw createError({
  statusCode: 400,
  statusMessage: "Bad Request",
  message: "Invalid input",
  data: { field: "email" }
});
```
签名接受 `Partial<H3Error> & { status?: number; statusText?: string }`，即 `statusCode`/`status`、`statusMessage`/`statusText` 两套都合法 —— 任务书里写的 `createError({ statusCode: 404 })` **成立**。非错误路径的状态码用 `setResponseStatus(event, 202)`（Nuxt 文档 Status Codes 节）。`sendError` 也存在（h3 导出列表内）。

JSDoc 里有一条对我们设计错误契约很关键：
> "In a client-server context, using a short `statusMessage` is recommended because it can be accessed on the client side. Otherwise, a `message` passed to `createError` on the server will not propagate to the client (you can use `data` instead). Consider avoiding to put dynamic user input to the message…"

### 4.3 生产环境会不会泄漏 stack：不会（默认 prod handler 根本没有 stack 字段）

`nitropack@2.13.4/dist/runtime/internal/error/prod.mjs` 全文实测，响应体固定为：

```js
const body = {
  error: true,
  url: url.href,
  statusCode,               // error.statusCode || 500
  statusMessage,            // error.statusMessage || "Server Error"
  message: isSensitive ? "Server Error" : error.message,
  data: isSensitive ? void 0 : error.data,
};
```
其中 `const isSensitive = error.unhandled || error.fatal;`，且敏感错误只 `console.error` 到服务端日志：
```
[request error] ${tags} [${event.method}] ${url}
```
- **payload 里没有 `stack`**；未捕获的原生 `Error`（`message` 常含 SQL/表名/连接串）被降级为 `message: "Server Error"`，`data` 抹掉。
- `statusCode` 直接取自 error → **404 与 403 完全可控**，把「不可见资源」统一 `createError({ statusCode: 404 })` 抛出即可，Nitro 不会改写它。
- 响应头由 handler 固定加上 `x-content-type-options: nosniff`、`x-frame-options: DENY`、`content-type: application/json`、`cache-control: no-cache`（404 或无 cache-control 时）。
- dev 才用 youch（`dist/runtime/internal/error/dev.mjs` 里 `stack: error.stack?.split("\n")…`），由 `nitro.options.dev` 决定选哪个：`internal/error/${nitro.options.dev ? "dev" : "prod"}`（`dist/rollup/index.mjs`）。
- 自定义出口：`nitro.errorHandler`（类型 `string | string[]`）注册的 handler 会**先于**内置 handler 执行，可拿到 `{ defaultHandler }`，`event.handled` 后短路。Nuxt 侧写 `nitro: { errorHandler: '~/server/error-handlers/...' }`。

### 4.4 两条必须写进约定的诚实提醒（文档没有保证的东西）

1. **payload 形状是实现细节**：上面那套 `{ error, url, statusCode, statusMessage, message, data }` 只存在于 nitropack 产物源码，Nitro v2/Nuxt 文档没有把它列为稳定契约。Nitro v2 routing 文档说明错误**呈现形式随路径变化**：`For most routes Content-Type is set to text/html by default and a simple html error page is delivered. If the route starts with /api/ ... the default will change to application/json`，并且「This behaviour can be overridden by some request properties (e.g.: `Accept` or `User-Agent` headers)」。→ 我们的 API 必须全部落在 `/api/**` 下，并且**自建一个统一错误封装函数**（唯一允许 `throw` 的入口），不要依赖框架 payload。
2. **404 重定向特例**：prod handler 里有一段——当配置了非 `/` 的 `app.baseURL` 且请求路径不在 baseURL 下时，statusCode 404 会被**改成 302 Found**。默认 baseURL `/` 不触发；若以后把 app 挂在子路径下，需要回归验证「不可见资源仍返回 404」。

---

## 5. Drizzle ORM 的 DDL 覆盖度（含 `drizzle-kit generate` 实测）—— **VERIFIED（一处语法须更正，两处有已知坑）**

来源：
- 类型定义（发布产物）：`drizzle-orm@0.45.3/pg-core/indexes.d.ts`、`checks.d.ts`、`foreign-keys.d.ts`、`pg-core/columns/common.d.ts`
- 文档：https://orm.drizzle.team/docs/pg/indexes-constraints 、 /docs/pg/generated-columns 、 /docs/faq 、 /docs/pg/drizzle-kit-push 、 /docs/pg/drizzle-kit-generate 、 /docs/pg/drizzle-kit-migrate 、 /docs/pg/relations-schema-declaration
- PostgreSQL：https://www.postgresql.org/docs/15/sql-createindex.html#SQL-CREATEINDEX-PARTIAL 、 https://www.postgresql.org/docs/current/ddl-generated-columns.html
- 实机生成：临时工程 `drizzle-orm@0.45.3` + `drizzle-kit@0.31.11`，`npx drizzle-kit generate`

### 5.1 逐项 DSL 能力

| 目标 DDL | DSL 可表达？ | 一手依据 |
|---|---|---|
| partial **unique** index | ✅ `uniqueIndex(name).on(...).where(sql\`…\`)` | `indexes.d.ts`：`class IndexBuilder { concurrently(): this; with(obj): this; **where(condition: SQL): this** }`；`declare function uniqueIndex(name?: string): IndexBuilderOn`；文档 `Indexes & Constraints` 的参数表列有 `.where(sql\`\`)`；`IndexConfig.where?: SQL` 注释为 "Condition for partial index" |
| partial 非 unique index | ✅ 同上（`index(name)` 走同一个 `IndexBuilder`） | 同上 |
| 表级 CHECK | ✅ `check(name, sql\`…\`)` | `checks.d.ts`：`declare function check(name: string, value: SQL): CheckBuilder`；文档示例 `check("age_check1", sql\`${table.age} > 21\`)` → `CONSTRAINT "age_check1" CHECK ("age" > 21)` |
| `GENERATED ALWAYS AS (…) STORED` | ✅ **但没有 `.stored()`** | `pg-core/columns/common.d.ts`：`generatedAlwaysAs(as: SQL \| T['data'] \| (() => SQL)): HasGenerated<this, …>` —— **只接受一个参数，无 config，无链式 `.stored()`** |
| FK `SET NULL` / `CASCADE` | ✅ | `foreign-keys.d.ts`：`type UpdateDeleteAction = 'cascade' \| 'restrict' \| 'no action' \| 'set null' \| 'set default'`；`ForeignKeyBuilder.onUpdate()/onDelete()`；列级 `references(ref, { onDelete, onUpdate })` |

**语法更正（重要）**：任务书里的 `generatedAlwaysAs(...).stored()` 在 PostgreSQL dialect 下**不存在**。实测 `.stored()` 直接抛：
`TypeError: (0 , import_pg_core.text)(...).generatedAlwaysAs(...).stored is not a function`。
原因也写进文档了：Postgres 侧 "Types: `STORED` only"（并链接 PG 官方 generated-columns 文档）。跨列表达式要用**回调形式**（文档原话：`**callback** - if you need to reference columns from a table`）：

```ts
generatedName: text("gen_name").generatedAlwaysAs((): SQL => sql`'hi, ' || ${test.name} || '!'`)
```
文档同时列出 PG 侧限制：`Expressions cannot reference other generated columns or include subqueries`、`Cannot specify default values`、`Cannot directly use in primary keys, foreign keys, or unique constraints`。

### 5.2 `drizzle-kit generate` 是否真的把这些写进迁移 —— **是（实测）**

我实跑的 schema（软删 partial unique + partial index + check + 跨列 generated + 双 FK 动作）生成的 SQL 原文：

```sql
CREATE TABLE "matters" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(40) NOT NULL,
	"party_id" integer,
	"risk_level" integer NOT NULL,
	"risk_band" text GENERATED ALWAYS AS (case when "risk_level" >= 4 then 'high' else 'low' end) STORED,
	CONSTRAINT "ck_risk_level" CHECK ("matters"."risk_level" >= 1 and "matters"."risk_level" <= 5)
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"is_deleted" text,
	"name_upper" text GENERATED ALWAYS AS (upper("name")) STORED
);
--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "fk_matter_party" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_matter_code_active" ON "matters" USING btree ("code") WHERE "matters"."risk_level" > 0;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_party_name_active" ON "parties" USING btree ("name") WHERE "parties"."is_deleted" is null;
--> statement-breakpoint
CREATE INDEX "ix_party_name_active" ON "parties" USING btree ("name") WHERE "parties"."is_deleted" is null;
```

**diff 路径（第二份迁移）也正确**——改了 partial unique index 的 WHERE 并新增一个 CHECK，`generate` 产出：

```sql
DROP INDEX "uq_party_name_active";
CREATE UNIQUE INDEX "uq_party_scope" ON "matters" USING btree ("party_id","code") WHERE "matters"."risk_level" <> 3;
CREATE UNIQUE INDEX "uq_party_name_active" ON "parties" USING btree ("name") WHERE "parties"."is_deleted" is null and "parties"."name" <> 'x';
ALTER TABLE "matters" ADD CONSTRAINT "ck_code_len" CHECK (length("matters"."code") > 2);
```

即 `generate` 对索引做的是 **DROP + 重建**，而不是跳过。（注意：同一列上写两条 FK 会被照原样生成两条约束，Drizzle 不做去重——别指望它帮你合并冗余外键。）

### 5.3 已知坑（一手 issue + 官方 FAQ + 我方实测）

**(a) `eq()` 等 operator 出现在 partial index 的 `.where()` 里会生成非法 SQL** —— 我在 0.45.3 / kit 0.31.11 上**复现成功**：

```ts
uniqueIndex('idx_one_primary_per_table').on(table.tableId).where(eq(table.isPrimary, true))
```
→ `CREATE UNIQUE INDEX ... WHERE "fields"."is_primary" = $1;`（实测原文，`$1` 未被替换）

对应 issue：[drizzle-team/drizzle-orm#4790](https://github.com/drizzle-team/drizzle-orm/issues/4790)（**open**，labels `bug`, `bug/fixed-in-beta`，报于 drizzle-orm 0.44.3 / drizzle-kit 0.31.4）。issue 内给出的可用 workaround 正是我们该采用的写法：`.where(sql\`${table.isPrimary} = true\`)`。
→ **项目约定**：partial index 的 `.where()` 里只用 `sql` 模板（含 `is null` / 字面量比较），禁止 `eq()/ne()/and()` 之类 operator。`sql\`${t.isDeleted} is null\`` 实测正常。

**(b) 官方 FAQ 明确 `push` 在索引上有盲区**（https://orm.drizzle.team/docs/faq ，节 "How `push` and `generate` works for PostgreSQL indexes / Limitations"）：

> 1. "You should specify a name for your index manually if you have an index on at least one expression" —— `index().on(sql\`lower(${table.email})\`) // error`，`index('my_name').on(...) // will work well`
> 2. "Push **won't generate statements** if these fields were changed in an existing index: expressions inside `.on()` and `.using()`；**`.where()` statements**；operator classes `.op()` on columns"，并给出 comment-out→push→改→再 push 的手工流程
> "For the `generate` command, drizzle-kit will be triggered by any changes in the index for any property in the new drizzle indexes API, so there are **no limitations** here."

**这一条直接决定工作流**：软删 partial unique index 是本项目权限/枚举表的骨架，用 `push` 会在「改了 WHERE 条件」时静默不生效。

**(c) 其余相关 issue**（都是 open/closed 状态如实标注）：
- #5761 (open) `drizzle-kit generate crashes when a table with a partial index changes schema from "" to "public"` —— 与 `pgSchema` 迁移场景相关，第一期不用自定义 schema 即可绕开。
- #6145 (open) `drizzle-kit pull infers a one-to-one relation from a PARTIAL unique index` —— 影响 `pull`/introspection，不影响 generate；提醒：不要用 `pull` 生成的 schema 当事实源。
- #3349 (open) `Partial unique index migration does not generate valid where clause` —— 与 (a) 同族。
- #1952 / #1519 (closed)、#3983 (closed, feature) —— 历史上「WHERE 子句丢失」的一族，现已由新 indexes API 修复；说明该能力较新（`.where()` 是新索引 API 的一部分）。

### 5.4 `push` vs `migrate`，以及官方对 `push` 的态度

- 语义（/docs/pg/drizzle-kit-push 原文）：`drizzle-kit push` "lets you literally push your schema and subsequent schema changes directly to the database **while omitting SQL files generation**"，内部流程是 读 schema→快照→introspect 库→diff→直接 apply。`generate` 只产出 SQL 文件 + `meta/` 快照，不碰库；`migrate` 负责把已生成的迁移应用到库。
- 官方 FAQ 的直接表态（/docs/faq，节 "Should I use `generate` or `push`?"）：
  > "`push` doesn't need any migrations to be generated. It will simply sync your schema with the database schema. **Please be careful when using it; we recommend it only for local development and local databases.**"
- push 文档页自身也有一处 warning（tutorials 页与 /docs/kit-overview#prototyping-with-db-push 反复出现同一句）：
  > "Push command is good for situations where you need to quickly test new schema designs or changes in **a local development environment**, allowing for fast iterations without the overhead of managing migration files."
- push 页另一句要如实记录（避免把「push 禁用于生产」当成官方立场）：
  > "It's the best approach for rapid prototyping and we've seen dozens of teams and solo developers successfully using it as a primary migrations flow in their production applications."

→ 官方口径是「推荐只用于本地/开发库；生产请走 generate+migrate 的版本化文件」。§2 的「drizzle-kit 生成 + 手写 SQL 补丁段 + SQL 进版本库」与官方建议一致，**不受本次调研影响**。

---

## 6. 大文件上传：Nitro → S3/MinIO 流式 —— **PARTIALLY VERIFIED**

来源：`h3@1.15.11` 发布产物（`dist/index.mjs`、`dist/index.d.mts`）+ https://v1.h3.dev/utils/request 、 https://v1.h3.dev/utils/advanced 、 https://nuxt.com/docs/4.x/directory-structure/server 、 https://github.com/nitrojs/nitro/blob/v2/docs/2.deploy/0.index.md 、 .../10.runtimes/1.node.md

### 6.1 `readMultipartFormData` 会全量缓冲，不能流式（源码级确定）

文档（v1.h3.dev/utils/request）：`readMultipartFormData(event)` — "Tries to read and parse the body of an H3Event as multipart form." **文档没有说它缓冲**；实现说了：

```ts
// h3@1.15.11 dist/index.d.mts
declare function readMultipartFormData(event: H3Event): Promise<MultiPartData[] | undefined>;
interface MultiPartData { data: Buffer; name?: string; filename?: string; type?: string }
```
```js
// dist/index.mjs
async function readMultipartFormData(event) { ... const body = await readRawBody(event, false); if (!body) return; ... }
// readRawBody:
const promise = event.node.req[RawBodySymbol] = new Promise((resolve, reject) => {
  const bodyData = [];
  event.node.req.on("error", err => reject(err)).on("data", chunk => { bodyData.push(chunk) }).on("end", () => resolve(Buffer.concat(bodyData)));
});
```

→ **整个请求体先进内存（一个 Buffer），再切分各 part**。50 MB 上传 = 峰值至少 ~50 MB 堆占用（原始 buffer + part 视图），并发 4 个上传就有 OOM 风险。`readFormData(event)`（web FormData）同理，走 `toWebRequest`。
→ 另外：h3/nitropack 里 **grep 不到任何 body size 限制**（无 `maxBodySize`/`bodyLimit`），框架层不会替你挡大文件；上限必须由 nginx `client_max_body_size` 或自己校验 `content-length` 提供。

### 6.2 流式可行路径（有文档支撑 + 有源码支撑）

- `event.node.req` 就是 Node 的 `IncomingMessage`（上面源码 `event.node.req.on("data")` 即证明它是 Readable；Nuxt 文档示例直接使用 `event.node.req.url`）。因此可以自己接管原始流：`node:req` →（手工解析 multipart 边界 / 或前端直传）→ `crypto.createHash('sha256')` 增量更新 → `@aws-sdk/client-s3` 的 `CreateMultipartUpload`/`UploadPart`。
- 官方列出的读流 API：`getRequestWebStream(event)` — "Captures a stream from a request."（v1.h3.dev/utils/request）。
- 下行方向（下载/预览）有官方流式示例，顺带证明 server 路由可用 Node 内置模块：
  ```ts [server/api/foo.get.ts]
  import fs from 'node:fs'
  import { sendStream } from 'h3'
  export default defineEventHandler((event) => sendStream(event, fs.createReadStream('/path/to/file')))
  ```
  （Nuxt 4.x `server` 页「Sending Streams」；同页注明 `This is an experimental feature and is available in all environments.`）
- **诚实结论**：Nitro/h3 **没有**「multipart 流式 + 边写 S3 边算 sha256」的官方一体化 API。可行但要自己写 multipart 解析或改走 **MinIO 预签名 PUT / 前端直传 + 服务端回调校验**，否则等于重造 busboy 的一层。这是本项目里工程量最容易被低估的一块。

### 6.3 Node 内置模块与 preset

- 生产默认 preset：`node_server`。原文 "Node.js is the default nitro output preset for production builds and Nitro has native Node.js runtime support."，产物是 `node .output/server/index.mjs` 的独立 Node 服务 → `node:crypto`、`node:fs`、`node:worker_threads` 都是普通 Node 能力，**无需特殊 preset**。
- 相关 preset：`node_cluster`（`NITRO_CLUSTER_WORKERS`，默认 = CPU 核数）、`node`（handler 形态，`(req, res) => {}` 可挂进自定义 http server）。
- dev：`nitro-dev` preset，文档措辞值得注意 —— "Nitro will always use a special preset called `nitro-dev` **using Node.js with ESM in an isolated Worker environment** with behavior as close as possible to the production environment."（这里的 worker 是 Nitro 自己的 dev 隔离，不是 `worker_threads` API。）
- 客户端侧的 Node 兼容是独立开关且默认关：`experimental.clientNodeCompat`（`- **Default:** false`，"Automatically polyfill Node.js imports in the client build using `unenv`"）。这正好解释 §1.3 为什么 `shared/` 不能碰 Node API。
- **worker_threads 专项：UNABLE TO CONFIRM（文档层面）**。Nuxt 全站文档（含博客）grep `worker_threads` **0 命中**；Nitro v2 文档也没有针对 `worker_threads` 的指导或限制条款。能确认的只有：目标是 `node_server` 时运行时就是普通 Node 进程，没有 unenv polyfill 介入（unenv 用于 edge/workers 目标）。若打算用 worker 池跑文档解析/哈希，需要自己写 spike 验证，别引用「官方支持」这种说法。

---

## 7. Auth / session —— 第一方模块 **NOT SUPPORTED**；h3 有原语（PARTIALLY VERIFIED）

来源：npm registry、GitHub API、https://v1.h3.dev/utils/advanced 、`h3@1.15.11/dist/index.d.mts`

- **不存在第一方 Nuxt/Nitro session 模块**（实测）：
  - npm `@nuxt/session` → `Not Found`；npm `@nuxtjs/session` → `Not Found`。
  - GitHub 仓库 `nuxt/session` → `404 Not Found`；`search/repositories?q=org:nuxt session in:name` → `total_count: 0`。
  - npm `nuxt-session` → 最后一个版本 **1.0.3，发布于 2018-09-30**，描述 "Add session support in Nuxt.js, accessible in server middleware"（Nuxt 2 时代社区包）。
  → 直说：**这块不成熟，也不存在「官方 session 模块」可以等**。任何"Nuxt 有官方 session"的表述都不能写进文档。
- **有的只是 h3 的 session 原语**（v1.h3.dev/utils/advanced 列有 `useSession / getSession / updateSession / sealSession / unsealSession / clearSession`）。h3 1.15.11 的 `SessionConfig` 原文字段：

  ```ts
  interface SessionConfig {
    /** Private key used to encrypt session tokens */
    password: string;
    /** Session expiration time in seconds */
    maxAge?: number;
    name?: string;                                   // default 'h3'
    cookie?: false | CookieSerializeOptions;         // Default is secure, httpOnly, /
    sessionHeader?: false | string;                  // default x-h3-session
    seal?: SealOptions; crypto?: Crypto; generateId?: () => string;
  }
  ```
  `sealSession` = "Encrypt and sign the session data for the current request."
  → 语义是**加密签名的 cookie token（无状态）**，不是服务端会话仓库。文档没有提供后端存储；要做到「改密后踢下线 / 管理员强制下线 / 会话可枚举」，仍需自己落 session 表并自己决定校验策略。（这是基于上述 API 形状的推断，标注为推断。）
- 与 §2 决策一致：服务端 session 表 + `httpOnly` cookie 的方案在 Nuxt 全栈下不变，只是**实现落点从 Nest 的 Guard/Strategy 变成 `server/utils/*` + `server/middleware/*` 的显式函数调用**（无 DI 容器兜底）。同域 cookie 在单部署单元下天然成立（§11.2 已列）。

---

## 8. 结论表：claim → verdict → source

| # | 待验主张 | Verdict | 版本敏感 | 一手来源 |
|---|---|---|---|---|
| 1 | `shared/` 可被 app 与 `server/api` 双向使用 | **VERIFIED** | Nuxt ≥3.14（v3 自动导入需 `future.compatibilityVersion: 4`）；Nuxt 4.5.2 直接可用 | [nuxt.com/docs/4.x/directory-structure/shared](https://nuxt.com/docs/4.x/directory-structure/shared) |
| 1b | `shared/` 内不能 import Vue / Nitro / Node-only 代码；只有 `shared/utils`、`shared/types` 自动导入；其余用 `#shared` | **VERIFIED** | 4.x 文档 | 同上 |
| 1c | Nuxt 4 布局：`srcDir=app/`，`shared/`、`server/` 仍在 rootDir；`#shared` 未改名（`#server` 自 v4.3） | **VERIFIED** | Nuxt 4 | [upgrade](https://nuxt.com/docs/4.x/getting-started/upgrade)、[server](https://nuxt.com/docs/4.x/directory-structure/server) |
| 2 | 声明方式 `nitro.experimental.tasks=true` + `nitro.scheduledTasks['<cron>'] = ['task:name']` | **VERIFIED** | nitropack **2.13.4**（Nuxt 4.5.2 内）；tasks 仍标注 experimental | [nitro v2 tasks 文档](https://github.com/nitrojs/nitro/blob/v2/docs/1.guide/10.tasks.md)、[nitro.build/docs/tasks](https://nitro.build/docs/tasks)（v3 措辞） |
| 2b | task 与 API 路由同 bundle/同进程，可共享 Drizzle 单例；可 `runTask()` 手动触发 | **VERIFIED** | 2.13.4 | 文档 + `dist/presets/node/runtime/node-server.mjs`、`dist/core/index.mjs:369` |
| 2c | 「调度器不会跨副本去重：N 进程 = 触发 N 次」→ advisory lock 必需 | **VERIFIED（代码层）/ 文档仅 v3 明写 per server instance** | 2.13.4 | `dist/runtime/internal/task.mjs`、`node-cluster.mjs`；v3 文档 Concurrency 段 |
| 2d | `nitro run-task <name>` 可在生产手动跑 | **NOT SUPPORTED**：命令是 `nitro task run`，且**只在 dev server 运行时可用** | 2.13.4 | `dist/cli/run.mjs`、`dist/core/index.mjs` `_getTasksContext` |
| 3 | `ssr: false` 全局 / `routeRules` 按路由关闭 SSR | **VERIFIED** | Nuxt 4 | [rendering](https://nuxt.com/docs/4.x/guide/concepts/rendering) |
| 3b | 需要 `spa-loading-template.html`；`ssr:false` 下首屏无服务端内容（鉴权跳转只能在客户端） | **VERIFIED**（后半句为架构推论） | Nuxt 4 | 同上 |
| 4 | `server/middleware` 每请求执行（含 404 路径）、可短路、但不应返回 | **VERIFIED** | Nuxt 4 / h3 1.15.11 | [nuxt server](https://nuxt.com/docs/4.x/directory-structure/server)、[nitro v2 routing](https://github.com/nitrojs/nitro/blob/v2/docs/1.guide/2.routing.md)、[h3 v1 event-handler](https://v1.h3.dev/guide/event-handler)、`h3` `createAppEventHandler` |
| 4b | 状态码完全可控（404 而非 403）：`createError({ statusCode })` / `setResponseStatus` | **VERIFIED** | h3 1.15.11 | h3 `createError` JSDoc、Nuxt server 页 Status Codes |
| 4c | 生产默认不泄漏 stack；未捕获错误 message 降级为 "Server Error" | **VERIFIED** | nitropack 2.13.4 | `dist/runtime/internal/error/prod.mjs`、`dist/rollup/index.mjs`（dev/prod 选择 + `nitro.errorHandler`） |
| 4d | 错误 payload 是稳定契约 | **UNABLE TO CONFIRM**（payload 只在产物源码里；文档说明 `/api/**` 走 JSON、其余 HTML，且受 `Accept`/`User-Agent` 影响） | 2.13.4 | nitro v2 routing「Error handling」节 |
| 5 | `uniqueIndex().on().where(sql)` partial unique | **VERIFIED**（含 diff 时 DROP+CREATE 实测） | drizzle-orm 0.45.3 / kit 0.31.11 | `pg-core/indexes.d.ts`、[indexes-constraints](https://orm.drizzle.team/docs/pg/indexes-constraints)、实跑 SQL |
| 5b | partial 非 unique index `.where()` | **VERIFIED** | 同上 | 同上 |
| 5c | 表级 `check()` | **VERIFIED** | 同上 | `pg-core/checks.d.ts`、实跑 SQL |
| 5d | `generatedAlwaysAs(...).stored()` | **PARTIALLY VERIFIED**：能力有（GENERATED ALWAYS AS … STORED，可跨列），但 **pg 侧没有 `.stored()`**（抛 TypeError），正确写法 `generatedAlwaysAs(sql\`…\`)` 或回调形式 | 0.45.3 | `pg-core/columns/common.d.ts`、[generated-columns](https://orm.drizzle.team/docs/pg/generated-columns)、[PG 文档](https://www.postgresql.org/docs/current/ddl-generated-columns.html) |
| 5e | FK `onDelete`/`onUpdate`（`set null`/`cascade`/`restrict`/…） | **VERIFIED** | 0.45.3 | `pg-core/foreign-keys.d.ts`、实跑 SQL |
| 5f | `drizzle-kit generate` 覆盖以上全部 | **VERIFIED（实测）**，但 `.where()` 里用 `eq()` 生成 `$1` 非法 SQL（**实测复现**，open issue） | 0.45.3 / 0.31.11 | [issue#4790](https://github.com/drizzle-team/drizzle-orm/issues/4790)、[#5761](https://github.com/drizzle-team/drizzle-orm/issues/5761)、[#3349](https://github.com/drizzle-team/drizzle-orm/issues/3349) |
| 5g | `push` 检测不到已有索引的 `.where()`/表达式/`.op()` 变化；表达式索引必须手写 name | **VERIFIED**（官方 FAQ 明写） | kit 0.31.x | [FAQ](https://orm.drizzle.team/docs/faq) |
| 5h | `push` 只推荐本地开发用 | **VERIFIED**（"we recommend it only for local development and local databases"）；注意同文档另有「也有团队把它当生产主流程」一句 | kit 0.31.11 | [FAQ](https://orm.drizzle.team/docs/faq)、[drizzle-kit-push](https://orm.drizzle.team/docs/pg/drizzle-kit-push) |
| 6 | `readMultipartFormData` 可流式 | **NOT SUPPORTED**：全量 `Buffer.concat` 进内存后解析 | h3 1.15.11 | `dist/index.mjs`、[v1.h3.dev/utils/request](https://v1.h3.dev/utils/request) |
| 6b | 可以拿到原始流自行 pipe 到 S3 + 增量 sha256 | **PARTIALLY VERIFIED**：`event.node.req` 是 Node Readable、`getRequestWebStream(event)` 有文档；**但 multipart 流式解析需自己实现，官方无此 API** | h3 1.15.11 | v1.h3.dev/utils/request、h3 源码 |
| 6c | server 路由可用 Node 内置（`node:fs`/`node:crypto`）；默认 preset `node-server` | **VERIFIED** | nitropack 2.13.4 | [nitro v2 deploy/node](https://github.com/nitrojs/nitro/blob/v2/docs/2.deploy/10.runtimes/1.node.md)、Nuxt server 页 sendStream 示例 |
| 6d | `worker_threads` 的支持/注意事项 | **UNABLE TO CONFIRM**：Nuxt + Nitro 文档 grep `worker_threads` = 0 命中；只能确认 node-server preset = 普通 Node 进程；dev 用 `nitro-dev`（"isolated Worker environment"，非该 API） | nitropack 2.13.4 | 上述 + `docs/2.deploy/0.index.md` |
| 7 | Nuxt/Nitro 有第一方 session 模块（`nuxt-session`/`@nuxt/session`） | **NOT SUPPORTED**（不存在；`nuxt-session` 停更于 2018-09-30） | — | npm registry、GitHub API |
| 7b | h3 提供 session 原语（sealed/加密 cookie，`httpOnly`+secure 默认） | **VERIFIED**；语义是无状态密封 cookie，非服务端会话仓库（后半句为推断） | h3 1.15.11 | [v1.h3.dev/utils/advanced](https://v1.h3.dev/utils/advanced)、`h3` 类型定义 |

---

## 9. 对 MatterNest 架构决策的直接影响

### 9.1 活下来的假设（可以继续写进 §11）

1. **S1 通过**：`shared/` + `#shared` 在 Nuxt 4.5.2 上就是枚举/DTO/Zod schema 的单一事实源，不需要 pnpm workspace 跨 package 构建链（§11.2 那一行可以升级为「已验证，Nuxt ≥3.14 / 4.x 默认支持」）。**代价**：shared 里只能放纯 TS，不能碰 Vue runtime、不能碰 Nitro runtime、不能碰 Node API（§1.3 表）。这条要直接写进 `.trellis/spec/` 的目录约定，否则 agent 会往 `shared/` 里塞带副作用的东西。
2. **`ssr: false` 路线成立**（§11.1 对理由①的撤回有文档支撑）。要求补 `app/spa-loading-template.html`，且 API 全部落 `/api/**` 以保证 JSON 错误形状（§4.4）。
3. **Nitro server 层能拿到精确状态码、生产不泄漏 stack**（§4.2/§4.3）。权限草案「不可见资源返回 404」可以按原设计实现。
4. **Drizzle DDL 覆盖度足够**：`parties/matters` 那套（软删 partial unique + CHECK + 跨列 STORED generated + FK 动作）可以全部用 schema DSL 表达，`drizzle-kit generate` 实测能产出正确 SQL 与正确的 diff（DROP+CREATE INDEX / ADD CONSTRAINT）。§2「drizzle-kit 生成 + 手写 SQL 补丁段 + SQL 进版本库」保持不变。
5. **定时任务能共享主应用连接池**（§2.4），S2 的「同一套 PG 连接」这半边通过。

### 9.2 必须改的假设

1. **§11.2「Nitro scheduled tasks（进程内 cron）+ advisory lock」→ 把「+ advisory lock」从可选改成强制，并写明理由**：调度器是 per-process croner，多副本或多 cluster worker 会重复触发（§2.3 源码证据）。这不再是「保险起见」，而是**功能正确性前提**（outbox 双派 = 双发通知）。同时：`isTest` 会短路调度器，所以扫描逻辑要单测就得走 `runTask()`，不能被 cron 触发。
2. **删除任何「`nitro run-task` 可运维/可手动补跑」的隐含期待**（§2.2）。生产手动补跑必须自己实现一个鉴权后的 `server/api/tasks/[name].post.ts` → `runTask()`；或把 task handler 逻辑同时暴露给一个 one-off 容器命令（Compose `run --rm app node .output/server/...` 之类）。另外：`/_nitro/tasks*` 端点是 dev-only。
3. **迁移工作流钉死为 `generate` + `migrate`，开发期也不要用 `push` 做 schema 演进**（§5.3b 官方明写 push 感知不到 `.where()`/表达式/`.op()` 变化；§5.4 官方建议 push 仅本地库）。软删 partial unique 是权限模型的骨架，用 push 会出现「代码改了、库没改、CI 还绿」的静默漂移。
4. **partial index 的 `.where()` 里禁止 `eq()/and()`，只允许 `sql` 模板**（§5.3a，0.45.3 实测产出非法 `$1`）。这条要进 spec 的 lint/review 清单，并锁 `drizzle-orm`/`drizzle-kit` 精确版本，升级时重新验证 issue#4790 是否关闭。
5. **generated 列写法更正**：`text('x').generatedAlwaysAs(sql\`…\`)`，**没有 `.stored()`**；跨列用回调形式；PG 只有 STORED，且不能引用其他 generated 列、不能进 PK/FK/unique（§5.1）。
6. **上传链路要换方案**：`readMultipartFormData` 50 MB 全量进内存（§6.1），且框架层**没有任何 body size 限制**。二选一：(a) 第一期接受内存方案，但 nginx/ingress 设 `client_max_body_size`、handler 里校验 `content-length`、并把并发压到 1；(b) 走 MinIO/S3 **预签名直传 + 服务端回调**，sha256 改由客户端或回调后异步校验。要「流式 pipe + 增量 sha256」则必须自己接管 `event.node.req` 并手解 multipart —— Nitro/h3 没有官方支持（§6.2）。
7. **session 没有可以等的官方模块**（§7）。第一期照旧自建 session 表 + `httpOnly` cookie；h3 的 `useSession` 只解决「密封 cookie 的加解密/序列化」，不解决吊销与枚举。写文档时不要出现「Nuxt 官方 session」。
8. **依赖面要显式承担**：定时任务这一层建立在 `nitro.experimental.tasks`（Nitro 2 与 3 都还标 experimental）+ 官方警告「Nitro semver-minor 升级时配置接口可能变」之上，且 **Nuxt 自己的文档完全不解释 tasks**（§2.5）。建议：把 `nitropack` 版本锁进 lockfile 并在 CI 里做 `drizzle-kit generate` + `nitro task list`（dev 模式冒烟）双向哨兵。
9. **worker 池是未证实项**（§6.3）：文档零命中，别把「用 `node:worker_threads` 跑文档解析/哈希」当成官方支持能力，需要单独 spike。

### 9.3 是否阻塞 Nuxt 全栈路线

- **不阻塞**：第 1、3、4、5 项（S1 全绿；错误/状态码/SSR 全绿；Drizzle DDL 全绿）。
- **不阻塞但强制加代码**：第 2 项 —— advisory lock 单飞变成必写组件（`pg_try_advisory_lock(hashtext(key))`，§3.5 已设计好）+ 一个鉴权后的手动触发端点。
- **需要改设计**：第 6 项 —— 附件直传方案（签名 PUT / 分片）与内存上限策略。这会影响 PRD 附件鉴权链路里「后端签 60s URL」的实现细节，但方向不变（甚至更契合：后端只签、不中转文件流）。
- **胜负手仍在文档之外**：S3（Element Plus Table 的受控分页/服务端排序/多筛选/批量选择/列配置）本次未核验，§11.4 的判断依然成立——它才是决定 Nuxt 路线生死的项；本文的 7 项里没有任何一项足以否掉 Nuxt 全栈。

### 9.4 需要重新核验的触发条件

- Nuxt 从 4.5.x 升到 **Nitro 3**（目前 `nitro@3.0.260903-beta`）：`nitropack` → `nitro` 包名、`defineTask` 导入路径（`nitro/task`）、`h3` 1.x → 2.x 的 body/session API 全会变。届时 `readMultipartFormData`、`createError` 字段、prod error payload、`scheduledTasks` 平台支持四项都要重跑本文的核验步骤。
- `drizzle-orm` 小版本升级：复核 #4790（`.where()` + `eq()`）是否已修（label `bug/fixed-in-beta` 说明修复已在 beta 里），以及 #5761（partial index + schema 切换导致 generate 崩溃）。

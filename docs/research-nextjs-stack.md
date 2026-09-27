# Next.js 全栈路线一手核验（T1-v5 依据）

> 归属：技术选型 §13。触发：为拿 shadcn 一等生态把前端从 Nuxt 换回 React/Next，后端仍留 TS 同仓（用户裁定：Python 无特定理由，不进主栈）。
> 版本基线：Next **16.3.6**（文档页脚注）、React 19、Tailwind v4、Drizzle 0.45.3、PostgreSQL 15+。
> 证据纪律：只有**直接取自官方域名**的内容算 VERIFIED；抓取失败或只有代理来源支撑的一律标未证实，不靠生态常识充数。核验日期 2026-09-26。

---

## 1. 结论摘要

| 问题 | 结论 |
|---|---|
| 换 Next 要不要换 Python | **不要**。shadcn 一等待遇来自 React/Next，与后端语言无关；换 Python 会破枚举表 §5.1 的单一事实源并推翻 `:258` 对 codegen 管线的否决 |
| Next 能不能承担我们的后端角色 | 能。Route Handlers + Server Functions 覆盖原 `server/api`，Drizzle/PG/迁移 SQL 一行不改 |
| 权限模型会不会因此变弱 | 不会，反而更被官方背书：Next 明令鉴权要写在每个 Server Function 内部，不能只靠 proxy |
| 定时任务 | Next **无内置调度器**，需独立 worker 进程；C1 的 advisory lock 结论原样搬用 |
| 新增的多副本坑 | `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` 与 `deploymentId` 必须显式配置（详见 §2.5） |
| 净收益 | shadcn 一等：Blocks、主题工具、registry namespaces、面向 agent 的 MCP 工具、更密的文档与示例 |
| 净损失 | 单 app 同源从 Nuxt 的 `shared/` 约定变成 Next 的普通 TS 目录（更简单，不是更差）；C2/C3/C4 里 Nitro 专有的三条作废 |

---

## 2. 逐条事实

### 2.1 Proxy（原 middleware）默认 Node.js 运行时 — **VERIFIED**

来源：`nextjs.org/docs/app/api-reference/file-conventions/proxy`（v16.3.6）。

- 原文：**"Proxy defaults to using the Node.js runtime. The `runtime` config option is not available in Proxy files. Setting the `runtime` config option in Proxy will throw an error."**
- 版本史：`v16.0.0` — "Middleware is deprecated and renamed to Proxy. Proxy defaults to the Node.js runtime"；`v15.5.0` 起 Node 运行时为 stable。
- 含义：**我上一轮列的"middleware 跑 Edge 拿不到 PG 连接"这条风险，在 Next 16 已经不成立**，撤回。
- 但同一页反复降温：官方称此类逻辑"last resort"，且"避免在没有别的选择时依赖它"。所以我们的 `ScopeResolver` **不放这里**。

### 2.2 鉴权必须写在每个 Server Function 内部 — **VERIFIED（直接决定我们的落点）**

同页原文两条：

> "[Server Functions] are handled as POST requests to the route where they are used, so a matcher that excludes a path will also skip Server Function calls on that path."
> "A matcher change or a refactor that moves a Server Function to a different route can silently remove Proxy coverage. **Always verify authentication and authorization inside each Server Function rather than relying on Proxy alone.**"

对应到本项目：权限草案 §4 的"默认拒绝现在全靠 ScopeResolver 这一层"必须有**结构性的第二道**——每个 handler 自己 `withScope(event, handler)`。这不是我们的偏好，是官方要求；也意味着 §12.3 里"Nuxt 显式包装"那条禁令在 Next 下**加强**而不是消失。

### 2.3 无内置调度 — **PARTIAL**

- `/docs/app/guides/cron-jobs` 返回 **Page Not Found**（Next 文档不给该页）；自托管页只提到 `register`（instrumentation，启动时执行一次）与 `after()`（响应后异步）。
- 结论：**Next 自身不提供周期任务**。可行做法是独立 `worker` 容器跑 `node-cron`（或 setInterval）+ 同一套 Drizzle 连接与 `pg_try_advisory_lock` 单飞。
- 诚实标注：这是"官方文档没有该能力 + 我们据 §2.1/§2.4 的部署模型推出来的方案"，**调度器选型本身未经一手核验**，spike 要实测 `node-cron` 与 graceful shutdown（自托管页要求 SIGTERM 后留 10–30s drain）。

### 2.4 静态导出与我们的关系 — **VERIFIED**

- `proxy` 在 `output: 'export'` 下**不支持**；`next/image` 与 `next start` 自托管零配置可用；`output: 'standalone'` 为 Docker 自托管生成可独立运行的产物（`node .next/standalone/server.js`，`PORT`/`HOSTNAME` 可控）。
- 结论：我们走 **standalone + Docker**，不做静态导出。于是"Nuxt 那边 `ssr:false` 怎么在 Next 复现"这个纠结自动消解——**Next 本来就有服务端进程**，页面壳可以 SSR，数据一律客户端经 `/api/**` 取，登录跳转在客户端与服务端都可做，不再需要"整站 SPA 化"这个目标。
- 但由此新增一条要求：**页面壳不得预取任何业务数据**（否则行级权限判断被绕过），所有业务读取都在鉴权后的 `/api/**` 里发生。这条要进 §13.2 禁令。

### 2.5 多副本的第二个坑 — **VERIFIED**

自托管页 "Multi-Server Deployments" 原文：

- Next 会加密 Server Function 的闭包变量，"a unique encryption key is generated for each build"；多实例必须共用同一个 key，否则 **"Failed to find Server Action" errors**，靠 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`（base64，16/24/32 字节）固定。
- 滚动发布要配 `deploymentId`，否则版本错配导致资源缺失与导航失败。
- 默认缓存是**每实例一份内存+磁盘**，多 pod 各自持有 → 与我们的"不引任何缓存组件"（§12.5）恰好一致，无需额外处理，但**不许改用 `'use cache'`**。
- 结论：部署形态"app 2 副本"从"只要加锁就行"变成**必须配两个环境变量**。Compose 里加 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`（从 secret 注入）与 `DEPLOYMENT_VERSION`。
- 若嫌麻烦，退路是**一期只跑单副本**——但那样 §3.5 的 advisory lock 就成了纯保险；我建议保留双副本 + 两个变量，因为发布期不断服对内部系统也值钱。

### 2.6 反向代理与流式 — **VERIFIED（顺带核到）**

官方建议自托管前置 nginx 处理畸形请求、慢连接、**payload size 限制**、限流；nginx 缓冲会吃掉流式，需 `X-Accel-Buffering: no`。
对我们的意义：**"请求体大小上限"这道防线交给 nginx 明确设死**，正好接住 C3 那条"框架层无 body 上限"的老问题——只是这次的兜底位置从 Nitro 换成了 nginx。`/api/**` 里除登录与元数据登记外都不收文件流，nginx 侧上限可以设得很小（如 2MB），附件走预签名 PUT 不经 Next。

---

## 3. shadcn React 侧组件覆盖 — **未证实（本轮抓取失败）**

我尝试直取 `ui.shadcn.com/docs/components` 与 `/docs/components/table`，两次都 `fetch failed`。因此本轮**不声明** React 侧组件清单、也不声明"有没有 File Upload"。

已知的、但同样**未经本轮核实**的两条（列为 spike 待验，不当结论用）：React 侧组件数与迭代速度优于端口；Blocks/主题生成器/registry namespaces/MCP 工具是 React 独有。

对计划的实际影响：本项目最重的四件里，表格底座两边同源（TanStack Table，官方支持 React，**VERIFIED**），日期/表单有 React 侧成熟解（**待本轮之外的复核**），上传件在 Vue 侧确认没有、React 侧本轮没核到——**所以"自封装 `FileUpload`"这条工作项无论哪条路线都留着，不因换框架而消失**。

### 3.1 2026-09-27（W0-2）补测：拿到了一次清单，但没拿到源码

同一次会话里先成功、随后持续失败，所以这条只能记成**部分核实**：

- ✅ 取到 `https://ui.shadcn.com/r/index.json` 一次，HTTP 200 / 58,355 字节 / **63 个 registry 条目**，全名单：
  `accordion alert alert-dialog aspect-ratio attachment avatar badge breadcrumb bubble button button-group calendar card carousel chart checkbox collapsible combobox command context-menu dialog direction drawer dropdown-menu empty field form hover-card input input-group input-otp item kbd label marker menubar message message-scroller native-select navigation-menu pagination popover progress questionnaire radio-group resizable scroll-area select separator sheet sidebar skeleton slider sonner spinner switch table tabs textarea toast toggle toggle-group tooltip`
- ✅ 其中**没有** `upload` / `file-upload` / `dropzone` 命名的条目 → 与 Vue 端口同结论：**没有现成的上传件**，`FileUpload` 自封装的排期不变（这条可以结案）。
- ⚠ 有个 `attachment` 条目，但**没能取到它的源码**（`/r/attachment.json`、`/r/styles/nova/attachment.json` 等五种 URL 形态全 404 或断连），所以**不断言它是上传器还是附件展示件**。要判就得等网络能连通时 `shadcn add attachment` 读源码——在此之前不要拿这个名字做排期依据。
- ✅ `shadcn` CLI 版本 **4.21.0**；`init` 的参数面从报错信息里直接读到：`base` 的合法值是 **`radix | base | aria`**（**原语包现在是三选一，不是默认 Radix**），默认组合为 `style=nova & baseColor=neutral & theme=neutral & iconLibrary=lucide & font=geist & template=next`。
- ❌ 之后所有请求（含 `/r/index.json` 六次退避重试、`curl` 三次）全部 `ECONNRESET`，`init` 与 `add` **没跑通** → N1 的"CLI 能否把组件落到 §5 指定位置"与"中文 locale"两项**仍未验**。

对本仓的直接后果：`components.json` **故意不手写**——一份没被 CLI 认过的配置只会让下一次 `shadcn add` 报难懂的错。等网络可用时跑 `pnpm dlx shadcn@latest init --yes --defaults --base radix`，再按 §5 把 alias 改到 `@/app/components/ui`。

---

## 4. 从 Nuxt 路线继承与作废的清单

| 原结论 | 处置 |
|---|---|
| C1 Nitro 调度器 per-process，N 副本触发 N 次 → advisory lock 是正确性前提 | **继承**。Next 连内置调度都没有，独立 worker 多副本同样会重复触发，锁照旧必需 |
| C2 `nitro task run` 仅 dev | **作废**（无对应机制）。生产补跑改为 `worker` 容器上的一条受控入口或一次性 `docker compose run worker --task <name>` |
| C3 h3 `readMultipartFormData` 全量入内存、无 body 上限 → 预签名 PUT 直传 | **结论继承、理由更新**：仍走预签名 PUT；兜底改由 nginx 设请求体上限（§2.6） |
| C4 Nuxt/Nitro 无第一方 session → 自建 session 表 | **继承**。Next 同样没有；§3.4 的表结构一行不改 |
| §12.3 禁令 1（`shared/` 只放纯 TS，不得 import Vue/Nitro/Node） | **替换**为 Next 版：`src/shared/**` 只放纯 TS，禁止 import `next/*`、`react`、Node API；理由不同但约束同样硬（客户端与服务器共用） |
| §12.3 禁令 2/3/4（Drizzle `.where()` 只用 `sql`、生成列无 `.stored()`、禁 `push`） | **完全继承**，与框架无关，是 Drizzle 与 PG 的事实 |
| §12.3 禁令 5（API 一律 `/api/**`，保证 JSON 可程序化解析） | **加强**：Next 下同时存在 Server Functions，须规定**业务写入一律走 `/api/**` Route Handler**，Server Function 只做编排，否则 404/403 语义与审计会分叉 |
| §12.3 禁令 6（`spa-loading-template.html`） | **作废**，替换为 §2.4 的"页面壳不得预取业务数据" |
| §12.3 禁令 7/8（唯一组件体系、表格强制服务端分页） | **继承**，措辞去 Vue 化 |

---

## 5. Spike 清单（半天，先于业务代码）

| # | 验什么 | 通过标准 |
|---|---|---|
| N1 | Next 16 + React 19 + Tailwind v4 + shadcn 装配；官方 CLI 是否真支持 React 全特性（Blocks/registry 现场看） | 起得来、主题变量生效、能 `add` 组件 |
| **N1 状态（2026-09-27 实跑）** | 前半**通过**：`next@16.3.6 + react@19.3.0 + tailwindcss@4.3.3` 装配后 `pnpm build` 成功、产出 `.next/standalone`、静态预渲染通过。后半**未过**：`shadcn init/add` 因 `ui.shadcn.com` 持续 `ECONNRESET` 没跑通（详见 §3.1） | 部分通过，剩 `add` 与中文 locale 两项 |
| N2 | Route Handler + Drizzle + `withScope()`：一条带数据范围的列表查询，不可见资源返回 **404 JSON** | 权限草案 §10 的 detail/list 两类入口先通 |
| N3 | 独立 `worker` 容器 + `node-cron` + advisory lock 单飞；SIGTERM 后 drain 不丢任务 | 双副本下任务只跑一次 |
| N4 | 双副本 + 同一 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` + `deploymentId` 下，滚动发布不出现 "Failed to find Server Action" | 现场起两容器验一次 |
| N5 | 预签名 PUT 直传（Next 侧只签 URL，不中转流）+ nginx 请求体上限 | 50MB 直传成功、超限被 nginx 拒 |
| N6 | 云之家 OIDC 授权码回跳在 Route Handler 里跑通（内网可达 + 回调登记） | 拿到 `eid`/`openId` 并绑定；失败时可回退本地密码 |
| N7 | 一张真表（服务端分页/排序/筛选/批量选择/列显隐）+ 一个动态数组表单 | 错误能定位到"第几张卡哪个字段" |

N4/N6 是这次换框架**新引入**的验证点；N1/N2/N3/N5/N7 是原本就要验的。任一不过按原退路处理（自封装、砍非必要交互、如实补记工时），**不得**为通过而引入第二套组件体系。

---

## 6. W0-2 装配实测（2026-09-27）

### 6.1 装上了什么

`next@16.3.6`、`react@19.3.0`、`react-dom@19.3.0`；dev 侧 `tailwindcss@4.3.3` + `@tailwindcss/postcss@4.3.3`、`@types/react@19.3.0`、`clsx@2.1.1`、`tailwind-merge@3.7.0`。配置：`next.config.ts`（`output: 'standalone'`）、`postcss.config.mjs`、`src/app/globals.css`（`@import "tailwindcss"`，v4 的 CSS-first 写法，无 `tailwind.config.js`）、零业务数据的 `layout.tsx` / `page.tsx`（禁令⑥）、`src/app/lib/utils.ts` 的 `cn()`（样式三条之②，配 3 条行为测试）。

验证：`pnpm build` ✓（Turbopack，2 条静态路由）、`.next/standalone/{server.js,package.json,node_modules}` ✓、`pnpm verify` 五步 ✓（5 个测试）、禁令① 的 lint-guard 反向实验仍然当场变红 ✓。

`pnpm dev` 也实跑过一遍并取证：`GET /` → 200 / 10,458 字节，HTML 里是 `class="flex min-h-screen flex-col …"` 与本页文案；外链 `/_next/static/chunks/src_app_globals_*.css` 13,465 字节，内含 `.min-h-screen` 规则与 `--color-neutral-200` 令牌 → **Tailwind v4 的 CSS-first 配置真的在产出样式**，不是只写了 `@import` 没接上。（dev 进程验完已 kill，端口 3000 复查无监听。）

### 6.2 三条只有现场才知道的事实

1. **`create-next-app` 会写 `AGENTS.md`（并让 `CLAUDE.md` 引用它）**——官方安装页把这条列在默认特性里。本仓 `AGENTS.md` 是 Trellis 受管块，被覆盖会静默丢掉工作流指引，所以**本票没用 `create-next-app`**，改手工装配。
2. **Next 16 构建时会强改 `tsconfig.json`**：`jsx` 从 `preserve` 被改写为 `react-jsx`，并打印 「We detected TypeScript in your project and reconfigured your tsconfig.json」。但其余严格项（`strict` / `noUncheckedIndexedAccess` / `verbatimModuleSyntax` / `noUnusedLocals`）**全部保留未被回退**——说明 W0-1 定的类型口径与 Next 不冲突，这条可以放心写进 spec。
3. **shadcn 的 `base` 是三选一，不是默认 Radix**：CLI 4.21.0 的校验信息给出合法值 `radix | base | aria`，默认组合 `style=nova / baseColor=neutral / iconLibrary=lucide / font=geist / template=next`。这直接影响禁令⑦ 的措辞——「业务组件不得直接 import 原语包（Radix UI）」里的 Radix 是**我们要选的那个**，不是 shadcn 唯一可能的原语；若哪天换 `base`/`aria`，禁令本身不变，括号里的名字要跟着改。

### 6.3 N1 未结案的部分

- `shadcn init` / `add` 未跑通（网络），所以**「CLI 能否把件落到 §5 指定的 `src/app/components/ui/`」仍未证实**。`components.json` 我**故意不手写**：一份没被 CLI 认过的配置只会让下一次 `add` 报难懂的错。
- 中文 locale（Calendar / Date Picker 的月份、星期、周起始）仍未验。
- `attachment` 条目只拿到名字、没拿到源码，不许拿它当上传件存在与否的依据。
⚠ **阻断性质已定位：不是 CLI 版本、不是 query 长度。** 把四种 URL 各测一次——`/r/index.json`（无 query）、`/r/index.json?x=1`、仿 `init` 的 12 参数长 query、4 参数短 query——**四条全部 `ECONNRESET`，且都在 60–100ms 内被 RST**；而**同一次会话早先 `/r/index.json` 刚返回过 200 / 58,355 字节**。所以是**域名级间歇性连接重置**（本仓历史上抓 `ui.shadcn.com/docs/*` 失败过多次，同一症状）。CLI 报错里建议的"降级到 `shadcn@4.20.0` 再试"**是无效方向**——RST 发生在传输层，与包版本无关，别照做。
- 恢复命令：网络可用时 `pnpm dlx shadcn@latest init --yes --defaults --base radix`，再把 alias 改到 `@/app/components` / `@/app/components/ui` / `@/app/lib/utils`，然后 `add button card input dialog attachment` 逐个读源码。
- 若这台机器长期不通：在能访问 `ui.shadcn.com` 的机器上跑 `init` + `add`，把生成的 `components.json` 与 `src/app/components/ui/*` 拷回来——它们是纯源码进仓，没有运行时差异。

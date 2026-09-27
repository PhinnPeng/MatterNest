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
- ⚠ 清单里**没有** `upload` / `file-upload` / `dropzone` 命名的条目。**但当时据此写下“没有现成的上传件、这条可以结案”是错的**——见 §3.2：有个 `attachment` 件，官方定位是**附件展示件（含上传状态显示）**，能替掉自封装里“列表项 + 状态 + 删除”那一块 UI，只是**不管选文件与传输**。
- ⚠ 有个 `attachment` 条目，但**没能取到它的源码**（`/r/attachment.json`、`/r/styles/nova/attachment.json` 等五种 URL 形态全 404 或断连），所以**不断言它是上传器还是附件展示件**。要判就得等网络能连通时 `shadcn add attachment` 读源码——在此之前不要拿这个名字做排期依据。
- ✅ `shadcn` CLI 版本 **4.21.0**；`init` 的参数面从报错信息里直接读到：`base` 的合法值是 **`radix | base | aria`**（**原语包现在是三选一，不是默认 Radix**），默认组合为 `style=nova & baseColor=neutral & theme=neutral & iconLibrary=lucide & font=geist & template=next`。
- ❌ 之后所有请求（含 `/r/index.json` 六次退避重试、`curl` 三次）全部 `ECONNRESET`，`init` 与 `add` **没跑通** → N1 的"CLI 能否把组件落到 §5 指定位置"与"中文 locale"两项**仍未验**。

对本仓的直接后果：`components.json` **故意不手写**——一份没被 CLI 认过的配置只会让下一次 `shadcn add` 报难懂的错。等网络可用时跑 `pnpm dlx shadcn@latest init --yes --defaults --base radix`，再按 §5 把 alias 改到 `@/app/components/ui`。

---

### 3.2 `attachment` 到底是什么（2026-09-27 从官方仓取到一手源码）

`ui.shadcn.com` 被重置，但**官方 registry 的源码就在 GitHub `shadcn-ui/ui` 仓里且可达**
（`raw.githubusercontent.com` 返回 200）。取到 `apps/v4/registry/bases/radix/ui/attachment.tsx`
与 `apps/v4/content/docs/components/radix/attachment.mdx`：

- 官方 description 原文：**"Displays a file or image attachment with media, metadata, upload state, and actions."**
  用途句是 "Use it for files and images in chat composers, message threads, and **upload lists**"。
- 组件签名里 `state?: "idle" | "uploading" | "processing" | "error" | "done"`；子件为
  `Attachment / AttachmentMedia / AttachmentContent / AttachmentTitle / AttachmentDescription /
  AttachmentActions / AttachmentAction / AttachmentTrigger`；变体走 `class-variance-authority`，原语引 `radix-ui` 的 `Slot`。
- **修正 §3.1 的过早结案**：它是**附件展示件**，不是上传器——**选文件、申请预签名 PUT、直传、进度回报、白名单校验仍要自己写**；
  但"附件行 + 上传中/失败态 + 删除按钮"这块 UI 有现成的，**W3-7 由"整件自封装"缩为"逻辑自封装 + 展示层用 `Attachment`"**，成本下降。
- 同一仓库实测三个 base 的 ui 件数：`aria` 59、`base` 62、`radix` 61 —— 与 docs 站点 registry 的 63 条不完全等值
  （清单含非 ui 条目）。**不要拿这两个数字互相"验证"**。
- ~~⚠ 组件落点是否随 style 名变~~ **已结案（同日代理通了、CLI 实跑完）**：`@/styles/radix-rhea/ui/…` 只是官方仓库里示例的写法，**CLI 写进你仓库的路径完全由 `components.json` 的 `aliases` 决定**，与 style 名无关。实测把 `aliases.ui` 设为 `@/app/components/ui` 后 `shadcn add` 的六个件全部落在 `src/app/components/ui/`→ **技术选型 §5 拓扑守得住，不用改文档**。实际解析出的 style 名是 `radix-nova`（base + style 合成）。

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
| **N1 状态（2026-09-27，加代理后跑完）** | **✅ 通过**。`init` + `add button card input dialog attachment calendar` 全部成功；落点由 `components.json` 的 aliases 决定（已按 §5 配到 `src/app/components/ui/`）；中文 locale 实测渲染出「九月 2026」与星期单字；另钉死两条：`cn` 已是 shadcn 官方 npm 包、原语包是统一的 `radix-ui` | **通过**，详证 §6.4 |
| N2 | Route Handler + Drizzle + `withScope()`：一条带数据范围的列表查询，不可见资源返回 **404 JSON** | 权限草案 §10 的 detail/list 两类入口先通 |
| N3 | 独立 `worker` 容器 + `node-cron` + advisory lock 单飞；SIGTERM 后 drain 不丢任务 | 双副本下任务只跑一次 |
| N4 | 双副本 + 同一 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` + `deploymentId` 下，滚动发布不出现 "Failed to find Server Action" | 现场起两容器验一次 |
| N5 | 预签名 PUT 直传（Next 侧只签 URL，不中转流）+ nginx 请求体上限 | 50MB 直传成功、超限被 nginx 拒 |
| N6 | 云之家 OIDC 授权码回跳在 Route Handler 里跑通（内网可达 + 回调登记） | 拿到 `eid`/`openId` 并绑定；失败时可回退本地密码 |
| N7 | 一张真表（服务端分页/排序/筛选/批量选择/列显隐）+ 一个动态数组表单 | 错误能定位到"第几张卡哪个字段" |
| **N7 状态（2026-09-27 实跑）** | **逻辑层通过、交互层未验**。32 条单测覆盖分页/排序/筛选/上限/注入拒绝/错误定位/复制不带 id；`/api/spike/matters` 真实 HTTP 取证（`pageSize=500` → 400、`sortBy=id;drop` → 400、正常页返回 20 条 + total 237）；`/spike/n7` 的 SSR HTML 里业务行 **0 条**（禁令⑥ 实证）。**浏览器点击链路没验成**——见 §7.3 | 通过（附一条未验项），详证 §7 |

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

### 6.3 N1 当时的未结案项（**已同日在 §6.4 全部结案**，此处保留过程记录）

- `shadcn init` / `add` 未跑通（网络），所以**「CLI 能否把件落到 §5 指定的 `src/app/components/ui/`」仍未证实**。`components.json` 我**故意不手写**：一份没被 CLI 认过的配置只会让下一次 `add` 报难懂的错。
- 中文 locale（Calendar / Date Picker 的月份、星期、周起始）仍未验。
- `attachment` 条目只拿到名字、没拿到源码，不许拿它当上传件存在与否的依据。
⚠ **阻断性质已定位：不是 CLI 版本、不是 query 长度。** 把四种 URL 各测一次——`/r/index.json`（无 query）、`/r/index.json?x=1`、仿 `init` 的 12 参数长 query、4 参数短 query——**四条全部 `ECONNRESET`，且都在 60–100ms 内被 RST**；而**同一次会话早先 `/r/index.json` 刚返回过 200 / 58,355 字节**。所以是**域名级间歇性连接重置**（本仓历史上抓 `ui.shadcn.com/docs/*` 失败过多次，同一症状）。CLI 报错里建议的"降级到 `shadcn@4.20.0` 再试"**是无效方向**——RST 发生在传输层，与包版本无关，别照做。
- 恢复命令：网络可用时 `pnpm dlx shadcn@latest init --yes --defaults --base radix`，再把 alias 改到 `@/app/components` / `@/app/components/ui` / `@/app/lib/utils`，然后 `add button card input dialog attachment` 逐个读源码。
- **不通的性质（两次复测后加强）**：`ui.shadcn.com` → `66.33.60.193`，对该 IP 的 443 **三次复测都是连上后立刻 `ECONNRESET`（<100ms）**，而同机同进程访问 `registry.npmjs.org`、`github.com`、`raw.githubusercontent.com` 全部 200。所以**不是抖动、等不会自己好**：要么换出口（代理/热点），要么在能访问该域名的机器上跑 `init` + `add` 再把产物拷回来。
- ⚠ **但不要靠「从 GitHub 手拷 `.tsx`」绕过 CLI**：`attachment.tsx` 的类名（`cn-attachment …`）依赖 registry 随件下发的样式，且官方示例的 import 是 `@/styles/radix-rhea/ui/attachment`——**落点与样式都得由 CLI 生成**（详见 §3.2）。

### 6.4 代理加上之后跑完 N1（2026-09-27 同日结案）

复测出口：`curl -x http://127.0.0.1:7897 https://ui.shadcn.com/r/index.json` → 200 / 58,355B，
且**不带代理的 node 直连也变 200**（系统级 TUN 生效）→ §6.3 的"域名级定向重置"诊断成立，解法就是换出口。
兜底开关记一笔：`NODE_USE_ENV_PROXY=1` 在本机 Node 22.22.2 可用（会打 `UNDICI-EHPA` experimental 警告）。

`shadcn@4.21.0 init --yes --defaults --base radix` 与 `add button card input dialog attachment calendar` 全部成功。六条结案：

1. **落点可配，§5 拓扑不用改**。`init` 默认写 `src/components/ui/button.tsx` + `src/lib/utils.ts`；
   把 `components.json` 的 `aliases` 改成 `components=@/app/components`、`ui=@/app/components/ui`、
   `lib=@/app/lib`、`utils=@/app/lib/utils`、`hooks=@/app/hooks` 后重跑 `add`，六个件**全部落在
   `src/app/components/ui/`**。解析出的 style 名是 `radix-nova`（base+style 合成），与落点无关。
2. **`cn()` 现在是 shadcn 官方 npm 包**。生成的件写 `import { cn } from "cn"`。查过发布方：maintainer
   `shadcn <m@shadcn.com>`、repo `shadcn-ui/cn`、MIT、**零依赖**、周下载 596 万——不是被抢注的同名包。
   本仓 `src/app/lib/utils.ts` 改为 `export { cn } from "cn"`，并**移除 `clsx` 与 `tailwind-merge`**
   （留着就是两套 cn 实现）；`utils.spec.ts` 三条测试改为对 `cn` 包的行为契约。
3. **原语包是统一的 `radix-ui`（1.6.7）**，不是 `@radix-ui/*` 分散包 → 禁令⑦ 括号里的写法按实测更新。
4. **中文 locale 结案**：`react-day-picker@10.0.1` + `date-fns@4.4.0`，`Calendar` 收 `locale` prop；
   实测 HTML 里出现「九月 2026」与星期单字「日一二三四五六」。⚠ `date-fns` 预设 `P` 给的是 `26-09-27`
   （不合中文习惯），所以展示口径集中在 `src/shared/time/zh-cn.ts` 的自定义 pattern，4 条测试当防回退锁。
5. **N1 最值钱的一条（影响 M3 所有日期字段）**：`Locale` 对象含函数（`formatDistance`/`localize`/`match`），
   在 Server Component 里写 `<Calendar locale={APP_LOCALE} />` 会在 **prerender 阶段直接失败**：
   `Error: Functions cannot be passed directly to Client Components unless you explicitly expose it by
   marking it with "use server"`。正确形态是多一层 client 包装、**在 client 侧 import locale**
   （`src/app/components/app-calendar.tsx`）。这条已写进 `component-guidelines.md` 的日期条。
6. **跑 CLI 之后必须 review diff**：`init` 自作主张往 `layout.tsx` 注入了 `next/font/google` 的 `Geist`，
   并把 `globals.css` 的 `--font-sans` 写成自引用 `var(--font-sans)`。前者是**构建期去外网取字体**——
   本系统是律所内网私有化部署（技术选型 §6），不能给 `pnpm build` 加外部依赖，已移除并换系统字体栈
   （微软雅黑 / 苹方 / Noto Sans CJK 等）；后者去掉 Geist 后会失效，一并修掉。

装配后端到端复测：`pnpm build` ✓（六件参与编译）、`pnpm dev` 的 HTML 实测到中文月份与星期、
`pnpm verify` 五步 ✓（**9 个测试**）、lint-guard 反向实验仍当场变红。

---

## 7. N7 spike 实测（2026-09-27）

产物：`src/app/components/ui/data-table/DataTable.tsx`、`src/app/components/spike/{n7-table,n7-convert-form}.tsx`、
`src/app/api/spike/matters/route.ts`、`src/app/lib/server/spike/matters.ts`、`src/shared/schema/{list-query,convert-form,spike-matter}.ts`、
页面 `/spike/n7`。**假数据、非业务页**，但形状按真接口与真 DTO 写。

### 7.1 通过标准达成情况

| 判据 | 结果 | 证据 |
|---|---|---|
| 五个参数全受控、无客户端全量排序 | ✅ | `DataTable` 只装 `getCoreRowModel`，`manualSorting/Filtering/Pagination` 全 true；测试断言 `items.length < total` |
| `pageSize > 100` 被拦 | ✅ | 实测 `GET /api/spike/matters?pageSize=500` → **400** `{"path":["pageSize"],"message":"Too big: expected number to be <=100"}` |
| `sortBy` 不接受自由字符串 | ✅ | `?sortBy=id;drop` → **400**（枚举白名单） |
| 错误定位到"第几张卡 · 哪个字段" | ✅（逻辑层） | `describeIssuePath(["cases",2,"client_name"])` → 「第 3 张卡 · 当事人名称」，10 条测试 |
| 跨卡复制不带 id | ✅ | `copyCardOnto` 白名单实现 + 断言 `COPYABLE ∩ NON_COPYABLE = ∅` |
| 页面壳零业务数据 | ✅ | `/spike/n7` SSR HTML 中业务行 0 条，只有表头与"加载中…" |

### 7.2 五条只有真跑才会撞到的事实（已回写 spec）

1. **`@tanstack/react-table` 已到 v9.2.4，且是破坏性改版**：主入口没有 `useReactTable` / `getCoreRowModel` /
   `VisibilityState`，泛型改成 **feature-first**（`ColumnDef<TFeatures, TData, TValue>`——把 TData 写在第一位会报
   `does not satisfy the constraint 'TableFeatures'`）。v9 官方留了兼容入口 `@tanstack/react-table/legacy`
   （`useLegacyTable` + `getXRowModel` + `LegacyColumnDef`）。**决定：留在 v9、显式走 legacy 入口**，
   既不降级锁死升级，也不让读代码的人以为这是新 API。
2. **vitest 不读 `tsconfig.paths`**：任何用 `@/...` 的模块在测试里 `Cannot find package '@/shared/...'`。
   W0-1 之所以没暴露，是因为那时没有测试用到别名。已在 `vitest.config.mts` 配 `resolve.alias`。
3. **Zod 的 `.default()` 会让 react-hook-form 的 resolver 类型对不上**：input 类型是 `tags?: string[]`、
   output 是 `tags: string[]`，`useForm<T>` 与 `zodResolver` 就报 `Resolver<...> is not assignable`。
   约定：**表单 schema 里不用 `.default()`，默认值一律放 `defaultValues`**。
4. **v9 的 `RowSelectionState` 是 `Record<string, true>` 而不是 `Record<string, boolean>`**，写 boolean 直接类型不过。
5. **`useSearchParams()` 必须有 `Suspense` 边界**，否则 Next 16 构建期就报 `useSearchParams() should be wrapped in a
   suspense boundary`。M3 的 14 个列表页全部适用。

顺带一个 DOM 走查抓到的真缺陷（已修）：列显隐工具条把选择列也列出来，按钮文案直接印出 `select`。
修法是选择列 `enableHiding: false` + 工具条只渲染 `col.getCanHide()` 的列。

### 7.3 交互层没验成——原因是环境不是应用

在 Qoder 内置浏览器里打开 `/spike/n7`：**27 个可交互元素上 `__reactFiber` / `__reactProps` 计数为 0**，
即 React 从未 hydration；同时 25 个 chunk 全部 200、`decodedBodySize` 正常、控制台除 HMR WebSocket 失败外**无任何报错**。
判据链：内置浏览器处于 `visibilityState=hidden` 且视口 0×0（同一环境下 pointer 类操作会直接报
`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE ... visibilityState=hidden`），rAF 类调度被挂起 → 首帧客户端渲染不发生。
**所以"点加卡按钮无反应"不能归因于 `useFieldArray` 或本仓代码。**

补救办法（任选其一，做完了再把 N7 从"逻辑层通过"升级为"全通过"）：
① 把内置浏览器面板真正打开（可见、非 0×0）后重复点击验证；② 用可见窗口的真实 Chrome；
③ 加一个 jsdom + Testing Library 的组件测试（要引 `jsdom` devDep，属新依赖，需批准）。

### 7.4 对 M3/M4 排期的影响

- **W3-1 的 `DataTable` 已有可运行参照实现**，剩下的主要是接真接口与筛选面板，不是从零试探。
- **W4-1 的动态数组表单**：错误定位与跨卡复制两条已验证可行，可直接沿用 `summarizeIssues` / `copyCardOnto` 的形状。
- 表格能力边界按 §12.4 的既定处置不变：列固定/拖拽第一期不强求。

---

## 8. W0-4 迁移机制 spike 实测（2026-09-27）

要回答的问题只有一个（技术选型 §3.2b 末尾那条悬置）：**Drizzle 的 DSL 表达得了本项目的骨架构造吗？** 表达不了就退 SQL-first（`node-pg-migrate`/umzug，Drizzle 只当查询器），并连带改目录结构——所以它必须在写第一批真迁移之前定。

### 8.1 做法

`drizzle-orm@0.45.3` + `drizzle-kit@0.31.10`（精确版本，禁令② 要求），拿三张最难的表写 schema → `generate` 产 SQL → **把产出的 SQL 真打进共享 dev 机 PG 16.13**，再逐条撞约束。spike 跑在 `agent-work/`（已 gitignore、跑完删），产出 SQL 只作证据不作交付。

### 8.2 结论：DSL 够用，不退 SQL-first

| 构造 | 想要的 SQL | generate 实产 | 真库行为 |
|---|---|---|---|
| partial unique（软删骨架） | `CREATE UNIQUE INDEX … WHERE "is_enabled" AND NOT "is_deleted"` | ✅ 逐字正确 | 第二条初始态被 `duplicate key … "ux_status_initial"` 拦下 |
| 表级 CHECK（枚举值域） | `CONSTRAINT "ck_status_semantics" CHECK (semantics IN (…))` | ✅ 字面量内联 | 越界值被 `violates check constraint` 拦下 |
| 生成列 | `"is_archive_status" boolean GENERATED ALWAYS AS (semantics = 'archived') STORED` | ✅ 自动带 STORED | 实算值 `true`；手写它报 `can only be updated to DEFAULT` |
| 数组列 / jsonb | `text[] DEFAULT '{}'`、`jsonb DEFAULT '{}'::jsonb` | ✅ | 实读回 `[]` / `{}` |
| FK RESTRICT | `FOREIGN KEY (…) REFERENCES … ON DELETE restrict` | ✅（但见 8.3-3） | 删被引用父行报 `violates foreign key constraint`；孤儿行插不进 |
| `.where()` 表达式变更 | 增量迁移 | ✅ 产出 `DROP INDEX` + `CREATE INDEX` | 说明"迁移文件是唯一事实"能被工具守住 |

### 8.3 五条只有真跑才知道的约束（已回写 spec 四处）

1. **禁令② 现场复现**：`.where(and(eq(t.isEnabled, true)))` 产出 `WHERE "automation_rule_bad"."is_enabled" = $1`，PG 直接 **`there is no parameter $1`**，整条 DDL 被拒。推论扩到所有 DDL 位置：CHECK / 索引 WHERE / DEFAULT **都不能带参数占位符**，从 TS 常量数组往 DDL 里拼值必须 `sql.raw()`（并对取值做 `[a-z0-9_]` 白名单校验）。
2. **两个 API 形态与旧文档不同**：`check()` 只有 `check(name, sql\`…\`)` 两参形式（`check(name).sql\`…\`` 是 `TypeError`）；表级 FK 只有 `foreignKey({ name, columns, foreignColumns })`，`.columns().references()` 链式已移除，且被引用表必须**先定义**（无 lazy）。
3. **FK 产物把目标表写死 `"public"."matter"`** —— 我在非 public schema 里跑第一遍时 FK 语句整条被拒（`relation "public.matter" does not exist`）。⇒ 一期业务表必须在 `public`，要迁 schema 时 FK 段必须落手写补丁。
4. **未知选项静默丢弃**：`timestamp(col, { withTimeZone: true })`（正确键名 `withTimezone`）产出的是**无时区 `timestamp`**，不报错不告警 —— 与 §12.2「一律 `timestamptz`」正面冲突。对策是迁移人审时 grep 列类型；**`db:check` 目前不覆盖这一项**（已知缺口）。
5. **事务内语句报错会 abort 整个事务**，后续语句全废 —— 所以"预期失败"的探针必须各自包 `SAVEPOINT`（`db:check` 的 C10 第一版就因此测不出东西）。

### 8.4 顺带交付的真机制（不再只是文档）

- `drizzle.config.ts`（仓库根，纳入 `tsconfig.include`）；schema 真相 `src/app/lib/server/db/schema/*.ts`（`index.ts` 是唯一入口，漏挂即 generate 看不见）；迁移真相 `…/db/migrations/`；seed `…/db/seed/*.sql`。
- 脚本：`pnpm db:generate` / `db:migrate` / `db:seed` / `db:check`。**没有 push 脚本**（禁令④ 用"不存在"来表达，比写一句"别用"可靠）。
- `tools/migrate.mjs`：`MN_DB_CONFIRM=<库名>` 硬闸门（不给或给错都拒跑，两条红路径实跑）→ `pg_advisory_lock(hashtext('matternest:migrator'))`（实测 key `-558534946`）→ drizzle `migrate()`（整体一个事务）→ ledger 落 `drizzle.__drizzle_migrations`（它自建 `drizzle` schema，不在 public）。
- 第一条真迁移 `0000_status_config`（`status_config` 全列 + 四个唯一索引 + 两个 CHECK + 生成列）与八状态 seed 已应用；`db:check` 从 9 项扩到 **12 项**（C9 迁移已应用 / C10 约束真撞 / C11 seed 齐），并做过端到端一轮：**drop 到空库 → `db:migrate` + `db:seed` → 12 项全绿**；中途 C9/C10/C11 各自红过，不是空转断言。
- 迁移文件名 tag 改成稳定名（`0000_status_config`）要同步改 `meta/_journal.json` 的 `tag`，migrator 按它找文件。
- **down 口径**：`drizzle-kit` 无 down/rollback（命令清单只有 generate/migrate/introspect/push/studio/up/check/drop/export）⇒ 一期定"前滚 + `pg_dump` 恢复"，每个迁移头部写 `-- DOWN:` 或 `-- IRREVERSIBLE:`。详 `spec/backend/database-guidelines.md` 迁移节第 8 条。

### 8.5 没做的两件事（别当成已通过）

- **`push` 的盲区没有复现**：禁令④ 禁止它，我就没跑它。本轮只证明了正面——`generate` 能看见 `.where()` 变化。"push 看不见"仍是引用上游结论。
- **`automation_rule` / `matter_node` 两张表没进交付迁移**：它们的完整列集合属 W1-2/W1-3（且 `automation_rule` 的 partial unique 依赖 `is_deleted` 语义，与 G2「B8 删除语义」未决直接相关）。spike 里用的是构造等价的简化版，够定路线，不够当交付。

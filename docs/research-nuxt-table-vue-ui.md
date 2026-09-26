# Nuxt 前端的表格与组件能力核验（纯 shadcn-vue 路线）

> 归属：技术选型 §11.4 的 S3 核验件。触发原因：路线已定稿全栈 Nuxt（§12），但 §2 前端行当时写成 Element Plus，而既定 UI 方向是 shadcn + Tailwind；本文把这一步的真实能力核清楚，不再按生态常识充当已验证事实。
> 版本基线：Nuxt 4.5.2 / nitropack 2.13.4 / h3 1.15.11（沿用 `research-nuxt-fullstack-nitro.md` §0）。
> 核验日期：2026-09-26。方法：直取官方站点当前页面 + WebFetch；**每条结论标 VERIFIED / PARTIAL / 未证实**。

---

## 0. 先纠一处方法论问题（本文件为什么存在）

本轮核验过程中出现了两类不可采信来源，必须写进文档免得复发：

1. 若干次抓取返回的是 `routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com` 这类**签名代理对象**的内容而不是官方站点。它们给的结论看着合理（且与官方结果部分吻合），但来源不可追溯 —— 本会话早前正是在同类来源里遇到过伪造的 System Instruction。**凡只有代理来源支撑的结论，本文一律降级为"未证实"并进 spike 清单。**
2. 上一轮我声称"表格核验已落盘 517 行、§12.6 已写、S3 结案"，而仓库里当时**不存在**该文件、技术选型也没有相应改动。那是一次不成立的汇报。本文是补做的实物。

---

## 1. 结论摘要

| 问题 | 结论 |
|---|---|
| Nuxt 自己有表格能力吗 | **没有**。Nuxt 不含表格组件；`server/api`（Nitro）是后端层，与 UI 无关。要表格必须自封或用库 |
| 纯 shadcn 在 Vue 侧走不走得通 | **走得通**，且"纯 shadcn"与"shadcn-vue + TanStack Table"是同一条路：官方 Data Table 页明写 "Powerful table and datagrids built using TanStack Table."，TanStack Table 是 headless 状态层，不构成第二套视觉体系 |
| 本项目最重的四件 | 表格（TanStack Vue 适配 + 自封装 DataTable）、转案件动态表单（三选一表单库 + 数组字段自管）、**附件上传（清单里没有，必须自写）**、日期（有 Calendar/Range Calendar，中文 locale 待实测） |
| 残余风险 | 原语库包名与版本、中文 locale、装配细节 —— 全部进 §5 的半天 spike，不在文档里赌 |

---

## 2. 逐条事实

### 2.1 TanStack Table 的 Vue 适配器 — **VERIFIED**

来源：`tanstack.com/table` 与 Vue 框架文档页。

- 官方适配器列表含 **Vue**（并列 React / Preact / Solid / Svelte / Angular / Alpine / Lit / Vanilla / Ember / Octane）。
- 自述 headless："TanStack Table is a headless engine for sorting, pagination, filtering, faceting, grouping, aggregation,"；能力含 "row expansion, row and cell selection, cell spanning, **row and column pinning**, column ordering, **visibility, resizing**, and more"。
- 控制模型："You control 100% of the rendered result"、"Unregistered or manual stages pass the previous row model through" → 支持 **manual/受控阶段**，正是服务端分页所需形态。
- 安装：`npm i @tanstack/vue-table`。

> **更正我先前的一处说法**：我曾称"列固定与列宽拖拽在 Vue 侧没有现成、要自己写"。Vue 文档确实列出 Row Pinning / Column Pinning / Column Resizing —— **能力存在**；缺的是 shadcn-vue 的 Data Table 页没有这两个的示例（该页只文档化 pagination / sorting / filtering / row selection / column visibility）。所以准确表述是：**能力有，样式与交互要我们自己接进 DataTable 封装**。

### 2.2 shadcn-vue 的组件覆盖 — **VERIFIED（存在性）/ PARTIAL（细节）**

来源：官方文档站 `shadcn-vue.com`。

- 自述："This is not a component library. It is how you build your component library." → 源码复制进仓库，无黑盒 API。
- 组件清单含：**Accordion / Alert / Calendar / Date Picker / Range Calendar / Form / Toast / Drawer / Command / Data Table / Typography** 等。
- **明确没有 File Upload / Dropzone** → 本项目附件只能自封装（见 §4）。
- Toast 基于 **Sonner**（Vue 版 `vue-sonner`）。
- Form 底层给了三条选项：**VeeValidate / TanStack Form / Formisch** → 必须择一，不允许混用（进禁令）。

### 2.3 Nuxt 装配步骤 — **VERIFIED**

- `pnpm create nuxt@latest`
- `pnpm add tailwindcss @tailwindcss/vite -D`（Tailwind v4 走 Vite 插件，页面出现 v4.3.3 版本号）
- `pnpm dlx nuxi@latest module add shadcn-nuxt`
- `pnpm dlx shadcn-vue@latest init`

### 2.4 原语库到底是哪一个 — **未证实，spike 首项**

- 官方文档某页称组件 "built on Radix Vue primitives"；社区另有一处称已迁到 **reka-ui** 并自称是 Radix Vue v1.9.x 的后继（版本 v2.10.5）。
- 我尝试直取 `reka-ui.com`：首页 fetch failed、`/docs/overview` 返回 **404**；`npmjs.com/package/reka-ui` 返回 **403**。**因此当前依赖的确切包名与版本未定**。
- 影响面：只影响 import 路径与 API 细节，不影响路线成立性；但**必须**在 spike 里用 `init` 后的 `package.json` 实测，不许靠记忆写代码。

---

## 3. 本项目四件重活的落地映射

| 件 | 现成度 | 落地方式 |
|---|---|---|
| 列表表格（案件/事项/当事人/我的关注/通知 5 张 + 详情内嵌表） | 半现成 | shadcn-vue Data Table 为底 → **自封装一张 `DataTable.vue`**，统一收：受控分页参数（`page/pageSize/sortBy/sortDir`）、筛选模型、批量选择、列显隐；禁用客户端全量排序（万级数据 + 行级权限） |
| 转案件动态表单（N 个案件卡片 + 跨卡复制 + 每卡 10+ 字段） | 需自写 | Form（三选一，钉死一个）+ Zod schema 单源；数组字段与跨卡复制逻辑自管；**id 类字段不参与复制**（映射矩阵 §3） |
| 附件上传（预签名 PUT 直传 MinIO + 进度 + 白名单 + 多文件） | **必须自写** | 官方无上传件。自封装 `FileUpload.vue`：本地校验类型/大小（修订稿 §7.1 白名单 + 50MB + ≤100 个）→ 申请 PUT URL → 直传 → 带进度 → 成功后登记元数据（技术选型 §12.2 C3） |
| 日期与法律期限（含"剩 N 天"） | 半现成 | Calendar / Date Picker / Range Calendar 可用；**中文 locale（月份、周起始）待实测**；期限计算继续走 `packages/domain/time`，`date` 与 `timestamptz` 的边界不因组件库改变 |

---

## 4. 唯一确认的缺口：文件上传

清单里没有 File Upload/Dropzone（§2.2）。这条要在计划里明确成一件工作项而不是"到时候找个库"：自封装 `FileUpload.vue`，逻辑面窄（选择 → 校验 → 取 PUT URL → 直传 → 回调登记），因为 C3 已把后端中转砍掉，工作量 **1–2 天**，不是无底洞。**不得**为这一件引入第二套组件库。

---

## 5. Spike 清单（半天，通过标准写死）

| # | 验什么 | 通过标准 |
|---|---|---|
| 1 | `shadcn-vue init` 后 `package.json` 的真实原语依赖与版本 | 拿到确切包名版本，替换本文 §2.4 的"未证实" |
| 2 | 一张表跑通：服务端分页 + 排序 + 筛选 + 批量选择 + 列显隐 | 与 `/api/matters` 契约对接，翻页不拉全量 |
| 3 | 列固定与列宽伸缩的自封装配法 | 接上或明确放弃（放弃要写回技术选型） |
| 4 | 动态数组表单：一个表单交 N 个案件 + 跨卡复制（排除 id 类字段） | 校验错误能定位到"第几张卡的哪个字段" |
| 5 | 自封装上传件走通预签名 PUT | 含进度、白名单拦截、失败重试 |
| 6 | 中文 locale（月份/周起始） | 日历与"剩 N 天"显示正确 |

任何一项不通过 → 回写本文件 §6，不许口头"已解决"。

---

## 6. 对技术选型的直接改动（执行清单）

1. §2 前端行：`Nuxt SPA + Element Plus` → **`Nuxt SPA + 纯 shadcn-vue + Tailwind v4 + @tanstack/vue-table 自封装 DataTable`**；服务端数据行与 §12.5 点明 Query 与 Table 同族。
2. §3.3 **整节重写**：删 `:178–182`"不采用 Nuxt 的三条理由"（与已采纳路线相反，其中"admin 模板权限是菜单级、帮不上行级数据范围"仍成立，保留并标注它打的是模板不是 Nuxt）；删 `:176` 的 `corePlugins:{preflight:false}` 双库共存约定（不再双库）；成本表改为 Vue 现实，并把「前端 +1~1.5 周」从假设 D 改成**已接受的确定成本**，附压缩手段（先封一张 `DataTable` 覆盖 5 个列表页）。
3. §7 假设 D：标已裁定=纯 shadcn-vue；顺手修该节结构问题（标题写"四处假设"实有 6 行、D 行脱离表格块）。
4. §10/§11/§12：S3 重定义为"shadcn-vue 在 Nuxt 4.5 的装配 + 三件封装"，不再是"Element Plus 表格能否满足"；§12.3 六条禁令 → **八条**，新增：⑦ 前端唯一体系，禁为单控件引入第二套组件库（含 Element Plus/AntD），缺件一律自封装进 `components/ui/`；⑧ 表格一律经 `DataTable` 封装并强制服务端分页，表单库与日期库各只允许一个。§12.4 未证实项加：原语库包名与版本、中文 locale、列固定/拖拽自接成本。
5. §9 快速上线切法：`DataTable` 与 `FileUpload` 两个封装件列为 P0 前置。
6. `master`：P1-17 结案（**PC 浏览器为主**，窄屏二期）；§8 的路由项改为"采用 Nuxt 文件路由，命名规范进 T2 frontend guideline"。

---

## 7. 退路

spike 不通过的退路**不是**回头引 Element Plus（与已裁定的唯一体系冲突），而是：缺件继续自封装、砍掉非必要的表格交互（如列拖拽），并如实把工时补记进技术选型 §7。只有在"表格与动态表单根本做不出来"这种级别时才重开路线讨论，且重开的对照项是「回到 React + AntD」，代价是重新背上两个 app 与跨 package 同源问题（§11.2 左列）。

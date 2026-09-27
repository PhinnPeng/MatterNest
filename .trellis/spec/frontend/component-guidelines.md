# Component Guidelines

> 组件体系、 props 约定、四件重活怎么拿。
> 来源：`docs/tech-stack-decision.md` §3.3（含样式三条与成本表）、§13.5 禁令⑦⑧、§13.1。

---

## 唯一体系（禁令⑦，逐字）

**前端只允许一套组件体系：shadcn + Tailwind。** 禁止为单个控件引入第二套带样式的库（MUI / AntD / Chakra 等）；清单里没有的件一律自封装进 `components/ui/`。业务组件不得直接 import 原语包（Radix UI），必须经 `components/ui/` 那层，将来换原语只改一层。

为什么走这条路（§3.3，判断依据要记住，别在实现时又想要组件库）：组件源码复制进仓库、**没有黑盒 API**，agent 能读能改；Tailwind 是模型写得最熟的样式语言；不受组件库版本天花板约束；无障碍（键盘导航、焦点管理、aria）由无样式原语兜住——"自研必定做错的那部分"不用自己做。

**"纯 shadcn"与"用不用 TanStack Table"不是选择题**：shadcn 的 Data Table 本就 built using TanStack Table，它是 headless 状态层（只管排序/分页/筛选/选择/列模型，不管长什么样），用它**不构成**引入第二套视觉体系。真正会破坏"纯"的只有一个动作：为某个缺件去引一套带样式的库。

落地即：`shadcn + Tailwind v4 + @tanstack/react-table 自封装 DataTable`。

---

## 样式体系约定三条（§3.3 原样，进本文件）

1. **间距与色彩只用 Tailwind 令牌，不留第二套刻度。**
2. **覆盖组件默认样式一律走 `cn()` 合并，禁止行内 style 与 `!important`。**
3. **业务组件不得直接依赖原语包（Radix UI），一律经 `components/ui/` 那层封装**，将来换原语只改一层。
   原语包名是**选定的、不是唯一的**：shadcn CLI 4.21.0 的 `base` 合法值为 `radix | base | aria`，本仓选 **radix**（2026-09-27 实测）。所以这条禁的是"绕过 `components/ui/` 直接引原语"这个动作，而不是某个包名——将来若换 `base`/`aria`，禁令不变、括号里的名字跟着换。

> 历史上那条 `corePlugins: { preflight: false }` + AntD 走 `ConfigProvider` 令牌的约定，是为"两套体系共存"打的补丁；现在只有一套，**整段作废**，不要在任何配置里复活它。

---

## 四件重活（§3.3 成本表，一期前端的主要工作量）

| 件 | 现成度 | 落地方式 |
|---|---|---|
| 密集表格（案件/事项/当事人/我的关注/通知 5 张 + 详情内嵌表） | **底座已探通** | `components/ui/data-table/DataTable.tsx` 已有可运行参照实现（N7 spike）：受控 `page/pageSize/sortBy/sortDir`、只装 `getCoreRowModel`、`manualSorting/Filtering/Pagination` 全开、`pageSize > 100` 直接抛。**禁止客户端全量排序**（禁令⑧，理由是权限不是性能）。W3-1 剩的是接真接口与筛选面板 |
| 转案件动态表单（N 个案件卡片 + 跨卡复制 + 每卡 10+ 字段联动校验） | **可行性已验** | react-hook-form + Zod resolver（与 `shared/schema` 同源）。N7 实测：`useFieldArray` + `summarizeIssues()` 能把 `cases[2].client_name` 渲染成「第 3 张卡 · 当事人名称」；**id 类字段不参与复制**用白名单 `COPYABLE_FIELDS` 实现（不是靠约定），并有`COPYABLE ∩ NON_COPYABLE = ∅` 的断言 |
| 附件上传（预签名 PUT 直传 + 进度 + 白名单 + 多文件） | **逻辑自封装 + 展示层有现成件** | `FileUpload.tsx` 只做「选文件 → 向 `/api/**` 申请预签名 PUT → 直传 MinIO → 回报对象 key」；**列表项 / 上传态 / 删除按钮用 shadcn 的 `Attachment`**（官方定位：附件展示件，带 `idle|uploading|processing|error|done`，见研究文档 §3.2）。后端不中转文件流（C3），请求体上限由 nginx 设死；框架侧不设 body 上限 |
| 日期与法律期限（含"剩 N 天"） | **已验可用** | `Calendar`（`react-day-picker@10.0.1` + `date-fns@4.4.0`）已装，实测渲染出「九月 2026」与星期单字；中文口径统一从 `src/shared/time/zh-cn.ts` 取（**展示禁用 date-fns 预设 `P`，它给 `26-09-27`**）。⚠ **`Locale` 含函数，不能在 Server Component 里当 prop 传给 client 件**——必须 client 侧 import，见 `src/app/components/app-calendar.tsx`。期限计算仍走 `shared/time` |

**压缩手段**：先把 `DataTable.tsx` 封好——它一张覆盖 5 个列表页，是全项目复用率最高的一块。"+1~1.5 周"是 v4 就接受的确定成本，v5 换回 React 后明显缩小，但**省下多少要等 N1 spike 实测才写数字**，不要拿估算当承诺。

---

## Props 与组成约定

- 表格类组件的入参一律**受控**：`page/pageSize/sortBy/sortDir/filters`（禁令⑧），内部不偷偷维护自己的分页态。
- 表单字段：控件本身无状态偏好，值与错误都来自 react-hook-form；`FormField` 的 `name` 必须与 Zod schema 的 key 一致，编译期可查。
- 枚举展示：`{valueArray, 中文名字典}` 从 `src/shared/enums/<file>.ts` 同一份导入，**禁止**在组件里写 `{civil_commercial: '民事商事'}` 这类第二份字典（§5.1 单一事实源）。
- 详情类页面的 Tab 组件不自行判权限——它拿到的就是"已过 `withScope` 的 DTO"；不可见时后端给 404/占位，前端不做本地过滤（那是绕过 ScopeResolver 的另一种形态）。
- 服务端专用能力（session、db、云之家客户端）不得 import 进任何客户端组件。

---

## 装配现状（W0-2 实跑，2026-09-27）

已装并可运行：`next@16.3.6` + `react@19.3.0` + `tailwindcss@4.3.3`（CSS-first，`@import "tailwindcss"`，**没有 `tailwind.config.js`**）+ `cn()`（`src/app/lib/utils.ts`，带 3 条行为测试）。`pnpm build` 出 `.next/standalone`。

**已落地**（同日代理通了之后跑完，详证 `research-nextjs-stack.md` §6.4）：`components.json`（`style: radix-nova`，aliases 指向 `@/app/components{,/ui}`）+ 六个件 `button card input dialog attachment calendar`。三条对写码有直接影响的实测事实：① **`cn()` 现在来自 shadcn 官方 npm 包 `cn`**（maintainer `shadcn`、repo `shadcn-ui/cn`、零依赖；查过不是被抢注的同名包），生成的件写 `import { cn } from "cn"`，本仓的 `src/app/lib/utils.ts` 只做 `export { cn } from "cn"`，**`clsx` 与 `tailwind-merge` 已移除**（留着就是两套 cn 实现）；② **原语包是统一的 `radix-ui`（1.6.7），不是 `@radix-ui/*` 分散包**；③ 跑 CLI 会改 `layout.tsx` / `globals.css`，**必须 review diff**——它注入的 `next/font/google`（构建期去外网取字体）已移除，内网私有化部署不能让 `pnpm build` 依赖外网，字体改系统栈。

两条装配期踩到的事实要记住：**不要用 `create-next-app`**（它默认生成 `AGENTS.md`，会覆盖本仓的 Trellis 受管块）；**Next 会把 `tsconfig.json` 的 `jsx` 强改为 `react-jsx`**，其余严格项不会被回退。

## 缺件的处理流程（写死，避免每次临时决定）

1. 先查 `docs/research-nextjs-stack.md` §3.1/§3.2 是否已登记该件。**一条教训写在这**：§3.1 曾因「registry 清单里没有 `upload` 这个名字」就结案「没有现成上传件」，后来从官方仓读到 `attachment` 才发现**名字不等于能力**——判「有没有件」要同时看**清单 + 官方 description/源码**，不能只看命名。
2. 没有 → 在 `components/ui/<件名>/` 自封装，只用已有原语 + Tailwind。
3. 只有在"自封装成本明显高于一个**无样式** headless 库"时，才允许新增依赖（如 `@tanstack/react-table` 这类 headless 层），且必须：写进本文件 + 技术选型 §13.5 禁令⑦的例外说明。**带样式的库一律禁止**，没有例外。

---

## 常见错误

1. 为了一个日期范围选择器装 MUI/AntD → 禁令⑦，且会带进第二套间距与色彩刻度。
2. 直接 `import { Dialog } from "@radix-ui/react-dialog"` → 绕过 `components/ui/`，换原语时要改遍业务代码。
3. 用 `style={{margin:'8px'}}` 或 `!important` 压 shadcn 默认样式。
4. 在业务组件里再写一份枚举中文字典。
5. 让 `DataTable` 支持"一次性拉全量再本地排序"（哪怕只是"临时"）——禁令⑧的真实理由是权限，不是性能。

---

## TanStack Table 的版本决定与五条坑（N7 spike，2026-09-27）

**决定：留在 `@tanstack/react-table` v9，但显式从 `@tanstack/react-table/legacy` 引入。**
v9 是破坏性改版：主入口没有 `useReactTable` / `getCoreRowModel` / `VisibilityState`，泛型改成 feature-first
（`ColumnDef<TFeatures, TData, TValue>`；把 TData 写在第一位会报 `does not satisfy the constraint 'TableFeatures'`）。
shadcn 的 Data Table 文档与示例都按 v8 形状写，所以走官方 legacy 入口（`useLegacyTable` / `getXRowModel` /
`LegacyColumnDef`）：不降级锁死升级路，函数名本身也声明了"这是 v8 形状"，读代码的人不会被误导。

写表/表单时必须避开的五个坑（每一条都是真撞过的）：

1. `RowSelectionState` 在 v9 是 `Record<string, true>`，写 `boolean` 类型不过。
2. 选择列要 `enableHiding: false`，且列显隐工具条只渲染 `col.getCanHide()` 的列——否则工具条会冒出一个文案为 `select` 的按钮。
3. **表单 schema 里不要用 Zod 的 `.default()`**：它让 input 与 output 类型不一致，`useForm<T>` + `zodResolver` 直接类型不匹配。
   默认值一律写进 `defaultValues`。
4. `useSearchParams()` 必须包在 `Suspense` 里，否则 Next 16 构建期就报错。所有列表页共用这个结构。
5. 测试里用 `@/...` 需要 `vitest.config.mts` 的 `resolve.alias`——**vitest 不读 `tsconfig.paths`**。

# Component Guidelines

> 组件体系、props 约定、四件重活怎么拿、密度怎么量出来。
> 来源：`docs/tech-stack-decision.md` **§13.6（v6 现行）**、§13.5 禁令①⑤⑥⑧、`research-nextjs-stack.md`。
> ⚠ 本文件在 v5 写的是 shadcn，**v6（2026-09-28）整批改判为 Ant Design 6**。凡是"为什么走这条路"的判断（密集表格最重、
> 缺件必须自封装、一套刻度、颜色不能是唯一通道）一路保留；凡是"某个包名/API"的事实全部按 antd 重写，
> 旧事实只在标 ~~历史~~ 或"v5 那轮"的段落里留着，**不要照抄进代码**。

---

## 唯一体系（禁令⑦ 现行文字，§13.6.2）

**前端只允许一套组件体系：Ant Design 6 + Tailwind v4，Tailwind 只管容器布局。** 三个可机器化的子条款：

1. **不得引入第二套体系或第二家叶子库**——现在要防的不是"引一套带样式的库"（那条在 v5 也禁），而是**具体这几个名字**：
   `radix-ui` / `class-variance-authority`（上一套体系的残余，依赖已从 `package.json` 删除）、
   `@ant-design/pro-components`（见下）、`lucide-react`（图标只有 `@ant-design/icons`）、
   `react-hook-form` + `@hookform/resolvers`（表单只有 antd `Form`）、`date-fns` / `moment`（日期只有 `dayjs`）。
   **唯一具名白名单（2026-10-12，IQ-19 / ADR-0002）**：富文本编辑器允许用
   `@blocknote/{core,react,mantine}` + peer `@mantine/{core,hooks,utils}` + `react-markdown`/`remark-breaks`，
   **且只允许出现在 `components/ui/rich-text/` 之内**——编辑器之外一律仍是 antd。
   ⚠ 门禁的名字表里没有 `mantine`/`blocknote`，**脚本在这一点上是瞎的**，边界靠这条文字与 review 守。
2. **不得走 antd 深路径**：一律顶层 `"antd"`。类型也在 index 上——`TableColumnsType`、`FormRule`
   都是从顶层取，**不要写 `from "antd/es/table"`**（那是 v5→v6 过渡期我自己踩过的）。
3. **一个色只定义一次**：色值唯一源是 `src/app/theme/brand.ts`（`BRAND` / `INK` / `PAPER` / `alpha()`）。

**为什么 Pro 不在范围内（一手事实，别再去试）**：
`@ant-design/pro-components@2.8.10` 的 peer 是 **`antd ^4.24.15 || ^5.11.2`，不含 antd 6**。
装上能过 lint，运行时把样式配置拉回 v5 那一套，症状要过几屏才看得见。所以 ProTable/ProForm 出局，
列表壳与表单弹窗自己写：`components/list-toolbar.tsx`、`components/ui/data-table/DataTable.tsx`、几个 `Modal + Form`。
Pro 那三件便利（查询区 / 工具栏 / 表单化弹窗）本来就是薄封装，不可替代的能力没有丢，丢的是"少写 80 行"。

这三条都不是靠 review 守的：`tools/lint-guard/` 挂了**两个 scope**（体系 + 色值单源），
每个 scope 六道断言，`pnpm verify` 每次都跑——**加新守卫必须先反向红一次**（见 quality-guidelines）。

> **v5 那段"为什么不用组件库"的理由（源码进仓、无黑盒、不受版本天花板）没有一条被证伪，但它没赢过另一件事实**：
> 一期是密集后台表格 + 动态表单 + 一堆带无障碍的复杂件，而用户两次否同一套观感。
> 判断依据要记住，别在实现时又想要回 shadcn——**换库的代价已经写在 §13.6.4，两套并存才是更大的代价**。

---

## 样式体系约定三条（v6 重述）

1. **组件内尺寸一律交给 antd token**（`theme/antd.ts` 的 `token` / `components.*`），不用 Tailwind 去顶开。
   密度是一处可调的刻度：`controlHeight=30`、`controlHeightSM=24`、`fontSizeSM=12`、
   Table `cellPaddingBlockSM=5` / `cellPaddingInlineSM=10` / `fontSize=13`。
   **`size="small"` 是全局口径，不是每表自选**——散着写就会长出第二套间距。
2. **Tailwind 只用于容器布局**（flex / gap / 宽高 / 文字排版），不用于组件外观覆盖。
   `globals.css` 里只剩 preflight + 一个 `.num` 工具类（等宽 + tabular-nums），**shadcn 那套语义色变量已整段删除**；
   不要在任何配置里复活 `corePlugins: { preflight: false }` 或 `--primary/--muted/--sidebar` 那种令牌——
   两套令牌并存必然出现"这页用 `bg-primary`、那页用 `colorPrimary`"的分叉。
3. **覆盖 antd 默认样式优先用 `styles` / `classNames` 语义槽与 token**，实在不行才写行内 `style`；`!important` 一律禁止。
   颜色永远从 `theme/brand.ts` 取：`BRAND.primary` 而不是 `#2f5fe0`，半透明写 `alpha(色, .62)` 而不是手写 `rgba(...)`。

> 表格的表头/正文视觉锚点由 token 决定（表头 `headerBg #f2f4f8` + `headerColor INK.secondary`，正文 13px 主墨色）——
> 这条是 v5 那轮量出来的教训的 antd 版本，别再退回"表头和正文同字色同字号"。

---

## 四件重活（一期前端的主要工作量，v6 的拿法）

| 件 | 现成度 | 落地方式 |
|---|---|---|
| 密集表格（案件/事项/当事人/我的关注/通知 5 张 + 详情内嵌表） | **件本身现成，密度要量** | `components/ui/data-table/DataTable.tsx` 包 antd `Table`：受控 `page/pageSize/sortBy/sortDir`、`tableLayout="fixed"` + `scroll.x=列宽合计`、列上**只给 `sorter: true`**、`pageSize > 100` 直接抛。**禁止客户端全量排序**（禁令⑧，理由是权限不是性能）。列显隐、合计行、空态都在这层 |
| 转案件动态表单（N 个案件卡片 + 跨卡复制 + 每卡 10+ 字段联动校验） | **现成** | antd `Form` + `Form.List`（数组卡）。校验规则**不重写第二份**：`components/form/zod-rules.ts` 从 `shared/schema` 的 Zod 推导 `rules`，服务端 `fieldIssues` 用 `form.setFields` 落回字段。跨卡复制仍用白名单 `COPYABLE_FIELDS`（不是靠约定），`COPYABLE ∩ NON_COPYABLE = ∅` 有断言 |
| 附件上传（预签名 PUT 直传 + 进度 + 白名单 + 多文件） | **仍要自封装** | `Upload` 只管选文件与进度 UI，**预签名 PUT 直传 MinIO 这段必须自己写**（`FileUpload.tsx`：选文件 → 向 `/api/**` 申请预签名 PUT → 直传 → 回报对象 key）。后端不中转文件流（C3），请求体上限由 nginx 设死。⚠ 未做：W3-7 的 MinIO service account 还没批 |
| 日期与法律期限（含"剩 N 天"） | **现成** | antd `DatePicker`（自带 zh_CN，`ConfigProvider locale` 给）；**格式化与期限计算走 `dayjs` + `src/shared/time/zh-cn.ts` 的 pattern**。两条实测硬事实：`yyyy`/`dd` 是 **date-fns** 的 token，dayjs 里会原样输出 `yyyy年9月0日`；`EEE` 不受 dayjs 核心支持（`WEEKDAY_PATTERN` 因此删除）。日历不再自己装（v5 的 `react-day-picker` 已移除） |

**压缩手段**不变：先把 `DataTable.tsx` 封好——它一张覆盖 5 个列表页，是全项目复用率最高的一块。

---

## Props 与组成约定

- 表格类组件的入参一律**受控**：`page/pageSize/sortBy/sortDir/filters`（禁令⑧），内部不偷偷维护自己的分页态；
  状态落在 URL 上（`use-list-state`），刷新/后退/把链接发给同事才对得上同一个视图。
- 列定义：`TableColumnsType<Row>`，每列给 `width` + `ellipsis: true`（防换行撑高，见"密度"一节）；
  排序态用 `sortOrderOf(key, sortBy, sortDir)` 换算成 antd 的 `'ascend' | 'descend'`，**不要给 `sorter` 传函数**。
- 表单字段：值与错误都来自 antd `Form`；`Form.Item` 的 `name` 必须与 Zod schema 的 key 一致，
  数组字段用 `[index, 'field']` 路径（`zod-rules.spec.ts` 里那条数组路径回归就是它）。
- 日期字段：表单里存 `Dayjs`，**提交前一处转 `YYYY-MM-DD`**（见 create/convert 弹窗的 `toValues()`），别在多处各自格式化。
- 枚举展示：`{valueArray, 中文名字典}` 从 `src/shared/enums/<file>.ts` 或 `/api/meta` 取，**禁止**在组件里写第二份字典。
- 状态与到期标记统一走 `ui/status-mark.tsx`（Badge 点 + 词）与 `ui/deadline-mark.tsx`（"逾期 N 天 / 剩 N 天"），
  **颜色不能是唯一通道**（灰阶打印与色觉障碍都会让"绿点=结案"失效）。
- 空态/错误态走 `ui/state-block.tsx`：说清下一步能干什么，不留一句"暂无数据"。
- 详情类页面的 Tab 不自行判权限——它拿到的就是"已过 `withScope` 的 DTO"；不可见时后端给 404，前端不做本地过滤。
- 服务端专用能力（session、db、云之家客户端）不得 import 进任何客户端组件。
- **Server Component 里一个 antd 组件都不能出现**（全带 hook，SSR 直接抛）。登录页那种纯外壳用原生标签 + 内联样式，
  色值从 `theme/brand.ts` 取——那个文件不 import antd，就是为了让 SSR 壳也能用同一份色。

---

## 装配现状（v6，2026-09-28）

已装：`next@16.3.6` + `react@19.3.0` + `antd@6.6.5` + `@ant-design/icons@6.3.4` +
`@ant-design/nextjs-registry@1.3.0`（peer 需要 `@ant-design/cssinjs@2.1.2`，故它是直接依赖）+ `dayjs` +
`tailwindcss@4.3.3`（CSS-first，**没有 `tailwind.config.js`**）。已删：`shadcn`、`components.json`、`cn`、
`clsx`/`tailwind-merge`、`radix-ui`、`class-variance-authority`、`@tanstack/react-table`、`date-fns`、
`react-day-picker`、`react-hook-form`、`@hookform/resolvers`、`tw-animate-css`。

Provider 顺序是有意义的：`QueryClientProvider > AntdRegistry > ConfigProvider(locale, theme) > App`。
**`AntdRegistry` 必须在 `ConfigProvider` 外面**，否则 SSR 的样式抽取拿不到 token，首屏无样式闪一下。

装配期两条事实继续有效：**不要用 `create-next-app`**（默认生成 `AGENTS.md`，会覆盖本仓的 Trellis 受管块）；
**Next 会把 `tsconfig.json` 的 `jsx` 强改为 `react-jsx`**，其余严格项不会回退。
另外 npm 侧要显式出口（本机的"域名级定向重置"结论仍成立）：`HTTPS_PROXY=http://127.0.0.1:7897 pnpm add …`。

---

## 缺件的处理流程（写死，避免每次临时决定）

1. 先查 antd 官方组件清单有没有这个件（`DatePicker`/`Upload`/`Descriptions`/`Tabs`/`Badge` 都是现成的）。
2. 没有 → 在 `components/ui/<件名>/` 自封装（现状只有 **FileUpload** 这一类：预签名直传那段必须自己写）。
3. **不允许**为了一个缺件引入第二个体系。v5 那条"允许无样式 headless 库"的例外**随 TanStack 一起作废**——
   antd 已经覆盖一期全部需求，再引 headless 层就是第二套状态模型。

---

## 常见错误

1. `import { Select } from "antd/es/select"` 或 `import type { ColumnsType } from "antd/es/table"`
   → 禁令⑦，走顶层；类型名是 `TableColumnsType` / `FormRule`。
2. 装 `@ant-design/pro-components` 省那 80 行 → peer 不含 antd 6，禁令⑦ 的 fixture 专门有一条拦它。
3. 用 `style={{ color: "#7a828f" }}` 这种字面量色 → 禁令⑦ 色值单源；写 `INK.muted`。
   （v6 迁移时一次量出 43 处内联灰，这就是它为什么值得被机器拦。）
4. 在组件里再写一份枚举中文字典，或再写一份 `rules` 而不从 Zod 推导。
5. 让 `DataTable` 支持"一次性拉全量再本地排序"（哪怕只是"临时"）——禁令⑧ 的真实理由是权限。
6. 给列写 `sorter: { multiple: 1 }` 之类的**第二个参数**：v5 那轮 `sorter: { position }` 就是非法 key 且被静默忽略，
   同类错误不要换个库再犯一次。
7. 把 antd 组件写进 Server Component（登录页那个壳就是为此用原生标签写的）。

---

## 表格密度契约（三轮回归换来的四条）

**v5 那次（TanStack + shadcn）**：`shadcn add -o` 把自封装 `ui/table.tsx` 换成 registry 默认版，
密度假设没跟着复核，1440×900 同源 iframe 量出：表头无底槽、表头与正文同 `14px/text-foreground`、
单元格内边距掉到 `p-2`、「程序」「等级」两列被 auto layout 压到 45px；根因是**传给 TanStack 的 `size` 只是元数据，
没人消费它**。修法是补 `<colgroup>` + `table-fixed`（提交 `2217b08`）。

**v6 这次（antd）换了个面孔**：`width` 在 `tableLayout: fixed` 下**真的生效**，但只要有一列文字超出列宽，
`white-space: normal` 就把整行撑高——量出案件表 **54px/行**（10 列里 9 列非 nowrap，内部编号折成两行）、
表体横向**溢出 10px**。修法不是调 padding，是**每列 `ellipsis: true` + 宽度按实测文字**（用 canvas `measureText`
逐列量最长值），改完 **33px/行、溢出 0**，事项表 **35px/行**（含行内 small 按钮，是合理下限）。

所以这一层的契约是：

1. **每列都给 `width` 与 `ellipsis`**，`scroll.x` = 列宽合计；列宽合计要 ≤ **最窄支持视口**的容器实测宽。
   三个数都量过：1366 下容器 **1118px**（内网下限，必须一起量——只量 1440 会让两张表在 1366 各溢出 50 / 70px）、
   1440 下 1192px、1920 下 1400px（列表容器有 `maxWidth: 1400`）。现在两张表的合计是 **1100 / 1108**。
   **这条上限必须真的在样式里**（2026-10-22 实测补回）：antd 重写那轮把它丢了，容器变成不封顶，
   唯一可伸缩列（案名）把余量全部吃掉 —— 1920 下 802px、**2560 下 1442px**（同屏「程序」只有 88px）。
   现在的落点是 `.stack.list`（`globals.css`），五个列表页的页面容器都带 `list` 修饰类；
   改宽度先量这四档：1366/1440 走列宽预算、1920/2560 走 1400 上限。
   表头排版同源 canon：**12.5px / 500 / `--ink2`**（`.tb th`），不要回到 antd 的 13px/600——列名该比正文退一档。
2. 密度改动只改 `theme/antd.ts` 的 token，**不在页面里用 Tailwind 顶单元格内边距**。
3. **`ellipsis` 只在单元格内容是纯字符串时自动补 `title`**：一旦 `render` 包了 `<span>`/`<Tag>`，
   被裁的文字就没有任何找回路径——案由列在 1366 下几乎每行被裁而悬停无提示，就是这么漏的。要显式写 `title`。
4. **密度只能被量出来，不能被看出来**：浏览器面板在本会话是 0×0/hidden，截图不可用，
   口径是"同源 iframe 固定视口 + computed style + rect"，且**iframe 里的查询要轮询到出行再量**
   （冷加载 6s 内可能还是骨架，量到 0 行会误判成"表没了"），探针脚本见 `agent-work/`（gitignore，临时物）。

> 守卫的历史：v5 用 `ui/table-density.spec.ts` **读源码类名**断言（因为官方版行为正常、只是不密集，行为测试拦不住覆盖事故）。
> v6 已经没有 `ui/table.tsx` 这个原语，那个 spec 随之删除；现在守密度的是 lint 的两个 scope + 上面这三条约定。
> 那条**方法论**留着：第一版守卫用 `function TableHeader[\s\S]*?bg-muted\/40`，`[\s\S]*?` 会跨函数漂移到
> `TableFooter` 附近，删掉表头底色照样绿——**新守卫必须反向红一次**，且切片匹配不要跨函数。

## 两列详情页：sticky 侧栏的三条实测坑（2026-10-12，P5-D2 落地）

1. **高度用 `height` 不用 `maxHeight`**。`maxHeight: calc(100vh - X)` 只封顶不撑开，
   卡片会缩成内容高，"输入框钉在底部"直接不成立——原型与实现各踩过一次，两次都是靠量才现形。
2. **sticky 的 `top` 要用实测的顶栏高**，不要凭印象：本应用是 48 的 Header + 16 的内容内边距
   ⇒ 内容区顶端在 **y=64**。写 `top: 76` 会在滚动时跳 12px。配套高度
   `calc(100vh - 80px)`（= 顶栏 64 + 底边距 16），首屏与滚动后都不出折线。
3. **antd 6 的页签面板类名是 `.ant-tabs-content` / `.ant-tabs-body`**，不是 v5 的
   `.ant-tabs-tabpane`——按 v5 名字写的探针/断言会永远找不到元素（本轮自己踩过，
   还一度误判成"按钮没渲染"）。写探针前先 dump 一次祖先链。

另：本机跑生产构建要用 `node .next/standalone/server.js`（`next start` 与 `output: standalone`
不兼容，会直接退出），且**必须先停掉在跑的实例再 `pnpm build`**——构建会清理 `.next`，
与运行中的实例抢目录会以 `ELIFECYCLE exit 1` 失败（本轮踩了两次）。standalone 还缺
`.next/static` 与 `public`，要手动拷进 `.next/standalone/` 才对。

## 行内 `style` 的例外（照旧，但判据换了）

禁令不再看"是不是 Tailwind 类"，看的是**值从哪来**：

| 位置 | 值来源 | 为什么只能 `style` |
|---|---|---|
| `(desk)/workbench.tsx` 状态分布条 | 各状态计数算出的百分比 | 运行时任意值 |
| 深色导航与登录页墨蓝面板的底色/文字色 | `theme/brand.ts` 常量（SSR 壳不能用 antd 组件） | Server Component 渲染边界 |

**能给 token 就绝不用 `style`**：尺寸走 `theme/antd.ts`，颜色走 `BRAND`/`INK`。
除这两类之外任何 `style` 出现都按违规处理（`common errors` 第 3 条不变）。

---

## 页面头与标题下的第二行说明（副标题纪律 · 旁白，2026-10-12）

**默认没有第二行。** 标题下面（或标题旁边）默认不挂灰色说明文字。需要多说什么时，
信息必须落到「允许的四种落点」之一；落不进去，说明这句话本来就不该存在。

**这种文字的名字叫「旁白」**：对界面自己说话，而不是替用户陈述事实或提供动作。它有两种形态——
**复述**（把紧邻已经写着的东西再说一遍）与**讲规则**（把规则 / 排序 / 权限 / 为什么为空
讲成一句散文）。判据只有一条，念出来听：听者会不会问「这不就在旁边写着吗 / 这不是一眼
就能看出来吗」。会，就是旁白。

⚠ **旁白不认位置。**「页头第二行」只是它最常出现的地方；它同样长在下拉菜单的分区标题、
卡片 `extra`、列表末尾、折叠区标题里。写下"第二行"三个字会让人以为别处不管——2026-10-12
的实例就长在一个下拉里：「关注人 · 可管理：经办人 / 全公司范围 / 创建人」。**写原型 HTML
时同样适用**：那种文件不在 `src/` 下，lint-guard 的源码断言扫不到，只剩这条立场能拦。

**为什么**（本仓自有证据，不是通用审美）：

1. 副标题在内部系统里的失败模式不是"解释得不够"，是**"同一屏里把同一件事说了两遍"**。
   2026-10-12 撤掉的三处——登录页"用公司账号…"、左栏"风险事项 · 案件"、侧栏"数据范围 · 全公司"——
   共同点是紧邻位置已经说过一遍（标题说过 / 菜单就在正下方 / Header 右侧已有范围标签）。
2. 副标题会自己长回来。一份 75 处清点（`docs/research-subtitle-discipline.md` §A.1）做到
   **复述型只剩 1 条**时，同屏重复还剩 4 处，全在详情页页头："编号 / 案号 / 已转案件 / 更新时间"
   与同屏的「基本信息」Tab、「已转案件」卡片、「登记信息」各重复一次。新加一个详情页，
   最自然的下落点就是页头第二行。
3. 一句说明的成本不是那 20 个字，是它**占掉了标题下方那块空白**：登录页撤掉脚注后
   只剩两样内容，原来的 `space-between` 会把它们摊到顶边和底边、中间空一大块
   ——同一句话既多占了位置又制造了空场。

### 允许出现第二行说明的四种落点

| 落点 | 形态 | 本仓既有用例 |
|---|---|---|
| ① 空态 / 错误态 | `ui/state-block.tsx` 的 `hint`，或 `DataTable` 的 `empty` | 事项详情「还没有节点」 |
| ② 字段说明 | `Form.Item` 的 `extra` / `help`、`placeholder` | 状态弹窗的备案原因三分支 |
| ③ tooltip / `title` | 悬停才出，不占常驻版面 | `FlagMark title={…已建了 N 个案卷…}` |
| ④ 折叠区 / 详情卡里的字段表 | `Descriptions`、`MetaLine`、`DetailBlock` | 案件详情「基本信息」Tab、事项「登记信息」 |

**另有一类不算副标题、但必须在第一屏**：`PageHeader` 的 `status`（状态徽标）与 `flags`
（已归档 / 已结案这类与状态正交的第二个事实）。它们不是对标题的解释，是**标题之外的那个事实本身**。
同理，与标题**同行的主键**（`code`：案件内部编号、事项编号）不是副标题——编号和名称是
同一个名词的两个面，横排放是"主键 + 名称"，竖排放才是"标题 + 副标题"。

### 不允许的形态（反例）

| ❌ 反例 | 为什么不行 | 正确做法 |
|---|---|---|
| 菜单名下面再写一遍菜单名 | 屏幕可见、信息量为零；菜单就在一屏之内 | 直接删 |
| 同一屏的第二个位置重复同一事实 | 读者要在两处之间比对，反而更弱 | 只保留一处 |
| 标题里已含的词再作为副标题（标题"今天该动手的"下面写日期） | "今天"就是那个日期 | 直接删 |
| 页头写「基本信息」Tab 里已有的字段 | 同屏两处同一个值，将来必然不同步 | 页头只留第一屏必需的状态与主键，字段回 Tab |
| **在一个分区里讲规则**（关注人下拉的「关注人 · 可管理：经办人 / 全公司范围 / 创建人」） | 复述紧跟其下的名单；把权限规则讲成散文，而**规则该在动作发生处说**——用户要的不是"谁能管"，是"我加了人会怎样" | 删。授权提示落进「添加关注人」弹窗（权限草案 §6：加人前必须明写被加者将获得什么） |
| **解释功能而不是解释这条记录**（有节点的列表末尾贴「事项不预设节点：只有确有时限才手动加」） | 这句话与眼前这条记录无关，读的人每次都要重读一遍；它只回答了"为什么这里是空的" | 挪进空态（那里它才是答案） |

### 三条执行口径

1. **删一条旁白，先回答"这条信息搬去哪"**。搬得进四种落点之一、或换到动作发生处——就搬；
   两边都不成立，才删。`docs/research-subtitle-discipline.md` §B.6.2 的搬迁表是操作版本。
2. **不许用"换个位置"绕过这条**。把页头里的字段原样挪进 `Section` 的 `extra` 不算解决，
   那只是换了插槽。
3. **反例逐条对应一次已经发生的残留**（现在六条，其中两条来自原型 HTML）。新加页面或
   写原型时对着这六条看一遍，比读条文有效。

### 这条靠什么守

三层，按可靠性排（越前越硬）：

1. **位置上不给它留缺口**：`PageHeader` 自 2026-10-12 起只接受 `title` / `code` / `status` /
   `flags` / `actions` 五个具名 prop，`eyebrow` 与 `meta` 两个 `ReactNode` 插槽已删——
   「页面头第二行说明」在**类型上**不可表达。这条是硬的：要加，得先改组件签名。
   2026-10-23 扩了两个**只承载导航与主键**的 prop：`back`（`{ href, label }`，第一行的返回链接）
   与 `stacked`（第一行 返回 + 编号、第二行 标题 + 状态；案件详情在用）。它们不是副标题插槽：
   `back` 的形状塞不进一句解释，`stacked` 只重排既有事实。
2. **机器断言兜底**：`tools/lint-guard/check.mjs` 有一条源码断言，`src` 下再出现
   `eyebrow=` / `meta=` 就红。它只认这两个名字，也**只扫 `src`**——原型 HTML 在
   `prototype/*` 分支上，它扫不到。
3. **名字 + 立场**：其余全靠这一节的「旁白」判据在现场逐句念出来。原型、临时页面、
   一次性 HTML 属这一层；没有第 1 层的缺口可堵，也没有第 2 层可依赖。
   收工前的自检在 `index.md` 的 Quality Check 里。

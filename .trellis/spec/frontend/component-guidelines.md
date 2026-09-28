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

## 表格密度契约（两轮回归换来的三条）

**v5 那次（TanStack + shadcn）**：`shadcn add -o` 把自封装 `ui/table.tsx` 换成 registry 默认版，
密度假设没跟着复核，1440×900 同源 iframe 量出：表头无底槽、表头与正文同 `14px/text-foreground`、
单元格内边距掉到 `p-2`、「程序」「等级」两列被 auto layout 压到 45px；根因是**传给 TanStack 的 `size` 只是元数据，
没人消费它**。修法是补 `<colgroup>` + `table-fixed`（提交 `2217b08`）。

**v6 这次（antd）换了个面孔**：`width` 在 `tableLayout: fixed` 下**真的生效**，但只要有一列文字超出列宽，
`white-space: normal` 就把整行撑高——量出案件表 **54px/行**（10 列里 9 列非 nowrap，内部编号折成两行）、
表体横向**溢出 10px**。修法不是调 padding，是**每列 `ellipsis: true` + 宽度按实测文字**（用 canvas `measureText`
逐列量最长值），改完 **33px/行、溢出 0**，事项表 **35px/行**（含行内 small 按钮，是合理下限）。

所以这一层的契约是：

1. **每列都给 `width` 与 `ellipsis`**，`scroll.x` = 列宽合计；列宽合计要 ≤ 容器实测宽（1440 视口下是 1192px）。
2. 密度改动只改 `theme/antd.ts` 的 token，**不在页面里用 Tailwind 顶单元格内边距**。
3. **密度只能被量出来，不能被看出来**：浏览器面板在本会话是 0×0/hidden，截图不可用，
   口径是"同源 iframe 固定 1440×900 + computed style + rect"，探针脚本见 `agent-work/`（gitignore，临时物）。

> 守卫的历史：v5 用 `ui/table-density.spec.ts` **读源码类名**断言（因为官方版行为正常、只是不密集，行为测试拦不住覆盖事故）。
> v6 已经没有 `ui/table.tsx` 这个原语，那个 spec 随之删除；现在守密度的是 lint 的两个 scope + 上面这三条约定。
> 那条**方法论**留着：第一版守卫用 `function TableHeader[\s\S]*?bg-muted\/40`，`[\s\S]*?` 会跨函数漂移到
> `TableFooter` 附近，删掉表头底色照样绿——**新守卫必须反向红一次**，且切片匹配不要跨函数。

## 行内 `style` 的例外（照旧，但判据换了）

禁令不再看"是不是 Tailwind 类"，看的是**值从哪来**：

| 位置 | 值来源 | 为什么只能 `style` |
|---|---|---|
| `(desk)/workbench.tsx` 状态分布条 | 各状态计数算出的百分比 | 运行时任意值 |
| 深色导航与登录页墨蓝面板的底色/文字色 | `theme/brand.ts` 常量（SSR 壳不能用 antd 组件） | Server Component 渲染边界 |

**能给 token 就绝不用 `style`**：尺寸走 `theme/antd.ts`，颜色走 `BRAND`/`INK`。
除这两类之外任何 `style` 出现都按违规处理（`common errors` 第 3 条不变）。

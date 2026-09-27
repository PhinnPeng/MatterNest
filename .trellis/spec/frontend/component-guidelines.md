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

> 历史上那条 `corePlugins: { preflight: false }` + AntD 走 `ConfigProvider` 令牌的约定，是为"两套体系共存"打的补丁；现在只有一套，**整段作废**，不要在任何配置里复活它。

---

## 四件重活（§3.3 成本表，一期前端的主要工作量）

| 件 | 现成度 | 落地方式 |
|---|---|---|
| 密集表格（案件/事项/当事人/我的关注/通知 5 张 + 详情内嵌表） | 半现成 | 以 Data Table 为底，**自封装一张 `DataTable.tsx`**（`components/ui/data-table/`）：受控分页参数、筛选模型、批量选择、列显隐统一收口。**禁止客户端全量排序** |
| 转案件动态表单（N 个案件卡片 + 跨卡复制 + 每卡 10+ 字段联动校验） | 要自写 | **react-hook-form + Zod resolver**（与 `shared/schema` 同源，v5 的默认唯一选择，不再留三选一）；数组字段与跨卡复制自管；**id 类字段不参与复制**（矩阵 §3） |
| 附件上传（预签名 PUT 直传 + 进度 + 白名单 + 多文件） | 两边都按自封装排期 | 自封装 `FileUpload.tsx`：向 `/api/**` 申请预签名 PUT → 直传 MinIO → 只回报对象 key。**后端不中转文件流**（C3），请求体上限由 nginx 设死；框架侧不设 body 上限 |
| 日期与法律期限（含"剩 N 天"） | 半现成 | Calendar / Date Picker 有；**中文 locale 与 react-day-picker 版本待 N1/N7 实测（UNVERIFIED）**；期限计算一律走 `shared/time`，`date` 与 `timestamptz` 的边界不因组件库改变 |

**压缩手段**：先把 `DataTable.tsx` 封好——它一张覆盖 5 个列表页，是全项目复用率最高的一块。"+1~1.5 周"是 v4 就接受的确定成本，v5 换回 React 后明显缩小，但**省下多少要等 N1 spike 实测才写数字**，不要拿估算当承诺。

---

## Props 与组成约定

- 表格类组件的入参一律**受控**：`page/pageSize/sortBy/sortDir/filters`（禁令⑧），内部不偷偷维护自己的分页态。
- 表单字段：控件本身无状态偏好，值与错误都来自 react-hook-form；`FormField` 的 `name` 必须与 Zod schema 的 key 一致，编译期可查。
- 枚举展示：`{valueArray, 中文名字典}` 从 `src/shared/enums/<file>.ts` 同一份导入，**禁止**在组件里写 `{civil_commercial: '民事商事'}` 这类第二份字典（§5.1 单一事实源）。
- 详情类页面的 Tab 组件不自行判权限——它拿到的就是"已过 `withScope` 的 DTO"；不可见时后端给 404/占位，前端不做本地过滤（那是绕过 ScopeResolver 的另一种形态）。
- 服务端专用能力（session、db、云之家客户端）不得 import 进任何客户端组件。

---

## 缺件的处理流程（写死，避免每次临时决定）

1. 先查 `docs/research-nextjs-stack.md` 是否已登记该件（未证实在 React 侧有没有现成件时，一律按"没有"排期——这是本轮抓取失败的既定处置）。
2. 没有 → 在 `components/ui/<件名>/` 自封装，只用已有原语 + Tailwind。
3. 只有在"自封装成本明显高于一个**无样式** headless 库"时，才允许新增依赖（如 `@tanstack/react-table` 这类 headless 层），且必须：写进本文件 + 技术选型 §13.5 禁令⑦的例外说明。**带样式的库一律禁止**，没有例外。

---

## 常见错误

1. 为了一个日期范围选择器装 MUI/AntD → 禁令⑦，且会带进第二套间距与色彩刻度。
2. 直接 `import { Dialog } from "@radix-ui/react-dialog"` → 绕过 `components/ui/`，换原语时要改遍业务代码。
3. 用 `style={{margin:'8px'}}` 或 `!important` 压 shadcn 默认样式。
4. 在业务组件里再写一份枚举中文字典。
5. 让 `DataTable` 支持"一次性拉全量再本地排序"（哪怕只是"临时"）——禁令⑧的真实理由是权限，不是性能。

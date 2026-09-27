# N7 spike PRD

票面出处：`docs/research-nextjs-stack.md` §5 的 **N7**；落地方案里由 **W3-1**（`DataTable.tsx`）与 **W4-1**（动态数组表单）承接。本票是** spike **：目的是把 M3/M4 最贵的两块前端技术风险提前拆掉，不是交付业务功能。

## 通过标准（研究文档 §5 原文）

> 一张真表（服务端分页/排序/筛选/批量选择/列显隐）+ 一个动态数组表单 —— **错误能定位到"第几张卡哪个字段"**。

## 本票要回答的五个问题

1. `@tanstack/react-table` 与 shadcn 的 `Table` 拼起来，**受控的服务端分页/排序/筛选**写起来顺不顺，参数放 URL 还是组件内 state（`hook-guidelines` 的 URL 态口径要不要改）。
2. **每页上限 100 由谁拦**：客户端参数、Route Handler、还是 Zod schema？（禁令⑧ 说"强制"，那必须有一处拦得住且**测得到**。）
3. 批量选择 + 列显隐在跨页场景下的行为边界（选中项翻页后是否保留）——这决定 `DataTable` 的 API 形状。
4. 动态数组表单（`useFieldArray`）+ Zod 的 `errors[].path`，能不能稳定产出"第几张卡、哪个字段"这种可读定位；**id 类字段不参与跨卡复制**（矩阵 §3）怎么在代码上保证而不是靠约定。
5. 顺带：`/api/**` Route Handler + 客户端 react-query 这条链路在 Next 16 上是否成立（禁令⑤⑥ 的第一次实跑，**但不含 `withScope` 与真库**，那属 N2）。

## 边界（不做什么）

- 不接数据库、不写 `ScopeResolver`（N2 的活）。假数据由一个 Route Handler 提供，形状与真接口一致。
- 不做业务页路由（`/matters` 等 14 页属 M3）；spike 页面挂在 `/spike/n7`，交付时**保留**给 W3-1 当参照实现，并在票面标注它是 spike 产物。
- 不验列固定/列宽拖拽（技术选型 §12.4 已定"第一期接不进就放弃"），本票只记录实测感受，不加需求。

## 验收

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | ✅ 五参数全受控；`DataTable` 只装 `getCoreRowModel`，「manualSorting/Filtering/Pagination」 全 true，另有一条断言 `items.length < total` | 代码 + 一条"给全量数据也不许本地排序"的断言测试 |
| 2 | ✅ 实测 `?pageSize=500` → **400**，`issues[0].path=[pageSize]`；上限定义在 shared 的 Zod 里，客户端与服务端共用一份 | `list-query` schema 测试 |
| 3 | ⚠ 逻辑与 SSR 结构可用；**跨页选择行为未能实测**（见「交互层未验」）。已修一处真缺陷：选择列 `enableHiding:false`，工具条只列可隐藏列 | 实测 + 记录 |
| 4 | ✅ 10 条测试覆盖：`describeIssuePath([cases,2,client_name])` → 「第 3 张卡 · 当事人名称」、跨卡重复检测、`copyCardOnto` 不带 id | 3 条以上 schema/定位测试 |
| 5 | ✅ `/spike/n7` 的 SSR HTML 里业务行 **0 条**（grep 「事项 1 号合同纠纷」 计数为 0），只有表头与加载占位 | grep 复核 |
| 6 | ✅ `pnpm verify` 五步绿（**32 测试**）、`pnpm build` 通过（`/spike/n7` 静态 + `/api/spike/matters` 动态）、dev 取完证已 kill | 实跑 |
| 7 | ✅ 研究文档 §5/新增 §7、spec 五处、落地方案 G1/W3-1/W4-1、CHANGELOG 全部回写 | 见提交 |

## 已知的坑（写在这里，避免踩完才发现）

- `Locale` 含函数不能跨 server→client 传（N1 实测）→ 日期字段的 locale 必须 client 侧 import。
- `@tanstack/react-table` 是 headless，用它**不算**引入第二套组件体系（技术选型 §3.3），但样式必须全部走 `components/ui/` 那层。

## 结果（2026-09-27）

**逻辑层通过、交互层未验。** 五条只有真跑才会撞到的事实（TanStack v9 破坏性改版、vitest 不读 tsconfig paths、Zod `.default()` 打断 react-hook-form 的 resolver 类型、v9 的 `RowSelectionState` 是 `Record<string, true>`、`useSearchParams()` 必须包 `Suspense`）已回写 spec 与研究文档 §7.2。

**交互层未验的原因不是应用**：内置浏览器处于 `visibilityState=hidden` 且视口 0×0，27 个可交互元素上 `__reactFiber` 计数为 0（React 从未 hydration），而 25 个 chunk 全部 200、控制台除 HMR WebSocket 外无报错。因此「点加卡按钮无反应」不能归因于 `useFieldArray` 或本仓代码。补救三选一：把内置浏览器开成可见窗口重测 / 用真实 Chrome / 引 `jsdom` 做组件测试（新依赖需批准）。

**遗留项**：跨页选择行为、筛选面板交互、以及 W3-1 接真接口时的 `withScope` 组合（属 N2）。

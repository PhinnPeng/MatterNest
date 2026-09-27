# Quality Guidelines

> 前端收工判据与禁止项（`trellis-check` 对照表）。
> 来源：`docs/tech-stack-decision.md` §13.5 禁令⑤⑥⑦⑧、§3.3、§7 假设 G；`docs/implementation-plan-v1.md` §4/§5；`docs/PRD-phase1-master.md` ②③。

---

## 四条前端相关禁令（压缩版；**全文以 `docs/tech-stack-decision.md` §13.5 为准**，逐字全文另见 `../backend/quality-guidelines.md`）

- **⑤** 业务读写一律 `/api/**` Route Handler，鉴权在每个 handler 内 `withScope()`；Server Function 只做编排；返回体一律 JSON；不可见资源 **404**。
- **⑥** 页面壳不得预取业务数据：SSR 只出外壳与静态文案，一切业务读取发生在鉴权后的 `/api/**`。
- **⑦** 前端只允许一套组件体系：shadcn + Tailwind；禁第二套带样式库；缺件自封装进 `components/ui/`；业务组件不得直接 import Radix UI。
- **⑧** 表格一律经 `components/ui/data-table/DataTable.tsx` 并强制服务端分页/排序/筛选（每页上限 100）；表单只用 react-hook-form + Zod resolver；日期库全项目一个；组件内不得自带第二套校验规则。

外加样式三条（§3.3）：只用 Tailwind 令牌；覆盖一律 `cn()`，禁行内 style 与 `!important`；业务组件只依赖 `components/ui/` 那层。

---

## 收工自检（每个前端票都要过）

- [ ] `pnpm lint && pnpm typecheck` 绿；无 `any`/`@ts-ignore`。
- [ ] `page.tsx`/`layout.tsx` 里 grep 不到数据仓库或 `db` import（禁令⑥）。
- [ ] 列表全部经 `DataTable`，`pageSize` 上限 100（禁令⑧）。
- [ ] `git grep -n "@radix-ui\|mui\|antd\|chakra"` 只出现在 `components/ui/` 内（禁令⑦）。
- [ ] 无 `style={{` 覆盖组件默认样式、无 `!important`。
- [ ] 枚举/中文字典只从 `src/shared/enums` 导入（§5.1）。
- [ ] 不可见资源的**两种表现不要混**：直接访问详情/下载接口＝**404**，无"存在但无权"载荷；而**关注/通知 feed 里**必须保留占位行、标题固定为「**无权查看的记录**」、摘要字段（状态变化/评论摘录/金额）一律不发——这是权限草案 §7.1 **明令**的降级形态，"不隐藏整行"是刻意的（隐藏会被当成数据丢失去追问）。未读数按**可见行**计。
- [ ] 敏感字段无前端明文遮罩；明文入口对应 `SENSITIVE_FIELD_READ` 审计（§7.3）。
- [ ] 键盘导航可用（下拉、对话框、表格批量选择、Tab 切换）。
- [ ] 涉及未核能力（shadcn 件清单、中文 locale）时，代码里显式 `// UNVERIFIED:` 注释并回写研究文档，而不是默默假设。

---

## 形态约束

- **一期只做 PC 浏览器**（技术选型 §7 假设 G）：按宽屏设计密集表格与转案件表单，**不写窄屏适配代码**；将来若做手机查阅，最小集是"我的关注 / 通知 / 案件详情 / 评论"四屏，**不含建案与转案件**。
- **不套 admin 模板**（§3.3 旧判断仍成立）：模板给的是菜单/路由可见性，而本项目难在行级数据范围（三档 + ScopeResolver + 不可见返 404）。组件全自己拿。
- 7 页无原型（P5/P6/P9/P10/P11/P13/P14）：按 master ②③ 行文实现，需要新布局先回 master 登记，别在实现里替产品做决定。
- 埋点只有 4 个码，不要自行加：`mn_convert_form_view`、`mn_convert_submit_invalid`、`mn_notify_click_through`、`mn_plain_view_prompt_view`（master 交付设计）。G1–G4 四个数必须能从 `activity_log` + 这 4 个埋点算出来（落地方案 §5）。

---

## 常见错误（历史上真被提出过的方案）

1. 为了表格"列固定/拖拽"去装 TanStack 之外的表格库——列固定与拖拽能力在 TanStack 侧，第一期若接不进就**放弃这两项交互**，不换库（技术选型 §12.4 的处置）。
2. 用 Element Plus / AntD 补一个控件——本项目为此改判过三次（Element Plus → shadcn-vue → 原版 shadcn React），现行禁令只从 §13.5 抄。
3. 给列表页加"前端全量排序"图省事——禁令⑧，等于绕过 `ScopeResolver`。
4. 在页面壳预取数据做"首屏更快"——禁令⑥。
5. 为窄屏写一套响应式表格——一期不做（假设 G），会把无原型的页面带进自由发挥。

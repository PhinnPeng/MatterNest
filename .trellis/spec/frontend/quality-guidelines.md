# Quality Guidelines

> 前端收工判据与禁止项（`trellis-check` 对照表）。
> 来源：`docs/tech-stack-decision.md` **§13.6.2（禁令⑦⑧ 现行）**、§13.5 禁令①⑤⑥、§7 假设 G；`docs/implementation-plan-v1.md` §4/§5；`docs/PRD-phase1-master.md` ②③。

---

## 四条前端相关禁令（压缩版；**全文以 `docs/tech-stack-decision.md` 为准**，逐字全文另见 `../backend/quality-guidelines.md`）

- **⑤** 业务读写一律 `/api/**` Route Handler，鉴权在每个 handler 内 `withScope()`；Server Function 只做编排；返回体一律 JSON；不可见资源 **404**。
- **⑥** 页面壳不得预取业务数据：SSR 只出外壳与静态文案，一切业务读取发生在鉴权后的 `/api/**`。v6 另加一条渲染边界：**Server Component 里不许出现 antd 组件**（全带 hook，SSR 直接抛）。
- **⑦** 前端只允许一套组件体系：**Ant Design 6 + Tailwind（只管容器布局）**。三个机器可拦的子条款——禁第二套体系/第二家叶子库（`radix-ui`、`cva`、`pro-components`、`lucide-react`、`react-hook-form`、`date-fns`/`moment`）、禁 antd 深路径（一律顶层 `"antd"`，类型是 `TableColumnsType`/`FormRule`）、**色值只在 `src/app/theme/brand.ts`**。
- **⑧** 表格一律经 `components/ui/data-table/DataTable.tsx` 并强制服务端分页/排序/筛选（每页上限 100，超了**直接抛**）；表单只用 antd `Form`，规则从 `shared/schema` 的 Zod **推导**；日期库全项目只允许 `dayjs`；组件内不得自带第二套校验规则。

外加样式三条（§13.6.3）：组件尺寸走 antd token（`size="small"` 是全局口径）；Tailwind 只用于容器布局；覆盖优先 `styles`/`classNames`/token，禁行内 style 与 `!important`（两类例外见 `component-guidelines.md`）。

---

## 收工自检（每个前端票都要过）

- [ ] **`pnpm verify` 绿**（format:check / eslint / typecheck / vitest / **lint-guard 四 scope**）；无 `any`/`@ts-ignore`。
- [ ] `page.tsx`/`layout.tsx` 里 grep 不到数据仓库或 `db` import（禁令⑥）。
- [ ] 列表全部经 `DataTable`，`pageSize` 上限 100（禁令⑧）。
- [ ] `git grep -n "antd/es\|antd/lib\|radix\|lucide-react\|date-fns\|moment\|react-hook-form\|pro-components\|class-variance" src` 为空（禁令⑦）。
- [ ] `git grep -nE "\"#[0-9a-fA-F]{6}\"" src/app | grep -v "src/app/theme/"` 为空；`rgba(` 同理（禁令⑦ 色值单源）。
- [ ] 无 `style={{` 覆盖组件默认样式、无 `!important`。
- [ ] 枚举/中文字典只从 `src/shared/enums` 或 `/api/meta` 导入（§5.1）。
- [ ] 不可见资源的**两种表现不要混**：直接访问详情/下载接口＝**404**，无"存在但无权"载荷；而**关注/通知 feed 里**必须保留占位行、标题固定为「**无权查看的记录**」、摘要字段（状态变化/评论摘录/金额）一律不发——这是权限草案 §7.1 **明令**的降级形态，"不隐藏整行"是刻意的（隐藏会被当成数据丢失去追问）。未读数按**可见行**计。
- [ ] 敏感字段无前端明文遮罩；明文入口对应 `SENSITIVE_FIELD_READ` 审计（§7.3）。
- [ ] 键盘导航可用（下拉、对话框、表格列显隐、Tab 切换——都由 antd 组件兜住，别自己实现）。
- [ ] **表格密度是被量出来的**：改动列表列宽/内边距后，用同源 1440×900 iframe 复量行高与横向溢出，不看截图下结论。
- [ ] 涉及未核能力时，代码里显式 `// UNVERIFIED:` 注释并回写研究文档，而不是默默假设。

---

## 形态约束

- **一期只做 PC 浏览器**（技术选型 §7 假设 G）：按宽屏设计密集表格与转案件表单，**不写窄屏适配代码**；将来若做手机查阅，最小集是"我的关注 / 通知 / 案件详情 / 评论"四屏，**不含建案与转案件**。
- **不套 admin 模板**：模板给的是菜单/路由可见性，而本项目难在行级数据范围（三档 + ScopeResolver + 不可见返 404）。外壳只写 Sider/Header/Menu 这一层（`components/app-shell.tsx`），页面内容各自实现；**ProComponents 不属于"模板能力"，它属于第二套运行时**（peer 只到 antd 5）。
- 7 页无原型（P5/P6/P9/P10/P11/P13/P14）：按 master ②③ 行文实现，需要新布局先回 master 登记，别在实现里替产品做决定。
- 埋点只有 4 个码，不要自行加：`mn_convert_form_view`、`mn_convert_submit_invalid`、`mn_notify_click_through`、`mn_plain_view_prompt_view`（master 交付设计）。G1–G4 四个数必须能从 `activity_log` + 这 4 个埋点算出来（落地方案 §5）。

---

## 常见错误（历史上真被提出或被踩过的方案）

1. 为了省 80 行装 `@ant-design/pro-components`——它的 peer 是 `antd ^4.24 || ^5.11`，**不含 antd 6**；装上能过 lint，运行时把样式配置拉回 v5，症状要过几屏才看得见（禁令⑦ 有一条 fixture 专门拦它）。
2. ~~用 Element Plus / AntD 补一个控件~~ —— 这条在 v6 反过来：**AntD 就是现行体系**，现在要防的是**把上一套请回来**（`radix-ui`/`cva`/`cn`/`lucide-react`/`date-fns`/`react-hook-form`）。本项目为组件库改判过四次（AntD 混用 → shadcn-vue → 原版 shadcn React → antd 6），**每一次的代价都写在 §13.6.4，别再攒第五次**：判断"要不要引某个依赖"只查 §13.6.2 的清单，不要临时决定。
3. 给列写 `sorter` 的**第二个参数**（v5 那轮写过非法 key `position`，被静默忽略，表现为"排序点了没反应"）。现在只给 `sorter: true` + 受控 `sortOrder`。
4. 只调 `padding` 不调列宽就想压密度——密度是**每列 `nowrap` + 宽度按实测文字**出来的；一列文字超宽就会把整行撑高（v6 实测 54px→33px 就是这么来的）。
5. 给列表页加"前端全量排序"图省事——禁令⑧，等于绕过 `ScopeResolver`。
6. 在页面壳预取数据做"首屏更快"——禁令⑥。
7. 为窄屏写一套响应式表格——一期不做（假设 G），会把无原型的页面带进自由发挥。

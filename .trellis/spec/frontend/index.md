# Frontend Development Guidelines

> MatterNest 一期前端（Next.js 16 App Router + React + **Ant Design 6** + Tailwind v4，Tailwind 只管容器布局）的硬性约束。
> 一期只做 **PC 浏览器**（技术选型 §7 假设 G，2026-09-26 定）；窄屏/移动端响应式列二期。
> **v6 改判（2026-09-28）**：组件体系由纯 shadcn 换成 antd 6，现行禁令在 `docs/tech-stack-decision.md` **§13.6.2**。

---

## 现状声明（读之前必须知道）

- 前端已有**可跑实现**（W1 Demo + v6 重写）：`next@16.3.6` + `react@19.3.0` + `antd@6.6.5` + `@ant-design/nextjs-registry` + `dayjs` + `tailwindcss@4.3.3`；外壳（Sider 216 + Header + Menu 三组）、工作台、案件列表/详情、事项列表与三个弹窗、配置只读页都在。业务读取一律 `/api/**` + react-query。
- **N1 已通过**（2026-09-27）；**N7 的"表 + 动态数组表单"结论要按 antd 重述**：v5 那轮的实现在 `2217b08` 之后随换库删除，能力本身已由 v6 重写覆盖（`DataTable` 包 antd `Table`、`Form.List` + Zod 推导规则），但**它的验收数字是 2026-09-28 重量的**（33px 行高 / 溢出 0），不是 spike 文档里那份。
- **N2–N6 仍未跑**（`withScope` 404 专项 / worker 锁与 drain / 双副本加密键 / 预签名 PUT / 云之家 OIDC）——**门禁 G1 只过了 N1 与 N7 两格**。
- 有 7 页**无原型**（master ②：P5/P6/P9/P10/P11/P13/P14 带 ⚑）。这几页按 master ②③ 的行文实现，**不要自由发挥布局**；需要新形态就先回 master 登记待裁定。

---

## Guidelines Index

| Guide | Description | 主要来源 |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | App Router 布局、14 个页面路由、命名 | 技术选型 §5、master ② |
| [Component Guidelines](./component-guidelines.md) | 唯一组件体系（antd 6）、DataTable/FileUpload、样式三条与密度契约 | 技术选型 **§13.6**、§13.5 禁令①⑤⑥⑧ |
| [Hook Guidelines](./hook-guidelines.md) | react-query 取数、mutation 失效、自定义 hook | 技术选型 §2、§13.6 |
| [State Management](./state-management.md) | 服务端态/客户端态分界、禁跨用户缓存 | 技术选型 §12.5、§13.3-3 |
| [Type Safety](./type-safety.md) | DTO/枚举/校验同源，Zod 单源规则 → antd rules | 枚举表 §5.1、禁令⑧ |
| [Quality Guidelines](./quality-guidelines.md) | 页面壳零业务数据、表格 ≤100、lint 门禁、验收 | 技术选型 §13.5/§13.6、落地方案 §4/§5 |

---

## Pre-Development Checklist（开工前逐条过）

1. [ ] 读 `docs/tech-stack-decision.md` **§13.6.2**（禁令⑦⑧ 现行文字）+ §13.5 的 ①⑤⑥。**不要读 §12.3**（v4 版含 Vue/Nitro 措辞），也**不要照抄 §13.5 的 7、8 两条**（v6 已覆盖）。
2. [ ] 要写的控件 antd 有吗？没有（现状只有**文件上传的预签名直传**那段）→ **自封装进 `components/ui/`**，不许引第二套体系、不许装 ProComponents（禁令⑦）。
3. [ ] 颜色是从 `theme/brand.ts` 取的吗？写出色值字面量 → 违反禁令⑦ 色值单源，lint 会红。
4. [ ] 这个页面壳有没有在服务端预取业务数据？有 → 违反禁令⑥，改成外壳 + 客户端经 `/api/**` 取数。壳里放了 antd 组件吗 → SSR 会抛，见 component-guidelines 的渲染边界。
5. [ ] 表格是不是走 `DataTable.tsx` 且服务端分页 ≤100？不是 → 违反禁令⑧，而这条的真实理由是**权限**。
6. [ ] 校验规则来自 `src/shared/schema` 的 Zod 吗（经 `components/form/zod-rules.ts` 推导）？组件里另写一套 `rules` → 违反禁令⑧。

## Quality Check（收工前逐条过）

- [ ] `pnpm verify` 绿（format:check / eslint / typecheck / vitest / **lint-guard 四个 scope**）。
- [ ] `pnpm build` 绿；无 `any` 逃避、无 `!important`、无绕过 token 的行内 style（两类例外见 component-guidelines）。
- [ ] 只 import 顶层 `"antd"` 与 `@ant-design/icons`；`git grep -n "antd/es\|radix\|lucide\|date-fns\|react-hook-form\|pro-components" src` 应为空。
- [ ] 所有列表走 `DataTable`，参数受控（`page/pageSize/sortBy/sortDir/filters`），列宽与 `ellipsis` 都给齐。
- [ ] 详情/下载类入口不可见时表现为 **404**，没有"这条存在但你无权"的提示；但**关注/通知 feed 是规格件明定的例外**：保留占位行、标题写「无权查看的记录」、摘要字段（状态变化/评论摘录/金额）一律不发、未读按可见行计（权限草案 §7.1）。不要把占位行删掉或整行隐藏。
- [ ] 敏感字段展示走后端脱敏 DTO，前端不做"点一下显示明文"的遮罩逻辑（明文查看要落 `SENSITIVE_FIELD_READ`）。
- [ ] 键盘导航与焦点管理可用（由 antd 组件兜住，不要自己实现下拉/对话框）。
- [ ] 状态与到期的表达是"点 + 词"，颜色不是唯一通道。

---

**语言**：本目录统一中文（裁定见 `docs/implementation-plan-v1.md` §3 W0-7 对应任务 prd「本票的两条裁定」，覆盖模板默认的 English）。

# Frontend Development Guidelines

> MatterNest 一期前端（Next.js 16 App Router + React + 纯 shadcn + Tailwind v4）的硬性约束。
> 一期只做 **PC 浏览器**（技术选型 §7 假设 G，2026-09-26 定）；窄屏/移动端响应式列二期。

---

## 现状声明（读之前必须知道）

- 本仓当前**零前端代码**（无 `src/`、无 `package.json`）。下列是规格件已裁定的约束 + 待落地目标形态，不是从既有代码归纳的模式。
- 组件层能力**尚未 spike**：`docs/research-nextjs-stack.md` §5 的 N1/N7 未跑；原版 shadcn 的 React 组件清单本轮**抓取失败未核到**，所以"有没有现成上传件"不是已知事实——`FileUpload` 按自封装排期（技术选型 §13.4、master P1-18）。
- 有 7 页**无原型**（master ②：P5/P6/P9/P10/P11/P13/P14 带 ⚑）。这几页按 master ②③ 的行文实现，**不要自由发挥布局**；需要新形态就先回 master 登记待裁定。

---

## Guidelines Index

| Guide | Description | 主要来源 |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | App Router 布局、14 个页面路由、命名 | 技术选型 §5、master ② |
| [Component Guidelines](./component-guidelines.md) | 唯一组件体系、DataTable/FileUpload、样式三条 | 技术选型 §3.3、§13.5 禁令⑦⑧ |
| [Hook Guidelines](./hook-guidelines.md) | react-query 取数、mutation 失效、自定义 hook | 技术选型 §2、§3.3 |
| [State Management](./state-management.md) | 服务端态/客户端态分界、禁跨用户缓存 | 技术选型 §12.5、§13.3-3 |
| [Type Safety](./type-safety.md) | DTO/枚举/校验同源，Zod 单源规则 | 枚举表 §5.1、禁令⑧ |
| [Quality Guidelines](./quality-guidelines.md) | 页面壳零业务数据、表格 ≤100、验收 | 技术选型 §13.5、落地方案 §4/§5 |

---

## Pre-Development Checklist（开工前逐条过）

1. [ ] 读 `docs/tech-stack-decision.md` §13.5 禁令⑤⑥⑦⑧ + §3.3 样式三条。**不要读 §12.3**（v4 版含 Vue/Nitro 措辞，已标过时）。
2. [ ] 要写的控件在 `components/ui/` 有吗？没有 → **自封装进 `components/ui/`**，不许引第二套带样式库（禁令⑦）。
3. [ ] 这个页面壳有没有在服务端预取业务数据？有 → 违反禁令⑥，改成外壳 + 客户端经 `/api/**` 取数。
4. [ ] 表格是不是走 `DataTable.tsx` 且服务端分页 ≤100？不是 → 违反禁令⑧，而这条的真实理由是**权限**。
5. [ ] 校验规则来自 `src/shared/schema` 吗？组件里另写一套 → 违反禁令⑧。

## Quality Check（收工前逐条过）

- [ ] `pnpm lint && pnpm typecheck` 绿；无 `any` 逃避、无 `!important`、无行内 style 覆盖组件默认样式。
- [ ] 只 import 自 `components/ui/` 与 `src/shared/`；无直接 `@radix-ui/*` import；业务代码里只有一套 Tailwind 刻度。
- [ ] 所有列表走 `DataTable`，参数受控（`page/pageSize/sortBy/sortDir/filters`）。
- [ ] 不可见资源在 UI 上的表现是**404/占位**，不是"无权查看"提示（通知与关注 feed 的降级见权限草案 §7.1）。
- [ ] 敏感字段展示走后端脱敏 DTO，前端不做"点一下显示明文"的遮罩逻辑（明文查看要落 `SENSITIVE_FIELD_READ`）。
- [ ] 键盘导航与焦点管理可用（无障碍由无样式原语兜住，不要自己实现下拉/对话框）。

---

**语言**：本目录统一中文（裁定见 `docs/implementation-plan-v1.md` §3 W0-7 对应任务 prd「本票的两条裁定」，覆盖模板默认的 English）。

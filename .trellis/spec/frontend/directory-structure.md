# Directory Structure

> App Router 布局与前端文件归位。
> 来源：`docs/tech-stack-decision.md` §5（拓扑）、§13.5 禁令⑥⑦；`docs/PRD-phase1-master.md` ② 页面清单（14 页与建议路由）。

---

## Directory Layout

```text
src/
├─ app/                          App Router（Route Handlers 与页面同树）
│  ├─ (auth)/login/              P1 登录（route group 不带 URL 段）
│  ├─ (desk)/                    工作台与业务页
│  │  ├─ watch/                  P2 我的关注        /watch
│  │  ├─ notifications/          P3 通知中心        /notifications
│  │  ├─ risk-matters/           P4 列表 / P5 详情 / P6 [id]/convert 转案件
│  │  ├─ matters/                P7 列表 / P8 详情
│  │  └─ parties/                P9 列表 / P10 详情
│  ├─ settings/                  P11 business · P12 automation · P13 users-and-roles · P14 import
│  ├─ api/**                     Route Handlers —— 唯一业务写入口（后端规范，见 ../backend/directory-structure.md）
│  ├─ components/ui/             shadcn 复制件 + 自封装（DataTable.tsx · FileUpload.tsx）
│  │                             —— 业务组件只准依赖这一层，不得直接 import Radix UI（禁令⑦）
│  └─ lib/server/                服务端专用（页面壳**不得**从这里取业务数据）
└─ shared/                       纯 TS：enums(E01–E37) · Zod schema · ids · time · crypto
                                 前端只 import 这一层，且它不得 import next/react/Node（禁令①）
```

> `components/ui/` 与 `lib/server/` 挂在 `src/app/` 下，是技术选型 §5 拓扑图的原样。**N1 已结案（2026-09-27）**：`shadcn init` 默认落 `src/components/ui`，但把 `components.json` 的 `aliases`（`components` / `ui` / `lib` / `utils` / `hooks`）改成 `@/app/...` 之后，`shadcn add` 的六个件全部正确落在 `src/app/components/ui/` → **§5 守得住，不要反过来把 §5 改成 CLI 默认值**。另：`init` 会顺手改 `layout.tsx` 与 `globals.css`，**跑完必须 review diff**（见研究文档 §6.4 第 6 条）。

---

## 页面壳的职责（禁令⑥）

**页面壳不得预取业务数据。** SSR 只出外壳与静态文案，一切业务读取发生在鉴权后的 `/api/**`（禁令⑥原文理由：否则行级数据范围被页面壳绕开）。

- 因此 `page.tsx` / `layout.tsx` 里**不应出现** `db.select(...)`、`matterRepo.*`、任何带 scope 的查询。
- 业务数据由客户端组件经 react-query 打 `/api/**` 取（见 [Hook Guidelines](./hook-guidelines.md)）。
- 这条**替代**了 Nuxt 时代"整站 SPA + `spa-loading-template.html`"那条（§13.2 判其作废）。自托管不需要静态导出，保留服务端进程即可（§13.3-2），所以不要为了"更像 SPA"去关 SSR——只管壳。

---

## Naming Conventions

- 目录段与 master ② 的建议路由保持一致：`risk-matters`（连字符）、`users-and-roles`、`matters/[id]`。动态段用 `[id]`，**类型靠宿主上下文区分**，不要造 `/hosts/{type}/{id}`（修订稿 §1.0.2 明令禁止这种泛化抽象）。
- 枚举值一律全称 `risk_matter`，禁止缩写 `risk`（修订稿 §8.3）。前端展示名用 DTO 的 `displayName`，不自己拼。
- 组件文件 PascalCase（`DataTable.tsx`）；业务组件放 `components/<域>/`；**只有** shadcn 复制件与自封装基元放 `components/ui/`。
- 路由命名规范目前**只有 master ② 的建议值**，未见成文的路由规范票；新增页面先登记进 master ② 再建目录，避免 `/case` 与 `/matters` 并存。

---

## Module Organization

| 要写的东西 | 落在哪 |
|---|---|
| 新列表页 | `(desk)/<资源>/page.tsx`（外壳）+ `components/<资源>/*Table.tsx`（走 DataTable） |
| 详情页的 Tab（案件详情 8 个 Tab，含新增附件 Tab） | `components/matter/tabs/*`，宿主上下文由路由段给（修订稿 §7.1） |
| 转案件动态数组表单 | `components/convert/`，react-hook-form + Zod resolver（矩阵 §3） |
| 人员选择器（加参与人/关注人） | `components/ui/user-picker/`，只调 `selectable-users`，见权限草案 §4.1 |
| 服务端专用工具（session、签名、db） | `src/app/lib/server/`，前端页面不得 import |

**反例（本项目会踩的）**：把 `db` 或云之家客户端 import 进 `components/` —— 会把服务端代码带进客户端 bundle（禁令①的同类错误）。

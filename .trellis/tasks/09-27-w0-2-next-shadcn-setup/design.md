# W0-2 设计

## 为什么不用 `create-next-app`

官方安装页写明 `create-next-app` 默认包含 **AGENTS.md（并让 CLAUDE.md 引用它）**。本仓 `AGENTS.md` 是 Trellis 的受管块（`.trellis/workflow.md` 的入口说明），被覆盖会让后续每个会话丢掉工作流指引，而且不会报错。因此本票手工装配：加依赖 → 写 `next.config.ts` → 写 `src/app/{layout,page,globals.css}` → 配 PostCSS → 再上 shadcn。

## 分层与文件

```text
next.config.ts            output: 'standalone'（§13.1 部署形态）
postcss.config.mjs        @tailwindcss/postcss（Tailwind v4 的接法）
components.json           shadcn CLI 的落点与 alias —— 本票的关键配置
src/app/globals.css       @import "tailwindcss" + shadcn 主题变量
src/app/layout.tsx        根布局：只 import 全局样式与静态外壳
src/app/page.tsx          占位首页：零业务数据（禁令⑥）
src/app/components/ui/*   shadcn 复制件落这里（§5 拓扑）
src/app/lib/utils.ts      cn()（若 CLI 要求，按 §5 放 lib 下）
```

`components.json` 的 alias 是本票第一个要验的东西：`ui` 指 `@/app/components/ui`、`components` 指 `@/app/components`、`lib.utils` 指 `@/app/lib/utils`。`tsconfig` 已有 `@/* → src/*`，所以这三条都成立——但**要跑一次 `shadcn add` 才算证明**，配置写了不算。

## tsconfig 要补的项

Next 需要 `jsx: "preserve"`、`lib: ["dom","dom.iterable","esnext"]`、`plugins: [{name:"next"}]`、`allowJs`、`incremental`，并把 `.next/types/**/*.ts` 纳入 include。W0-1 的 `noEmit`/`strict`/`verbatimModuleSyntax` 全部保留（`verbatimModuleSyntax` 与 Next 的 type-only import 惯例兼容，若冲突按 Next 侧改并记录原因）。

## 依赖

`next@16`、`react`、`react-dom`；dev：`@types/react`、`@types/react-dom`、`tailwindcss@4`、`@tailwindcss/postcss`、`clsx`、`tailwind-merge`、`tw-animate-css`（shadcn v4 主题常用）。**不装**任何带样式的组件库（禁令⑦）。

## N1 的取证方式

| 问题 | 取证 |
|---|---|
| 有没有上传件 | 拉 `https://ui.shadcn.com/r/index.json` 全量清单（已核到 63 项，含 `attachment` 但无 `upload`/`dropzone`）→ **再实装 `attachment` 读源码**判断它是不是文件上传（名字像附件展示）。两条都要，清单会骗人。 |
| 原语包是谁 | 读实装件顶部的 import 与 `package.json` 新增依赖（registry 的 `meta.links` 里同时有 `bases/base` 与 `bases/aria`，说明 shadcn 现在有多原语实现，不能默认 Radix） |
| 落点是否可配 | `shadcn add` 后 `git status` 看真实路径 |
| CLI 能力 | `shadcn init` / `add` / `view` 现场跑，Blocks 与 registry 行为一并记录 |

结论一律写回 `docs/research-nextjs-stack.md` §5（N1 标 VERIFIED）与 §3（组件清单从"未证实"改为实测清单），并同步技术选型 §13.4、master P1-18、spec 里的相关 UNVERIFIED 标注。

## 退路

若 CLI 无法把件落到 `src/app/components/ui/`：按 §5 为准，用 `tsconfig paths` 加一条别名或改 `components.json` 的组合解决；**不允许**反过来把 §5 改成 CLI 默认位置（那是"实现替产品做决定"的老毛病）。若 `attachment` 确认为非上传件，`FileUpload` 自封装的排期不变（W3-7）。

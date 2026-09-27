# W0-2 Next 16 + Tailwind v4 + shadcn 装配 PRD（含 N1 spike）

票面出处：`docs/implementation-plan-v1.md` §3 的 **W0-2**（派票）；出处列写的是技术选型 §3.3 与 `docs/research-nextjs-stack.md` §5 的 **N1**。本票同时是 M0 退出条件里"N1 通过"这条的证据来源。

## 交付

1. Next 16（App Router）+ React + Tailwind v4 装配可跑；`src/app/components/ui/` 出基线件。
2. **N1 的四个问题必须用现场产物回答**（不是靠文档推断）：
   - 原版 shadcn 到底有没有现成**上传件**？（此前"抓取失败未核到"，P1-18 挂着）
   - CLI 能否把组件落到技术选型 §5 指定的 `src/app/components/ui/`（而不是默认的 `src/components/ui`）？
   - 原语包到底是哪个（registry 的 `meta.links` 里同时出现 `bases/base` 与 `bases/aria`，说明 shadcn 现在有多原语实现）？
   - `components.json` 的 alias 配法与 `cn()` 位置。
3. 装配结果不得破坏 W0-1 的 `pnpm verify`（format/lint/typecheck/test/lint-guard 五步）。

## 约束（不得违反）

- **禁令⑥**：页面壳零业务数据 —— 本票只放外壳与静态文案，不接 DB、不预取。
- **禁令⑦**：只允许 shadcn + Tailwind 一套；不得为缺件引第二套带样式库。
- **禁令①**：`src/shared/**` 依旧禁 `next/*`/`react`/Node API；lint-guard 必须仍然红得起来。
- **不用 `create-next-app`**：官方文档写明它默认会生成 `AGENTS.md`（并让 `CLAUDE.md` 引用），本仓 `AGENTS.md` 是 Trellis 受管块，覆盖会静默毁掉工作流说明。改为手工加依赖 + 手写配置。
- Next 16 起 `next build` 不再自动跑 lint，所以 lint 仍走独立脚本（W0-1 已建）。

## 验收

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | ✅ `pnpm build` 成功且产出 `.next/standalone` | 实跑：Turbopack 编译通过，`.next/standalone/{server.js,package.json,node_modules}` 存在 |
| 2 | ⚠ 半：Next+Tailwind 起得来（build 通过、`cn()` 有测试），**`shadcn add` 未验** | 网络 `ECONNRESET` 挡住 |
| 3 | ⏸ 未验（依赖 #2） | 网络恢复后跑 `init` 再看路径 |
| 4 | ❌→✅ **曾误结案、当日撤回**：registry 清单里没有 `upload`/`dropzone` 命名 ≠ 没有可用的件。改从官方 GitHub 仓取到 `attachment` 一手源码后确认它是**附件展示件**（带 `idle\|uploading\|processing\|error\|done`），于是 W3-7 从「整件自封装」缩为「逻辑自封装 + 展示层用 `Attachment`」 | `research/attachment-组件定性.md` + 研究文档 §3.2 |
| 5 | ✅ `pnpm verify` 五步全绿（5 个测试），且把 `files` 段改错后 lint-guard 当场 exit 1 | 实跑 + 反向实验 |
| 6 | ✅ 结论已回写四处：研究文档 §3.1/§5/§6、技术选型 §13.4、master P1-18-补、spec `component-guidelines.md`（含新事实：原语是 `radix|base|aria` 三选一） | 见提交 |

## 不在本票

DataTable / FileUpload 的**实现**（W3-1 / W3-7）、业务路由、DB 连接（阻塞在共享机角色权限，与装配无关）。

## 三条现场才知道的事实（写进 spec 与研究文档）

1. **不要用 `create-next-app`**：官方默认特性包含生成 `AGENTS.md`（并让 `CLAUDE.md` 引用），本仓 `AGENTS.md` 是 Trellis 受管块，覆盖是静默的。本票全程手工装配。
2. **Next 16 构建会强改 `tsconfig.json` 的 `jsx` → `react-jsx`**，但**不回退其它严格项**（`strict`/`noUncheckedIndexedAccess`/`verbatimModuleSyntax`/`noUnusedLocals` 实测都还在）。
3. **shadcn CLI 4.21.0 的 `base` 是 `radix | base | aria` 三选一**，默认组合 `style=nova / baseColor=neutral / iconLibrary=lucide / font=geist`。禁令⑦ 里的"Radix UI"因此是**本仓选定项**而非唯一可能。

## 剩余工作（网络窗口到了再做，约 20 分钟）

`pnpm dlx shadcn@latest init --yes --defaults --base radix` → 改 alias 到 `@/app/components{,/ui}` 与 `@/app/lib/utils` → `add button card input dialog attachment` → 读 `attachment` 源码定性 → 验中文 locale → 回填 §6.3 与本票第 6–8 步。

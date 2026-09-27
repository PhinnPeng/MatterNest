# W0-2 执行清单

1. [x] 依赖：`next@16 react react-dom` + dev 侧 `@types/react @types/react-dom tailwindcss @tailwindcss/postcss clsx tailwind-merge`
2. [x] `next.config.ts`（`output: 'standalone'`）、`postcss.config.mjs`
3. [x] `src/app/globals.css`（`@import "tailwindcss"` + 主题变量）、`layout.tsx`、`page.tsx`（零业务数据）
4. [x] `tsconfig.json` 补 Next 需要的项，保留 W0-1 的 strict 组合
5. [x] `pnpm build` 出 `.next/standalone`；`pnpm dev` 起来（截图/HTML 取证）
6. [ ] `components.json` alias 指向 `@/app/components/ui` → `shadcn init`
7. [ ] `shadcn add button card input dialog attachment` → **读 `attachment` 源码**判定是否上传件
8. [ ] 记录 CLI 新增的原语依赖包名（Radix / base-ui / 其他）
9. [x] `pnpm verify` 全绿 + lint-guard 反向实验一次
10. [x] 结论回写：`research-nextjs-stack.md` §3/§5、技术选型 §13.4、master P1-18、spec 三处 UNVERIFIED 标注、CHANGELOG
11. [ ] 提交 + journal + archive

## 状态（2026-09-27）：**部分完成，阻塞在网络**

第 1–5、9 步完成（Next 16.3.6 + React 19.3 + Tailwind 4.3.3 装配、`pnpm build` 出 `.next/standalone`、`cn()` + 3 条行为测试、`pnpm verify` 五步全绿、lint-guard 反向实验仍变红）。
**第 6–8 步没做成**：`ui.shadcn.com` 在同一次会话里先返回过一次 `/r/index.json`（63 项，无 upload/dropzone 命名的件），随后所有请求持续 `ECONNRESET`，`shadcn init` / `add` 全部失败 → `components/ui/` 基线未产出、`attachment` 性质未读源码、中文 locale 未验。`components.json` 故意不手写。
第 10 步已回写四份文档；第 11 步只提交、**不 archive**（任务保持 `in_progress`，等网络窗口补 6–8）。

## 验证命令

```bash
pnpm install && pnpm build && pnpm verify
node tools/lint-guard/check.mjs
ls src/app/components/ui
```

## 回滚点

全部为新增文件与依赖；`git checkout -- package.json pnpm-lock.yaml tsconfig.json && git clean -fd src/app .next` 可退回 W0-1 状态。

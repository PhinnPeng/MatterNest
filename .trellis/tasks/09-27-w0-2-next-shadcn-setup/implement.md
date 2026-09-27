# W0-2 执行清单

1. [x] 依赖：`next@16 react react-dom` + dev 侧 `@types/react @types/react-dom tailwindcss @tailwindcss/postcss clsx tailwind-merge`
2. [x] `next.config.ts`（`output: 'standalone'`）、`postcss.config.mjs`
3. [x] `src/app/globals.css`（`@import "tailwindcss"` + 主题变量）、`layout.tsx`、`page.tsx`（零业务数据）
4. [x] `tsconfig.json` 补 Next 需要的项，保留 W0-1 的 strict 组合
5. [x] `pnpm build` 出 `.next/standalone`；`pnpm dev` 起来（截图/HTML 取证）
6. [x] `components.json` alias 指向 `@/app/components/ui` → `shadcn init`
7. [x] `shadcn add button card input dialog attachment` → **读 `attachment` 源码**判定是否上传件
8. [x] 记录 CLI 新增的原语依赖包名（Radix / base-ui / 其他）
9. [x] `pnpm verify` 全绿 + lint-guard 反向实验一次
10. [x] 结论回写：`research-nextjs-stack.md` §3/§5、技术选型 §13.4、master P1-18、spec 三处 UNVERIFIED 标注、CHANGELOG
11. [x] 提交 + journal + archive

## 状态（2026-09-27）：**✅ 完成，N1 通过**（同日加代理后跑完）

第 1–5、9 步完成（Next 16.3.6 + React 19.3 + Tailwind 4.3.3 装配、`pnpm build` 出 `.next/standalone`、`cn()` + 3 条行为测试、`pnpm verify` 五步全绿、lint-guard 反向实验仍变红）。
**第 6–8 步当时被 `ui.shadcn.com` 的域名级重置挡住（TCP 连上即 RST，同机访问 npm/GitHub 全通），用户加代理后同日跑完**：`init --base radix` + `add button card input dialog attachment calendar` 全部成功；`components.json` 的 aliases 改指 `@/app/...` 后六个件正确落在 `src/app/components/ui/`；`attachment` 定性为附件展示件（含上传态）；中文 locale 实测渲染出「九月 2026」。
第 10 步回写 7 处文档；第 11 步提交 + journal + **archive**（N1 已过，任务闭环）。

## 验证命令

```bash
pnpm install && pnpm build && pnpm verify
node tools/lint-guard/check.mjs
ls src/app/components/ui
```

## 回滚点

全部为新增文件与依赖；`git checkout -- package.json pnpm-lock.yaml tsconfig.json && git clean -fd src/app .next` 可退回 W0-1 状态。

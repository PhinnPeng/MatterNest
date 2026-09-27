# W0-1 执行清单

状态：**已执行完，`pnpm verify` 全绿**（2026-09-27）。

## 顺序

1. [ ] 根配置：`package.json`（private / name=matter-nest / packageManager / engines ">=22.0.0 <23" / 六个 script）
2. [ ] `tsconfig.json`：`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `noFallthroughCasesInSwitch` + `moduleResolution: bundler` + `target ES2022` + `noEmit` + `paths {"@/*": ["./src/*"]}`
3. [ ] `.gitignore` 增补：`node_modules/`、`.next/`、`out/`、`coverage/`、`.env`、`.env.*`（放行 `.env.example`）、`*.tsbuildinfo`、`.pnpm-store/`
4. [ ] `eslint.config.mjs`：flat config，含 `src/shared/**` 的 `no-restricted-imports`（禁令① 四组）
5. [ ] `.prettierrc` + `.prettierignore`（不动 `docs/` 的排版，避免把设计文档重排成一大坨 diff）
6. [ ] `vitest.config.ts`：include `src/**/*.spec.ts`、`worker/**/*.spec.ts`
7. [ ] 目录 + 占位说明：`src/app/`、`src/app/components/ui/`、`src/app/lib/server/`、`src/shared/{enums,schema,ids,time,crypto}/`、`worker/`、`deploy/`
8. [ ] `tools/lint-guard/`：`check.mjs`（违规 fixture 必须报错 + 合法对照必须 0 错）、两个 fixture、`README.md`（含"禁裸 select 待 W2-1"的挂账说明）
9. [ ] `.env.example`：十项键名（PG/MINIO/AES/HMAC/云之家/OIDC/state/`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`/`DEPLOYMENT_VERSION`），**host 一律占位**并写明共享机当前不可达
10. [ ] `pnpm install` → `pnpm verify` 全绿
11. [ ] 技术选型 §7 假设 A 的 Node 数值按实测改正（append-only）
12. [ ] 回写本票 prd 的验收勾选 + CHANGELOG + 提交 + journal + archive

## 验证命令

```bash
pnpm install
pnpm verify
node tools/lint-guard/check.mjs   # 单独跑，看证伪断言的两侧
git status --porcelain            # 交付以文件实存为准，不采信叙述
```

## 回滚点

全部是新增文件 + 一处文档标注，`git clean -fd` 与 `git checkout docs/tech-stack-decision.md` 即可整体退回；不动 `docs/` 既有结论、不动 `.trellis/spec/`。

# W0-1 设计

## 边界

产出**只到"壳"**：配置文件 + 目录 + 一条可证伪的 lint 断言。任何 Next/shadcn/Drizzle/容器都不在本票内（分属 W0-2/W0-4/W0-5）。

## 依赖选择（每个都给理由，不引未讨论过的库）

| 包 | 用途 | 为什么 |
|---|---|---|
| `typescript` | 编译与 `tsc --noEmit` | 官方最低 5.1，装 5.x 最新 |
| `eslint` + `@eslint/js` + `typescript-eslint` | flat config lint | 官方 16 文档默认路径给 ESLint；Biome 是备选但本仓 spec 未定，不换 |
| `prettier` + `eslint-config-prettier` | 格式与规则互斥关闭 | 落地方案 W0-1 要求 Prettier |
| `vitest` | 单测与回归锁载体 | W0-1 指定；Next 不介入纯 TS 测试 |

**不装**：`next`、`react`、`tailwindcss`、`shadcn`、`drizzle-orm`（分属 W0-2/W0-4）；`pnpm-workspace`（§5 单 app）；`turbo`/`nx`（§3.6 否）。

## 目录与占位

```text
src/app/README.md            壳与 api/**，W0-2 起内容
src/app/components/ui/       唯一组件层（§5 把它画在 app 下）
src/app/lib/server/          服务端专用层
src/shared/                  纯 TS 共用层：enums/schema/ids/time/crypto 各建子目录
worker/  deploy/             W0-5 前只占位
tools/lint-guard/            禁令① 的可证伪断言
```

## 禁令① 的落地方式（本票唯一有"实现含量"的部分）

flat config 对 `src/shared/**` 生效：

```js
{
  files: ["src/shared/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [
        { group: ["next", "next/*"], message: "禁令①：src/shared 不得依赖 Next" },
        { group: ["react", "react-dom", "react/*"], message: "禁令①：src/shared 不得依赖 React" },
        { group: ["node:*", "fs", "path", "crypto", "worker_threads"], message: "禁令①：src/shared 不得依赖 Node API" },
        { group: ["@/app/*"], message: "禁令①：src/shared 不得反向依赖 app 层" }
      ]
    }]
  }
}
```

**为什么还要一条"证伪"测试**：本项目的教训是"规则躺在配置里 ≠ 拦得住"。`tools/lint-guard/check.mjs` 对 `fixtures/bad-shared-import.ts`（含 `import { readFileSync } from "node:fs"` 与 `import "next/headers"`）跑 `eslint --format json`，**断言 error 数 ≥ 1**；再把 `src/shared/purity.spec.ts` 里的合法 import 作为对照组跑一遍，断言 0 error。两条都过才算这条禁令有 CI 价值。任何一条被误删，`verify` 直接红。

## 脚本

```json
"lint": "eslint .",
"lint:fix": "eslint . --fix",
"format": "prettier --write .",
"format:check": "prettier --check .",
"typecheck": "tsc --noEmit",
"test": "vitest run",
"verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && node tools/lint-guard/check.mjs"
```

`verify` 是"CI 后定"期间的唯一入口：任何平台将来接手，只要调这一条。

## 不做什么（避免顺手扩张）

- 不写 ESLint 自定义插件做"禁裸 `select()`"——仓储基类还不存在（W2-1），现在写规则等于对空气执法。改为在 `tools/lint-guard/README.md` 记一条待办与它应挂在哪个文件上。
- 不加 husky/lint-staged：单人 + agent 施工期，pre-commit 钩子挡不住任何真实错误，`verify` 才是关口。
- 不做 `.nvmrc`：Node 由 `engines` + 后续 Dockerfile 钉，避免两处版本源。

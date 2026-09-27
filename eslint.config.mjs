import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import {
  SHELL_FILES_GLOBS,
  SHELL_PATTERNS,
  SHARED_PATTERNS,
  UI_FILES_GLOB,
  UI_IGNORE_GLOBS,
  UI_PATTERNS,
} from "./tools/lint-guard/restricted-imports.mjs";

/**
 * 禁令①（.trellis/spec/backend/directory-structure.md ← 技术选型 §13.5-1）：
 * `src/shared/**` 只放纯 TS——不得 import `next/*`、`react`、Node API，也不得反向依赖 app 层。
 * 它同时被客户端与服务端引用，污染了就会把服务端代码带进前端 bundle。
 *
 * 这条规则"存在"不等于"有效"：`tools/lint-guard/check.mjs` 会把 fixtures 里的代码
 * 以 `src/shared/` 下的虚拟路径喂给**本 config**，断言违规必被拦、合法不误伤；
 * `pnpm verify` 每次都跑，规则被谁改坏了当场就红。
 */
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "coverage/**",
      ".trellis/**",
      "docs/**",
      "pnpm-lock.yaml",
      "next-env.d.ts",
      ".next/**",
      // 一次性 spike/探针的落盘处（已 gitignore），不参与仓库 lint
      "agent-work/**",
      // fixtures 是"故意写坏的样本"，本身不参与仓库 lint；check.mjs 用 lintText 读它们
      "tools/lint-guard/fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/shared/**/*.ts", "src/shared/**/*.tsx"],
    rules: {
      "no-restricted-imports": ["error", { patterns: SHARED_PATTERNS }],
    },
  },
  {
    // 禁令⑦（一套组件体系）：业务代码不得直连原语包，components/ui/ 那一层除外
    files: [UI_FILES_GLOB],
    ignores: UI_IGNORE_GLOBS,
    rules: {
      "no-restricted-imports": ["error", { patterns: UI_PATTERNS }],
    },
  },
  {
    // 禁令⑥/⑤（页面壳不预取业务数据、鉴权在 handler 内）
    files: SHELL_FILES_GLOBS,
    rules: {
      "no-restricted-imports": ["error", { patterns: SHELL_PATTERNS }],
    },
  },
  {
    // 构建/校验脚本跑在 Node 上，给 globals 而不是关 no-undef
    files: ["tools/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
  prettierConfig,
);

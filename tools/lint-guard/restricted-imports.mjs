/**
 * 禁令① 的唯一规则源（技术选型 §13.5-1 / `.trellis/spec/backend/directory-structure.md`）：
 * `src/shared/**` 只放纯 TS——不得 import `next/*`、`react`、Node API，也不得反向依赖 app 层。
 *
 * 这份 patterns 同时被两处消费，避免"测试用的规则"与"仓库用的规则"分叉：
 *   1. `eslint.config.mjs` —— 真正作用于 src/shared/**
 *   2. `tools/lint-guard/check.mjs` —— 拿它去撞 fixtures/bad/，证明规则会触发
 */
export const SHARED_PATTERNS = [
  {
    group: ["next", "next/*"],
    message: "禁令①：src/shared 不得依赖 Next（它同时进客户端与服务端 bundle）",
  },
  {
    group: ["react", "react-dom", "react/*", "react-dom/*"],
    message: "禁令①：src/shared 不得依赖 React",
  },
  {
    group: ["node:*", "fs", "path", "crypto", "os", "worker_threads", "child_process"],
    message: "禁令①：src/shared 不得依赖 Node API",
  },
  {
    group: ["@/app/*", "@/server/*"],
    message: "禁令①：src/shared 不得反向依赖 app / 服务端层",
  },
];

export const SHARED_RULE = { "no-restricted-imports": ["error", { patterns: SHARED_PATTERNS }] };

export const GUARD_GLOBS = {
  bad: "tools/lint-guard/fixtures/bad/**/*.ts",
  good: "tools/lint-guard/fixtures/good/**/*.ts",
};

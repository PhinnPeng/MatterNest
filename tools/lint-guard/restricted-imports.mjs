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

/**
 * 禁令⑦（一套组件体系）：业务代码**不得直连原语包**。
 *
 * 为什么这条值得被机器拦而不是靠 review：`radix-ui` 那个包在 v1.6 里把每个组件都
 * 以命名空间形式导出（`import { Select } from "radix-ui"`），直连写起来比走
 * `components/ui/` 那层**更短**，所以"图省事绕过封装"是默认会发生的事。
 * 一旦有人直连，主题令牌与 `data-slot` 约定就开始分叉，而分叉要很久以后才看得见。
 *
 * 不拦 `lucide-react`：图标是叶子资源，包一层 `components/ui/icon.tsx` 只是加噪音。
 */
export const UI_PATTERNS = [
  {
    group: ["radix-ui", "radix-ui/*", "@radix-ui", "@radix-ui/*"],
    message: "禁令⑦：原语一律经 components/ui/ 那层，业务组件不得直连 radix",
  },
  {
    group: ["@tanstack/react-table", "@tanstack/react-table/*"],
    message: "禁令⑦/⑧：表格一律经 components/ui/data-table/，直连等于绕过服务端分页那条门",
  },
  {
    group: ["class-variance-authority"],
    message: "禁令⑦：变体只在 components/ui/ 里定义，业务侧用 cn() 合并即可",
  },
];

/**
 * 禁令⑥（页面壳不预取业务数据）+ 禁令⑤（鉴权在 handler 内）：
 * `page.tsx` / `layout.tsx` 不得 import 服务端数据层。
 *
 * 这一条真正防的是"`export const dynamic = 'force-dynamic'` 顺手在页面里 `await getMatter()`"——
 * 那样数据会在**鉴权之前**（middleware 不参与）被渲染进 HTML，
 * 而 HTML 是可被缓存、可被抓包、可被浏览器历史看到的第三条通道。
 */
export const SHELL_PATTERNS = [
  {
    group: ["@/app/lib/server/*", "@/app/lib/server/**", "@/lib/server/*", "@/lib/server/**"],
    message: "禁令⑥/⑤：页面壳与布局不得直连服务端数据层，读一律走鉴权后的 /api/**",
  },
  {
    group: ["postgres", "drizzle-orm"],
    message: "禁令⑥：页面壳里出现 DB 驱动/ORM 就是绕过了 handler 层",
  },
];

export const UI_FILES_GLOB = "src/app/**/*.{ts,tsx}";
export const UI_IGNORE_GLOBS = [
  "src/app/components/ui/**", // 这一层就是用来包原语的
  "src/app/lib/client/**", // 客户端数据层（react-query 的门面）
  "src/app/api/**", // handler 层按定义要碰 DB
  "src/app/lib/server/**",
];
export const SHELL_FILES_GLOBS = ["src/app/**/page.tsx", "src/app/**/layout.tsx"];

export const GUARD_GLOBS = {
  bad: "tools/lint-guard/fixtures/bad/**/*.ts",
  good: "tools/lint-guard/fixtures/good/**/*.ts",
};

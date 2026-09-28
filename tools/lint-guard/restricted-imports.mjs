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
 * 禁令⑦（一套组件体系）—— v6 起这一条的意思是 **antd**，不再是"业务代码不许直连 radix"。
 *
 * 换库之前，风险是"有人绕过 `components/ui/` 直接 import 原语"；换库之后，`radix`、
 * `class-variance-authority`、`@tanstack/react-table` 已经从 `package.json` 里删掉了，
 * 于是风险换了一副面孔，三种都会静默发生：
 *   1. **把上一套体系请回来**：`date-fns`/`lucide-react`/`react-hook-form` 这类
 *      "只是一个小工具"的依赖最容易在赶工时被加回来，加进来就出现两套格式化/图标/表单口径；
 *   2. **把 Pro 装上**：`@ant-design/pro-components@2.8.10` 的 peer 是 `antd ^4.24.15 || ^5.11.2`，
 *      **不含 antd 6** —— 装上能过 lint，运行时把样式拉回 v5，症状要过几屏才看得出来；
 *   3. **走 antd 深路径**：`import type { ColumnsType } from "antd/es/table"` 这类写法
 *      绕过顶层 barrel，也就绕过 `@ant-design/nextjs-registry` 的样式抽取；
 *      顶层其实都有（`TableColumnsType`、`FormRule`），所以这不是"没得选"。
 *
 * 与旧版的一处不同：**不再豁免 `components/ui/`**。那一层以前是"包原语的层"，
 * 现在只是"包我们的约定的层"（表格门、状态语义、密度），没有需要碰深路径的理由。
 * 真需要逃生口时改这条规则本身并说明理由——fixtures 会当场告诉你改坏了什么。
 */
export const UI_PATTERNS = [
  {
    group: ["antd/es", "antd/es/*", "antd/lib", "antd/lib/*", "antd/dist/*"],
    message: '禁令⑦：antd 一律从顶层 "antd" 取（类型也在 index 上：TableColumnsType / FormRule）',
  },
  {
    group: ["@ant-design/pro-components", "@ant-design/pro-components/*"],
    message:
      "禁令⑦：pro-components 的 peer 只到 antd 5，接在 antd 6 上会把样式拉回 v5 运行时；查询区用 components/list-toolbar，表格用 ui/data-table/DataTable",
  },
  {
    group: ["radix-ui", "radix-ui/*", "@radix-ui", "@radix-ui/*", "class-variance-authority"],
    message: "禁令⑦：上一套 shadcn 体系的依赖已删除，组件体系只有 antd",
  },
  {
    group: ["@tanstack/react-table", "@tanstack/react-table/*"],
    message:
      "禁令⑦/⑧：表格只走 components/ui/data-table/DataTable（服务端分页 >100 直接抛的门在那儿）",
  },
  {
    group: ["lucide-react", "lucide-react/*"],
    message: "禁令⑦：图标只有 @ant-design/icons（两套图标混用是最先看得见的不一致）",
  },
  {
    group: [
      "react-hook-form",
      "react-hook-form/*",
      "@hookform/resolvers",
      "@hookform/resolvers/*",
      "formily",
      "@formily/*",
    ],
    message:
      "禁令⑦：表单只有 antd Form；校验规则从 shared 的 Zod 推导，见 components/form/zod-rules（单一规则源，不再第二份声明）",
  },
  {
    group: ["date-fns", "date-fns/*", "moment", "moment/*", "luxon"],
    message:
      "禁令⑦：日期只有 dayjs（antd 的 DatePicker 认 dayjs；多一个库就多一套时区与格式化口径）",
  },
];

/**
 * 禁令⑦ 的第二半：**一个色只定义一次**。
 *
 * `src/app/theme/brand.ts` 是唯一的色值源，`theme/antd.ts` 只做 antd token 映射，
 * 其余地方一律 `BRAND.primary` / `INK.muted`。理由不是洁癖：这一轮迁移里最费时间的
 * 就是 40 多处内联灰——它们本来分散在两个组件库里各自"差不多"的灰里，改一次刻度要全仓搜。
 *
 * 白（`#fff` / `#ffffff`）放过：它没有刻度可言，写成常量反而更难读。
 * 半透明不写字面量而是 `alpha(BRAND.sider.item, .62)`——同一个色只有一份十六进制。
 * CSS 侧（`globals.css` 的纸色底与正文色）eslint 管不到，那边留了注释指向 brand.ts。
 */
export const COLOR_RULE = {
  "no-restricted-syntax": [
    "error",
    {
      selector: String.raw`Literal[value=/#(?!fff\b|ffffff\b)[0-9a-fA-F]{3,8}/]`,
      message:
        "禁令⑦：色值只在 src/app/theme/brand.ts 里定义，业务侧用 BRAND.* / INK.*（只有白 #fff 可以写出来）",
    },
    {
      selector: String.raw`Literal[value=/[ra]gba?\(/]`,
      message:
        "禁令⑦：半透明用 theme/brand.ts 的 alpha(颜色, 透明度)，别再手写第二份 rgb()/rgba() 色值",
    },
  ],
};

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

/** 禁令⑦ 挂在 app 层全域（含 components/ui/，见上面那段说明） */
export const UI_FILES_GLOB = "src/app/**/*.{ts,tsx}";
export const UI_IGNORE_GLOBS = [];
/** 唯一例外：主题那两个文件就是定义颜色的地方 */
export const COLOR_IGNORE_GLOBS = ["src/app/theme/**"];
export const SHELL_FILES_GLOBS = ["src/app/**/page.tsx", "src/app/**/layout.tsx"];

export const GUARD_GLOBS = {
  bad: "tools/lint-guard/fixtures/bad/**/*.ts",
  good: "tools/lint-guard/fixtures/good/**/*.ts",
};

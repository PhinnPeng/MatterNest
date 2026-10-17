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
export const COLOR_SELECTORS = [
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
];

export const COLOR_RULE = { "no-restricted-syntax": ["error", ...COLOR_SELECTORS] };

/**
 * 出口形态（2026-10-17 retro 候选 1）：**404 只从 `http.ts:notFound()` 出来**。
 *
 * 这一条防的是手写 `fail(404, ...)`：`api-route-conventions.md` 规则 3 把出口限定在
 * `json` / `fail` / `notFound` / `unauthorized` / `reasonRequired` / `attributionRequired`，
 * 而"不可见与不存在同形 404、且**措辞一致**"是权限模型的骨架 —— 手写一份就多一份措辞，
 * 两句"找不到"迟早分叉，而两条路都 200/404 得一模一样。
 *
 * 实测来源：2026-10-17 复审发现 `api/watch/[targetType]/[targetId]/route.ts` 自己写了
 * `fail(404, "not_found", "找不到这条记录。")`，与 `http.ts:54` 的规范措辞不同。
 * 修掉之后全仓**零基线**（只剩 `http.ts` 自己那一处定义，被 ignore 掉），所以这条规则
 * 不需要任何存量豁免。
 */
export const EXIT_SELECTORS = [
  {
    selector: "CallExpression[callee.name='fail'][arguments.0.value=404]",
    message:
      "404 出口只有 http.ts 的 notFound()：手写 fail(404, …) 会带出第二份「找不到」措辞，而「不可见与不存在同形同措辞」是权限模型的骨架（api-route-conventions.md 规则 3）",
  },
];

/**
 * id 形态单源（2026-10-17 retro 候选 1）：`^\\d{1,19}$` 与 `bigint` 转换只在 `http.ts:pathId()`。
 *
 * `error-handling.md` 第 101 行：`BigInt(路径参数)` 之前**必须**过 `pathId()` ——
 * `BigInt("undefined")` 抛 SyntaxError 会冒成 500，一个手打的错 URL 就能污染错误率监控。
 * 而"19 位上界"这个数字一旦出现第二份，两份就会各自演化。
 *
 * 实测来源：同一个 watch 路由把这份正则**又抄了一遍**放进 shared schema，
 * 并按自造的 `bad_target` 报错 —— 同一个错误在两条路由上报出两个码。
 *
 * ## selector 为什么带 `:not(CallExpression[callee.property.name="array"] *)`
 *
 * 「19 位上界」在仓里有**合法的第二类用法**：body 里的 id **数组**。
 * `shared/schema/batch.ts:85` 与 `api/notifications/read/route.ts:18`、
 * `api/risk-matters/[id]/staff/followers/route.ts:18` 都用它校验 `ids: string[]` ——
 * 那些 id 走 body 而不是路径，`pathId()` 根本用不上（batch.ts 的注释专门写了这条），
 * 但同一个上界**必须跟着**，否则 40 位的 id 会以 PG `value out of range` 变成 500。
 *
 * 所以规则收窄到**单个 id 的 regex**（`z.string().regex(/^\d{1,19}$/)` 这类形状），
 * 数组里的那份放过。四种写法实测过命中面，选定 `:not(…array… *)` 这一种：
 *
 *   · `Literal[regex.pattern="^\\d{1,19}$"]`
 *         → `http.ts` / `notifications:read` / `followers` / `batch.ts` 各 1 处（4 处，太宽）
 *   · `…:not(CallExpression[callee.property.name="array"] *)`  ← **选这个**
 *         → 只剩 `http.ts` 与 `batch.ts`（两个 route 的数组形态被放过）
 *
 * 挂载在 `src/app/**`，所以范围内实际只剩 `http.ts`，而它被 ignore 掉 —— **零基线**。
 * （`batch.ts` 在 `src/shared`，不在本规则的挂载面内，改由它自己的注释守着。）
 */
export const ID_SHAPE_SELECTORS = [
  {
    selector: String.raw`Literal[regex.pattern="^\\d{1,19}$"]:not(CallExpression[callee.property.name="array"] *)`,
    message:
      'id 的形态（19 位上界）与 bigint 转换只在 http.ts:pathId() 一处 —— 路径参数先过 pathId() 再 BigInt，否则 BigInt("undefined") 抛 SyntaxError 冒成 500（error-handling.md 状态码归属表）',
  },
];

/**
 * 宿主集合单源（2026-10-18 retro 候选 3）：`["matter","risk_matter"]` 不许在 `src/app` 里再写一份。
 *
 * 单一源是 `HOST_TYPES`（`shared/enums/targets.ts`，E08∩E10 共用值域）。
 * `type-safety.md` 早写着「**禁止**在 `src/app/**` 里再声明一份业务枚举」，但一直没有检查 ——
 * 2026-10-18 实测清掉两处（`services/selectable-users.ts`、`services/reports.ts`），
 * 另有一处 `HOST_KINDS` 附带的**假注释**（自称"编译期防漏"，而 `HostKind` 是同一个文件里
 * 手写的别名，只能证明字面量等于它自己）—— 详见 `db/schema/hosts.ts` 留的备忘。
 *
 * ## 为什么是 AST selector 而不是源码正则
 *
 * 第一版写成源码断言（`stripTsComments` 之后跑正则），**它永远不可能命中**：
 * `stripTsComments` 的契约就是**把字符串内容也剥掉**（好让 `"<List"` 这类字面量
 * 不被当成"有人真的在用"，见该文件头），于是 `"matter"` 被剥成 `""`，正则再无对象。
 * 症状是最坏的一种 —— 断言**全绿**，看起来"仓库很干净"。AST 读的是语法树，
 * 字符串值还在，且天然不受注释与多行影响。
 *
 * ## 两种顺序都要收（这就是不用 `elements.0/elements.1` 单条的理由）
 *
 * `["matter","risk_matter"]` 与 `["risk_matter","matter"]` 是同一份集合，
 * 只写一条会漏掉另一种写法（实测：单条只命中正序那 2 处，倒序那处静默漏过）。
 *
 * ## 误伤面：只收"两元素且恰好是这两个值"的数组
 *
 * `{ matter: …, risk_matter: … }`（`HOSTS` 与 `HOST_TARGET_PREFIX` 的形状）是**对象**，
 * 是按宿主分派的映射表，不是集合清单 —— selector 要求 `ArrayExpression`，天然不碰。
 * 单个 `"matter"` 字面量到处都是且多数合法（`HOSTS[host]` 的键、DTO 标注），故意不拦：
 * 拦它会把这个仓变成一张没人维护的白名单。
 */
export const HOST_SET_SELECTORS = [
  {
    selector: 'ArrayExpression[elements.0.value="matter"][elements.1.value="risk_matter"]',
    message:
      "宿主集合的单一源是 HOST_TYPES（src/shared/enums/targets.ts）—— 直接引它：`for (const host of HOST_TYPES)` / `HOST_TYPES.map(…)`。抄第二份的失败形态是「新增宿主时改一处漏一处」，而两边都编译得过、单测也绿（type-safety.md：禁止在 src/app/** 里再声明一份业务枚举）",
  },
  {
    selector: 'ArrayExpression[elements.0.value="risk_matter"][elements.1.value="matter"]',
    message:
      "宿主集合的单一源是 HOST_TYPES（src/shared/enums/targets.ts）—— 顺序反着写也是同一份集合，同样要引它（type-safety.md：禁止在 src/app/** 里再声明一份业务枚举）",
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

/** 禁令⑦ 挂在 app 层全域（含 components/ui/，见上面那段说明） */
export const UI_FILES_GLOB = "src/app/**/*.{ts,tsx}";
export const UI_IGNORE_GLOBS = [];
/** 唯一例外：主题那两个文件就是定义颜色的地方 */
export const COLOR_IGNORE_GLOBS = ["src/app/theme/**"];
export const SHELL_FILES_GLOBS = ["src/app/**/page.tsx", "src/app/**/layout.tsx"];

/* ── 出口形态 + id 形态单源（2026-10-17 retro 候选 1）的挂载面 ── */

/**
 * 两条新规则**合挂一个块**，因为它们用的是同一个 eslint 键（`no-restricted-syntax`）——
 * 分成两个块时，后一个会**整条覆盖**前一个的 selector 集合（flat config 按键覆盖，
 * 不是合并），于是挂在窄 glob 上的那条会在宽 glob 的块面前失效。
 * 合成一块、把两组 selector 一起摊开，是最不容易被后来者改坏的形式。
 *
 * 为什么挂 `src/app/**` 全域而不是只挂 `/api` + `lib/server`：
 * 出口规则的产品意图确实只在服务端两层，但把 glob 收窄就得再拆块（见上），
 * 而全域挂上是**无害**的 —— 页面壳与组件里没有 `fail()` 可调，命中即是真的用错了。
 */
export const HTTP_SELECTORS_FILES_GLOB = "src/app/**/*.{ts,tsx}";

export const HTTP_SELECTORS_IGNORE_GLOBS = [
  /** `http.ts` 是前两条规则的**唯一合法现场**：`notFound()` 在此定义、`pathId()` 在此定义 */
  "src/app/lib/server/http.ts",
  /** 主题那两处是 `禁令⑦ 色值单源` 的定义点，扩进去会把它的 E 断言顶掉（见 check.mjs 的 D2/E） */
  "src/app/theme/**",
];

/**
 * 宿主集合单源（retro 候选 3）**复用上面那个挂载块**（`src/app/**`），不另起一块 ——
 * 同一个 eslint 键拆两块时后一块会把前一块的选择器整条覆盖。
 *
 * 上界刻意就到 `src/app`：`shared/enums/targets.ts:84` 是 `HOST_TYPES` 的**定义处**
 * （那行字面量是唯一合法的），而 `shared/enums/automation.ts:29,30,33` 那几处是
 * preset 规则各自的宿主域（`event_occurred: ["matter","risk_matter"]` 那种），
 * 语义上属于"这条规则作用于哪些宿主"，不是"宿主集合" —— 扩到 shared 会把它们全拦下。
 */

export const GUARD_GLOBS = {
  bad: "tools/lint-guard/fixtures/bad/**/*.ts",
  good: "tools/lint-guard/fixtures/good/**/*.ts",
};

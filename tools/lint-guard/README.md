# lint-guard

`check.mjs` 是**对 lint 规则本身的测试**，由 `pnpm verify` 兜住，任一失败 exit 1。

为什么要有：`eslint.config.mjs` 里写了一条规则 ≠ 它会触发。glob 打错、`files` 段写错目录、
被后面的 config 整条覆盖，都会让规则静默失效而 CI 全绿——本项目已经因为"自证脚本覆盖面不足"
翻过一次车（表格密度那次），所以规则也要有回归。

## 现在拦的四条

规则的**唯一声明处**是 `restricted-imports.mjs`：`eslint.config.mjs` 和 `check.mjs` 都从这里取，
所以不存在"测试用的规则"与"仓库用的规则"分叉。

| scope      | 规则                    | 拦什么                                                                        | 挂载点                     |
| ---------- | ----------------------- | ----------------------------------------------------------------------------- | -------------------------- |
| 禁令①      | `no-restricted-imports` | `src/shared/**` 不得 import `next/*`、`react`、Node API、app 层               | `src/shared/**`            |
| 禁令⑦ 体系 | `no-restricted-imports` | 第二套组件体系 / 第二家图标·表单·日期库 / `antd/es/*` 深路径 / pro-components | `src/app/**` 全域          |
| 禁令⑦ 色值 | `no-restricted-syntax`  | 色值字面量（`#…`、`rgb()/rgba()`）只许出现在 `src/app/theme/brand.ts`         | `src/app/**` 减 `theme/**` |
| 禁令⑥⑤     | `no-restricted-imports` | 页面壳不得直连 `lib/server/**`、DB 驱动/ORM                                   | `page.tsx` / `layout.tsx`  |

每个 scope 六道断言：

- **A** fixture 存在且非空（否则 B/C 是假通过）
- **B** 违规代码产出**预期条数**的命中——只断言 `>0` 不够：十条 group 写坏九条也照样绿
- **C** 合法代码 0 命中（防过宽；例如 `antd/locale/zh_CN` 与 `#fff` 必须放行）
- **D** 挂载点上这条规则确实开着（防 `files` 段指错目录）
- **D2** 挂载点上生效的规则**内容**含本 scope 的标记（防后段 config 整条覆盖同名规则）
- **E** "本该允许"的路径上不得出现本 scope 的标记

D2/E 都是**按内容**判断而不是按"规则在不在"判断：禁令⑦ 现在挂在 `src/app/**` 全域，
`api/**` 与 `lib/server/**` 自然也带着它，那些位置不该带的是 ⑥⑤/① 那一份——只看开关状态分辨不出来。

## 加新禁令的写法

往 `SCOPES` 里加一项（`rule` / `marker` / `expectHits` / 两个 fixture / 挂载点 / 不该扩到的地方），
`check.mjs` 的逻辑是通用的，别再复制一份六连。加完**必须先把这条禁令反向弄红一次**再提交：
在真实路径下临时写一个违规文件跑 `npx eslint <该文件>`，确认它真的报错——fixtures 目录被仓库 lint
排除在外，fixture 通过不代表 config 对真实路径生效。

## 待挂进来的第五条（W2-1）

**禁裸 `select()`**（技术选型 §4「ScopeResolver + 禁止裸表访问」行）。故意不实现：
仓储基类还不存在，现在写规则等于对空气执法，而且会误伤合法的迁移脚本。
落地时对 `src/app/lib/server/db/**` 之外的路径禁止从 `drizzle-orm` import `select`。

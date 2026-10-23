# Prototype Guidelines

> 原型（一次性代码）在本仓怎么提、放哪、怎么收。**三问分流**源自 `prototype` 技能
> （LOGIC/UI 二分支 + 通用六条），豁免条款源自本仓事实：原型已升格为契约源。
> 来历与互指见 `.impeccable/mocks/canon-spec.md` 头部「这份规格的来历」。

---

## 先分清两类原型（别用同一套处置）

| | 契约源原型（31 页画廊） | 一次性原型（新提的问题） |
|---|---|---|
| 是什么 | 已被采纳的视觉世界的**参考实现**：`pages/*.html` + `canon.css` + `canon-spec.md` | 为回答**一个具体问题**而提的临时件 |
| 生命周期 | 长期存活、随规格演进 | 答完即捕获（见文末「收工」） |
| 位置 | `.impeccable/mocks/`，**主干** | 见下面的三问分流 |
| 门禁 | `pnpm canon:check`（`verify` 链上）+ `pnpm gallery` 画廊 + `check-headings` + `contrast-all`（后两者需手动跑，见下方 ⚠） | 至少过**旁白**判据；进画廊的另过对比度 |

### ⚠ 门禁的接线现状（2026-10-20 实测，别再照抄旧口径）

这一栏原先写着四个「门禁」，但当时**没有任何一个接进自动化**，而且其中两个失败时**退出码是 0**。
实测：造一个无 `canon.css`、含 `<script>`、无 `nav` 的页面，`canon-check` 报出 6 个问题、**退出码仍为 0**；
`check-headings` 同理。更糟的是 `agent-work/` 是白名单制忽略，这两个脚本**从未入库**——
「接进 verify」会让别人的 clone 立刻红，而本地永远是绿的。

| 脚本 | 已修 | 在 `verify` 里 | 说明 |
|---|---|---|---|
| `canon-check.mjs` | ✅ 退出码 + 三方清单一致性 | ✅ `pnpm canon:check` | 已 `.gitignore` 放行入库 |
| `_chk/check-headings.mjs` | ✅ 退出码 + 三方清单一致性 | ❌ **未接** | 需手动 `node agent-work/_chk/check-headings.mjs` |
| `_chk/contrast-all.mjs` | ❌ 未查 | ❌ 未接 | 需真浏览器，成本另计 |

⇒ 上表「门禁」一词只对**已接线**的那一个成立。写规格时把「打算做」写成「已经守住了」，
比不写更危险。调研与修复依据见 `docs/research-prototype-platform-feasibility.md` §2.4。

## 为什么契约源留主干（豁免条款，防"好心"迁移）

通用原型惯例（含 `prototype` 技能第 6 条）要求「原型提交到一次性分支离开主干，
主分支只留验证过的决定」。**本仓的 31 页画廊不适用这条**，因为它已经不是"答完题的草稿"：

- `src/app/theme/brand.spec.ts` **逐键读取 `pages/canon.css`** 比对（`pnpm verify` 的单测）——
  搬走它，verify 当场红；
- `src/app/globals.css` / `theme/brand.ts` / `components/app-shell.tsx` 的注释与令牌链引用它；
- `agent-work/canon-check.mjs` / `canon-dark.mjs` / `_chk/contrast-all.mjs` 把它当读取源；
- `DESIGN.md` 与 canon-spec 互相定义——它就是设计系统的参考实现，不是草稿。

⇒ **判定：`canon.css` 与 31 页 = 契约源，留在主干。** 任何"把原型归档到一次性分支"
的改动都要先回答上面四个依赖方怎么办；回答不了就不要动。
本节是与技能第 6 条的**有理由豁免**，canon-spec 头部有同款短句（两处双写是刻意的）。

## 三问分流（未来新原型走哪条）

| 问题长什么样 | 分支 | 落地形态 |
|---|---|---|
| 「这页/这个部件**该长什么样**」（单页构图完善） | **静态画廊**（本仓 canon 路线） | 新增 `.impeccable/mocks/pages/xxx.html`：单文件、无 JS、只引 `canon.css`、深色由 `canon-dark.mjs` 复制生成；跑 `pnpm canon:check`（加页必须同时挂进 `index.html` 与 `canon-spec.md`，否则它会红） |
| 「**几个方案选哪个**」（变体选型轮） | **prototype 技能 UI 分支** | 在宿主页上开一次性路由（名字含 `prototype`），3 个**结构上截然不同**的变体，`?variant=` 切换 + 底部浮动切换条；选定后按 canon 落地、原型进 `prototype/*` 分支 |
| 「**状态机 / 逻辑 / 数据形状**对不对」 | **prototype 技能 LOGIC 分支** | 单个自包含 HTML：顶部明写问题；逻辑抽成可搬走的纯模块（reducer/状态机/纯函数）；自由按钮 + 分 tab 引导剧本；不连真库、不写测试（本仓尚无首例） |

**这个决策（2026-10-19，用户拍板）**：变体选型轮用技能 UI 分支的 `?variant=` 同屏切换，
不用画廊来回翻页——变体轮的价值就是同屏快速对比；单页构图完善照旧走静态画廊，
因为它是 canon 纪律（禁 JS、进对比度门禁）的直接延伸。历史的 direction 轮
（`decision/` 六世界）当时没有 `?variant=`，是画廊形态，属于已答完的题，不回改。

## 通用底线（三问哪条都守）

1. **旁白纪律**照过：原型 HTML 不在 `src/` 下，lint-guard 扫不到，只有这条立场拦
   （见 `component-guidelines.md`「副标题纪律」——反例六条里两条来自原型）。
2. **不写死颜色**：一律 `canon.css` 的变量与类；深色靠令牌不靠复制第二份。
   色值单源的另一半在 `theme/brand.ts`，canon.css 是它的对手方（`brand.spec.ts` 两头比）。
3. **身份要标清**：一次性原型的名字/路径一眼看出是原型（`prototype-` 前缀、
   `prototype/*` 分支、`.impeccable/mocks/` 目录）——这条与技能通用规则 1 相同。
4. **一条命令可跑**：画廊 = `pnpm gallery`（127.0.0.1:65310）；应用 = `pnpm dev`（3777）。
   体检 = `pnpm canon:check`（与 `verify` 同一份断言，可单独跑）。
   画廊与 dev server 的生命周期见记忆/收工清单：画廊可重启，dev server 不要停（冒烟与 C18 心跳靠它）。

## 收工（技能第 6 条在本仓的形态）

一次性原型答完题后三步，缺一步就是"决定凭空出现"：

1. **决定折回真代码**：验证过的判断写进 `src/`，以及该在的地方——
   设计判断进 `DESIGN.md` / canon-spec，架构判断进 `docs/adr/`，行为判断进规格与测试。
2. **原型留档**：提交到 `prototype/<用途>-<日期>` 分支；静态 HTML 若属于已答完的整页
   原型，也可以进 `.impeccable/mocks/`（那是画廊语义，不是"丢弃"语义）。
3. **指针**：在对应工单（Paca）或 ADR 上留一行「原型 → 决定 → 实现」的互指——
   样板是 MATT-98 的「指针闭环补记」评论与 canon-spec 头部那段。
   **主分支只留验证过的决定**；契约源是唯一例外（见豁免条款）。

---

**语言**：本目录统一中文（裁定见 `docs/implementation-plan-v1.md` §3）。

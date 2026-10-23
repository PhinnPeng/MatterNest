# 研究：把现有静态原型体系「规范化」的可行性（Level 1）

> **本文是调研快照，不是施工方案。** 形态要人拍 —— 见文末「要人拍的三点」。
> 调研日期 2026-10-20。本地事实全部**当场从文件算出**，外部工具结论全部**取一手来源**
> （GitHub 仓库状态页 / 官方站），不是搜索摘要。
>
> **调研过程中已落地的修复**（因为它们是明确的缺陷、不涉及形态选择）：
> 两个「门禁」脚本补了退出码与三方一致性断言、接进 `pnpm verify`、并放行入库。
> 详见 §2.4.1–2.4.3。下面第 9 行的「1.5–2 天」指的是**原 Level 1 四项**，
> 那部分**一行都还没动**。

## 一句话结论

**Level 1 可做，但「1 天」这个预估站不住，原四项实际 1.5–2 天**；而且**唯一有真实收益的那一项（清单一致性门禁）与另外三项必须分开做**。

更关键的判断：**Level 1 里真正值得做的只有一项**。索引自动生成解决的是一个**当前并不存在**的问题（三方的文件集合已经一致，见 §2.1），per-page 元数据与画廊瘦身属于「看起来规范、实际没有消费者」。把一天花在这三样上，是把工程预算换成本仓最忌讳的那种东西 —— 走到位了，但没有人在看。

**而真正该做的事，比 Level 1 原计划更基础**：那三个被文档称作「门禁」的脚本，
失败时**退出码是 0**、并且**从未入库**（§2.4.1、§2.4.2）。这条已修（§2.4.3）。

## 二、本地一手事实

### 2.1 三方的文件集合：一致

| 口径 | 数量 | 说明 |
| --- | --- | --- |
| `pages/*.html` 浅色页（去掉 `index` / `direction` 两个壳） | **31** | `ls` 实算 |
| `pages/*-dark.html` 深色副本 | **31** | `canon-dark.mjs` 生成，一比一 |
| `index.html` 里链接的浅色页 | **31** | 正则抽 `href`，去重后实算 |
| `canon-spec.md` 里出现的 `.html` 文件名 | **31** | 全量 `\`xxx.html\`` 扫 |

**四路独立口径，集合完全相同，零缺失、零多余。** 这一条直接推翻了「三方会漂移、所以要自动生成索引」这个立项理由 ——
漂移确实存在，但**不是缺页**，而是编号与名称（见 2.2）。索引自动生成修不了那个。

### 2.2 漂移的真实形态：编号与名称

| 项 | 数量 | 举例 |
| --- | --- | --- |
| 同一文件在 canon-spec 与 index 的**编号**不同 | **13 / 31** | `archive.html`：spec `09` / index `13` |
| 同一文件在两侧的**名称**不同 | **5 / 31** | `matter-create.html`：spec「新建案件（弹层）」/ index「新建案件」 |
| canon-spec 的 `###` 标题条数 | **16** | 因为有一节 `### 13–26 功能配置细项页（14 页）` 打包了 14 页 |
| 因此「解析 `###` 标题得到页数」 | **得 16，不是 31** | 解析器必须额外处理区间写法 + 正文列表 |

编号分岔的根因是两套排序哲学：canon-spec 按**业务流程**排（案件 → 事项 → 当事人 → 归档 → 配置 → 登录 → 弹层），
index 按**界面形态**排（概要 / 业务 / 系统 / 配置细则 / 独立壳），并把四个弹层提到业务组里。
两者都不是错的 —— 错的是**存在两个编号**。

### 2.3 canon-spec 的可解析性：能解析，但不能「只解析」

`### NN \`file.html\` — 名称` 这个格式在 16 处是稳定的，但：

- 「13–26」把 14 页塞进一个标题，页名在正文的无序列表里（`- \`config-xxx.html\` 名称`）—— **需要两套解析逻辑**；
- `workbench.html` **不在页面清单里**（它只作为「骨架模板」被第 22 行和第 82 行提到），
  所以「从清单推导全部页」会**漏掉 01 号页**；
- `index.html` / `direction.html` 同样不在清单里（它们在头部第 7、10 行被提到，不在 `## 页面清单` 下）。

⇒ **纯解析方案（parser-first）会得到一个 30 页的清单（漏 workbench）或一个 31 页但编号为 16 条的清单。**
这不是解析器写得糙，是 canon-spec 的散文形态本身不承担机器可读契约。**这一条是下面架构推荐的决定性依据。**

### 2.4 已有门禁覆盖了什么

`agent-work/canon-check.mjs` 已经断言：

| 断言 | 状态 |
| --- | --- |
| 每页引 `canon.css` | ✅ 已覆盖 |
| 无 `<script>` | ✅ |
| 无外部 http 链接 | ✅ |
| 无 `<img>` / `url(` / `@import` | ✅ |
| 无旧世界残留（`cinnabar` / `world.css` / `--paper` / `--jibiao`） | ✅ |
| 非登录页有 `nav` 与 `topbar` 骨架 | ✅ |
| 有表或卡 | ✅ |
| 深色副本存在 | ✅ |
| **index 覆盖全部页** | ❌ **未覆盖** |
| **canon-spec 编号与 index 一致** | ❌ **未覆盖** |
| **canon-spec 清单覆盖全部页** | ❌ **未覆盖**（它漏了 workbench） |

同时 `agent-work/_chk/check-headings.mjs`（标题层级断层）也**未被调用**。

### 2.4.1 ⚠ 实测：这两个脚本的退出码不「说话」

这是本次调研里最重要的一条发现，因为它**直接决定「断言优先」方案能不能落地**。

我造了一个必然不合格的页面（`bad.html`：无 `canon.css`、含 `<script>`、无 nav、无顶栏、无表无卡、无深色副本），
在一个临时目录里跑 `canon-check.mjs`：

```
✗ bad.html — 缺 canon.css；含 <script>；缺导航骨架；缺顶栏；既无表也无卡；缺深色副本
共 1 页有问题
真退出码=0
```

**六个问题全部正确报出，退出码却是 0。** 源码 `grep process.exit` 三个脚本（含 `contrast-all.mjs`）**一处都没有**。

⇒ 它们**只能给人看，不能给机器看**。这就是为什么 `prototype-guidelines.md` 在文档里把它们写成「门禁」，
而 `.github/workflows/ci.yml` 与 `package.json` 里一个都搜不到 —— 接上去会得到一个**永远绿**的判据，
那比没有判据更糟（本仓最忌讳的静默）。

**所以「断言优先」方案的第一个动作不是写新断言，而是给这两个脚本补 `process.exitCode`。** 这一行改动，
加上接线，才是 Level 1 真正该做的事；其余三项（生成器 / 元数据 / 瘦身）都排在它后面。

⇒ **真正缺的不是「自动生成索引」，而是一条把已有三方接起来的一致性断言。** 这个差别决定了工作量：
写一个 40 行的比对脚本（读 `readdir` + 抽 `index` 链接 + 抽 spec 文件名）比写一个索引生成器
（还要处理分组、描述文案、编号排序）**便宜得多，且不会引入「生成物要不要入库」这个新问题**。

### 2.4.2 ⚠ 第二个发现：这些脚本**从未入库**

`agent-work/` 是**白名单制忽略**（`.gitignore` 第 47–49 行：`agent-work/` + `agent-work/*`，只有
`!agent-work/smoke-*.mjs` 等逐条放行）。`git check-ignore` 实测：

```
.gitignore:49:agent-work/*    agent-work/canon-check.mjs
.gitignore:49:agent-work/*    agent-work/_chk/check-headings.mjs
```

两个「门禁」脚本**都不在版本控制里**。这意味着：把它们接进 `pnpm verify` 而不放行，
等于给每一次**别人的 clone** 埋一个「本地全绿、CI 立刻红」。

`tools/lint-guard/judge-portability.mjs` 第 ② 条只检查**相对 import 的目标**是否入库，
**不看 `package.json` 的 scripts** —— 所以这条守卫拦不住「verify 引用了一个被忽略的文件」。
这是它当前的覆盖缺口，已在本次接线时手工补上白名单（`!agent-work/canon-check.mjs`）。

### 2.4.3 已做的修复（本次调研的副产物）

| 改动 | 文件 | 验证 |
| --- | --- | --- |
| 补 `process.exitCode` | `canon-check.mjs`、`_chk/check-headings.mjs` | 注入失败页 → 退出码 1（实测） |
| 加三方清单一致性断言 | 同上两个脚本 | 删 `index.html` 的 `users` 链接 → 两处都报 `✗ 清单不一致`、退出码 1（实测） |
| 接进验收入口 | `package.json`：新增 `canon:check`，插入 `verify` 链（`anchors:check` 之后） | `pnpm canon:check` 绿；`pnpm` 层也正确传递退出码 1 |
| 白名单放行 | `.gitignore`：`!agent-work/canon-check.mjs` | `git check-ignore` 不再命中 |
| 反向红后恢复 | `index.html`、`canon-spec.md`、`users.html` | 从备份还原，重跑绿（31 页一致、无 `.bak` 残留） |

**三态都验过**（这一点比只做反向红更要紧）：

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 全部合格 | 退出 0 | ✅ 两者都 0 |
| 删 `index.html` 里的 `users` 链接 | 退出 1 + 报清单不一致 | ✅ 两者都 1 |
| 把 `users.html` 的 `h2` 改成 `h3`（h1→h3 断层） | 退出 1 + 报断层 | ✅ `check-headings` = 1 |

⚠ 写这一版时我真踩了一次：把清单检查的**返回值 0** 推进了 `bad` 数组，
于是**全绿也退出 1**（数组 `length` 是 1）。只做反向红发现不了它 —— **还需要「全绿必须退出 0」这一向**。
判据两侧都要验，否则「永远红」和「永远绿」一样没用。

⚠ 仍未接线：`_chk/check-headings.mjs` 与 `_chk/contrast-all.mjs`。
前者已在本次补了退出码与一致性断言（三态验过），但**仍不在 `verify` 里**；后者需要真浏览器，成本另计。
是否把 `check-headings` 一并接进 `verify` 属于要人拍的事项（见文末）。

`decision/payload.json` 已经是一个机器可读的 manifest（`title` / `question` / `options[8]` / `reroll` / `canon` / `steer`），
包含 `html` 字段指向候选页。**但 `direction.html` 并不读它**（`grep 'payload.json\|fetch('` = 0 命中）——
也就是说，本仓已经**造过一次 manifest 而没有消费者**。这是对「再引入一个 manifest」最直接的警告。

### 2.5 已有的 manifest 先例

`decision/payload.json` 已经是一个机器可读的 manifest（`title` / `question` / `options[8]` / `reroll` / `canon` / `steer`），
包含 `html` 字段指向候选页。**但 `direction.html` 并不读它**（`grep 'payload.json\|fetch('` = 0 命中）——
也就是说，本仓已经**造过一次 manifest 而没有消费者**。这是对「再引入一个 manifest」最直接的警告。

### 2.6 原型是入库的，且被 `pnpm verify` 间接依赖

| 事实 | 值 |
| --- | --- |
| `.impeccable/mocks/pages` 被 git 跟踪的文件数 | **66**（31 浅 + 31 深 + `canon.css` + `index.html` + `direction.html` + `world.css`） |
| `canon-spec.md` 入库 | 是 |
| `canon.css` 被谁读 | `src/app/theme/brand.spec.ts`（`pnpm verify` 的单测）**逐值断言 26 个颜色键 + 形状令牌** |
| `.impeccable/` 在 `.prettierignore` | 是（因为 `questions/.gitignore` 内容是一个 `*`，prettier 无 parser ⇒ `format:check` 硬错，会挡下所有人提交 —— MATT-94 现场） |

⇒ 任何「把原型搬去一次性分支」的方案**在开工前就已经被否掉**：它会让 `brand.spec.ts` 无从读文件，
`pnpm verify` 直接红。这条已在 `.trellis/spec/frontend/prototype-guidelines.md` 的豁免条款里写明。

### 2.7 画廊服务的现状

`agent-work/gallery-server.mjs`（`pnpm gallery`）已经把职责收得很小：

- 2 个挂载点（`/decision/` → `decision/`，`/` → `pages/`）；
- 只服务 4 种 MIME（html/css/png/svg）；
- 路径穿越已挡（`path.normalize` + `startsWith(root + sep)`）；
- **无写接口、无动态生成、无模板引擎** —— 纯 `readFile` 直出。

⇒ 「缩小画廊服务的职责」这一项**没有可缩的余量**。它现在就是 58 行、单一职责。再缩只剩删掉它，
而那会让局域网过目（用户明确用过的场景，65310）失效。**这一项应从 Level 1 里划掉。**

### 2.8 浏览器与 CI 的可行性（若要上视觉回归）

| 事实 | 值 |
| --- | --- |
| `playwright` 在 devDependencies | **1.64.1** |
| 是否会自动装浏览器 | **否**（`scripts: undefined`，无 `postinstall`） |
| CI 是否显式装 | **是**，`pnpm exec playwright install --with-deps chromium`（ci.yml 第 116–117 行） |
| 现有视觉判据 | `agent-work/smoke-visual.mjs`（**跑真页**，13 条路由 × 明暗两版） |
| 原型侧是否有视觉判据 | **无**（`_chk/contrast-all.mjs` 未接入脚本） |

⇒ **本地与 CI 都能起 chromium**，技术上 BackstopJS 可跑。但注意：`smoke-visual` 已经覆盖**真页**；
再给原型加一层像素回归，是在**两个都会变的东西之间比像素**（原型会被人改、canon.css 会改令牌），
基线维护成本远高于收益。

## 三、外部工具一手事实

| 工具 | 一手来源 | 结论 | 对本仓是否可用 |
| --- | --- | --- | --- |
| **Pattern Lab** | `patternlab.io` 首页 + `github.com/pattern-lab/patternlab-node` 顶部横幅 | **已归档**：仓库 2026-05-13 被 owner 归档，只读；官方横幅写明「no longer actively maintained …… no new releases, security patches, or issue triage」 | ❌ **不可选**（无安全补丁） |
| **Fractal** | `github.com/frctl/fractal/issues/1167` | **无维护者**：issue 标题即「status of project & looking for maintainers!」 | ❌ 不可选 |
| **Storybook** | `storybook.js.org/docs/api/new-frameworks` + `storybookjs/storybook` discussion #32781 | 官方支持 HTML /「no framework」模板；但它要求把 UI 写成 **stories**（组件级 `.stories.js`），而不是服务任意静态 HTML 目录 | ❌ 与现有形态错配：31 页是**整页 HTML**，不是可枚举组件 |
| **BackstopJS** | `github.com/garris/BackstopJS` README | 支持 `backstop.json` 的 `scenarios[].url`，可指向本地静态文件；参考图本地产出 | ⚠ 技术可用，但见 2.8 的基线成本判断 |
| 成熟「manifest 驱动静态画廊生成器」 | `jamstack.org/generators/`、`awesome-static-generators` | 列表里的都是**整站生成器**（吃 Markdown/数据出站点），没有一个是为「已有 HTML 目录 + 只生成索引页」设计的 | ❌ 不存在可白捡的轮子；自写 40–60 行更省 |

**这张表的结论**：外部没有现成方案能替换本仓的形态，且生命周期最长的两个（Pattern Lab / Fractal）都已停摆。
「引入一个原型平台」在本仓**不可行**，这不是偏好问题。

## 四、Level 1 四项逐项裁定

| 项 | 值不值得做 | 理由 |
| --- | --- | --- |
| **⓪ 修退出码 + 接线** | **做，且排第一** | 三个「门禁」脚本失败仍退出 0（2.4.1 实测）。不修，任何接线都是假绿 |
| **① 索引自动生成** | **换成一致性校验** | 文件集合已一致（2.1），真正的病是编号/名称分岔（2.2）。生成器治不了病，还带来「生成物入库 or 不入库」的新问题 |
| **② per-page 元数据** | **不做** | 没有消费者。`payload.json` 就是前车之鉴（2.5）。除非将来要给每页做「实现状态」标记，否则是纯粹的装饰 |
| **③ 三方漂移检查** | **做了** | 把 2.4 表里三个 ❌ 补上（§2.4.3）。这是唯一真收益，40 行，已接进 `pnpm verify` |
| **④ 画廊服务瘦身** | **划掉** | 已瘦到 58 行纯 `readFile`（2.7），没有余量 |

## 五、推荐架构：断言优先，不引入 manifest

### 为什么不是 manifest-first

manifest-first 要求「先有一份机器可读的页目录，index 与 spec 都从它生成」。问题在于：

1. 它会变成**第四份**页清单（现在是 canon-spec / index.html / 目录本身三份），漂移面从 3 变 4；
2. `payload.json` 已经证明本仓会造出没有消费者的 manifest（2.5）；
3. 生成 index 会触发「生成物要不要入库」——不入库则新克隆没有 index（而 `.gitignore` 的白名单先例就是为了避免悬空），入库则每次改页都要记得重跑生成器，**又多一条纪律**。

### 为什么是 assertions-first

三份清单**已经都在**，且集合一致。缺的只是一条把它们钉在一起的断言：

```
读 pages/*.html（去 index/direction/-dark）        → 集合 A（31）
抽 index.html 的 href（去 /direction.html、去 -dark）→ 集合 B（31）
抽 canon-spec.md 的文件名引用                        → 集合 C（31）

断言 A == B == C（少一个、多一个都红）
断言 每页都有 -dark 副本（canon-check 已有，去重）
```

**这条已经落地了**（§2.4.3），所以它不再是「建议」，而是既成事实：
`pnpm canon:check` 在 `verify` 链上，失败时退出码 1。

这是 Level 1 里**唯一**值得拿工程预算的事 —— 而它已经做完。

## 六、成本修订

| 方案 | 原估 | 修订 | 依据 |
| --- | --- | --- | --- |
| 索引自动生成 + 元数据 + 漂移检查 + 瘦身 | 1 天 | **1.5–2 天** | 索引生成器要处理分组/描述/编号排序 + 生成物归属决策；元数据要设计 schema；瘦身无余量但仍需评估 |
| **断言优先（推荐）** | — | **3–4 小时（已完成约 1.5 小时）** | 两个脚本各加一行退出码（含反向红）+ 约 40 行三方比对 + 接进 `verify` + 反向红验证 |

原「1 天」低估的原因有两层：一是把「写一个生成器」想成了「写一个循环」，实际成本在**决策**
（生成物入库吗、编号以谁为准、分组谁来定），不在代码；二是**没人知道现有三个「门禁」脚本失败仍退 0、
且从未入库**（§2.4.1、§2.4.2）—— 这部分返工是原估算里根本不存在的项。

## 七、风险

1. **反向红必须做**：断言写完后，要故意删掉 index 里的一个链接、确认它红；再恢复。
   本仓有过「判定对 ≠ 接线对」的实测（单测全绿但调用点接错），所以还要确认 `pnpm verify` **真的调到了**它。
   —— 本次已按此做过（§2.4.3 表末行）。
2. ~~`canon-check.mjs` 目前没有任何自动调用点~~ **已修**：已接进 `verify` 并放行入库（§2.4.3）。
   仍遗留两根：`_chk/check-headings.mjs`（有退出码与一致性断言，但未接进 `verify`）
   与 `_chk/contrast-all.mjs`（需真浏览器，成本另计）。
   ⚠ `prototype-guidelines.md` 第 16、37 行把它们三者都写成「门禁」，
   现状与文档仍有落差 —— 要么接线，要么改文档口径。
3. **`judge-portability` 有个覆盖缺口**：第 ② 条只查**相对 import 的目标**是否入库，
   **不查 `package.json` scripts 引用的路径**。本次「`canon-check` 未入库却被写进 verify」
   正是从这个缺口漏过去的，只能靠人发现。补它是一条独立的守卫改动（建议做，但不在本文范围）。
4. **不要顺手改 index 的编号**：那是 §2.2 的既存事实，改它会产生 31 行的 diff，
   与「加断言」混在一起就看不清哪个改动导致了什么。
5. **新增脚本落点**：`agent-work/` 是白名单制（已被 prettier 忽略，不参与格式检查），
   落在那儿必须同步加 `!` 放行，否则门禁悬空；落在 `tools/` 则要过 prettier 与 lint。

## 八、要人拍的三点

1. **原 Level 1 剩下的三项做不做？** 我推荐**都不做**：生成器治不了真实病症（文件集合已一致）、
   元数据没有消费者、画廊服务没有可缩的余量。若只想要「加页不漏挂」，那条断言已经落地了。
2. **编号分岔要不要顺手对齐？** 建议**不动**（见风险 4），另开一次纯文档对齐（约 20 分钟、31 行 diff）。
3. **`check-headings` 要不要也接进 `verify`？要不要给原型加视觉回归（BackstopJS）？**
   前者我倾向**接**（零依赖、已能正确退码）；后者我判断**不加** —— `smoke-visual` 已在量真页，
   而原型像素基线会在每次设计迭代时全红。若将来要做，先明确「基线多久重录一次」。

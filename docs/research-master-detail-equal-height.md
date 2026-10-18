# 主从布局（master-detail）左右等高做法 · 研究笔记

> 项目：MatterNest 原型阶段（纯 HTML + 单文件 canon.css，禁止 JS，`:target`/`:has()` 交互）。
> 画布 1440px，左栏 264px，右栏 `minmax(0,1fr)`；左栏固定 365px（1 卡头 + 5 行），右栏随选中角色在 305px（有特权）/347px（无特权）之间跳动（相差 42px）。
> 本文把「文档说法」与「实测验证」严格分开标注；未实测的只标来源级别。

## 0. 问题陈述与实测数据

### 0.1 约束（硬性）

- 纯静态 HTML + 单个 CSS 文件 `canon.css`，**禁止 JavaScript**；所有交互仅 CSS（`:target`、`:has()`）。
- 画布固定 1440px；`grid-template-columns: 264px minmax(0,1fr)`；gap 16px。
- 左栏固定 365px；右栏内容两档：有特权角色 305px，无特权角色 347px（差 42px）。
- 无行内样式（除一次性布局）、密度优先、颜色不作唯一通道。
- 目标态 Next.js + React + antd 6，但原型阶段必须只有 HTML/CSS。

### 0.2 项目现状（实测）

`agent-work/_chk/probe-roles-height.mjs` 对真实 `roles.html` 的实测（Chromium，viewport 1440×900）：

```
.master : w=1176 h=365
left    : w=264  h=365
right   : w=896  h=305（full_admin 默认选中）
高差    : -60 px（右 - 左）  ← 右栏比左栏矮 60px，底部悬空
```

五角色切换时的 pane 高度分布：

| 选中角色 | pane 高 | 左栏高 | 差（右-左） |
|---|---|---|---|
| 全局管理 (full_admin) | 305 | 365 | -60 |
| 系统管理 (sys_admin) | 305 | 365 | -60 |
| 全局经办 (full_operator) | 347 | 365 | -18 |
| 参与经办 (joined_operator) | 347 | 365 | -18 |
| 承办经办 (self_operator) | 347 | 365 | -18 |

根因：`canon.css:186` 的 `.master { display:grid; grid-template-columns:264px minmax(0,1fr); gap:16px; align-items:start }` 显式把对齐设为 `start`，关闭了 grid 默认的 `stretch`。右栏 wrapper 的高度就是内容高，左卡固定 365，故永远差一截。

---

## 1. 方案清单

### 方案 S1 · CSS Grid 默认 `align-items: stretch`（不做任何覆盖）

- **原理**：Grid 容器默认 `align-items: normal`，MDN 明确「`normal` 在 grid 容器里解析为 `stretch`」；stretch 会让 item 的 margin box 伸满 grid area 的块向尺寸。MDN Box Alignment 指南："omitting `align-items` completely … the height of each `<div>` stretches to fill its grid area"。CSS Align 3 规范 §4.4（self-alignment stretch）："can grow *or shrink* the alignment subject to ensure it exactly fits the alignment container"（注意：self-stretch 可缩可涨，而 content-distribution 的 stretch 只涨）。
- **代码**（最小复现）：
  ```css
  .master { display: grid; grid-template-columns: 264px minmax(0,1fr); gap: 16px; }
  /* 不写 align-items，让默认 stretch 生效 */
  ```
- **支持度**：Baseline widely available，Chrome/Firefox/Safari/Edge 全支持（MDN `align-items` Baseline Widely available）。
- **在「右栏高度变化」时的行为**（实测 R1）：master 高永远 = max(左 365, 右内容)；右栏 wrapper 被拉伸到 master 高，但 wrapper **内部**的 `.card` 仍保持内容高（card 底与 wrapper 底差 18/60px）。视觉上 master 两栏等高，但右栏末张卡片底与左卡底不对齐，底部空隙落在 wrapper 里，用户看到的是「右栏整块等高但卡片之间有空」。若把右栏 wrapper 设成 flex column + 末卡 `flex:1`，可把空隙吃进末卡（见方案 S1+）。
- **失败模式**：
  1. 子项有内在宽高比（图片/视频）时 `normal` 解析为 `start` 而非 `stretch`（MDN "Items with an intrinsic aspect ratio"）——本项目无此情形。
  2. 子项设 `align-self: start/center/end` 或 `margin: auto` 会覆盖 stretch（MDN Box Alignment）。
  3. **stretch 只影响 grid item 本身**，item 内部的子元素不会自动等高——本项目右栏是 `.pane > .card*`，需要额外一跳 flex。
- **来源**：
  - MDN Box Alignment in Grid："The default value is `normal`, which resolves to `stretch` for grid containers"，"Keep in mind that once you set `align-items: start` … in contrast to omitting `align-items` completely, in which case the height of each `<div>` stretches to fill its grid area"（https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Grid_layout/Box_alignment）— **MDN 明确说明**。
  - CSS Align 3 §4.4 self-alignment stretch（https://drafts.csswg.org/css-align-3/#valdef-align-self-stretch）— **规范条文**。
  - **实测**：`probe-final.mjs` R1，5 角色下 master 高稳定 365、左卡 365、右 wrapper 365。

### 方案 S1+ · Grid stretch + 右栏 wrapper `display:flex; flex-direction:column` + 末卡 `flex:1`

- **原理**：在 S1 的基础上，把右栏 wrapper（`div:last-child`）变成 flex column，让 stretch 拉伸的 365 高度真正分配给末张卡片的 `flex:1`。本项目 `.pane` 的 `display` 被 `canon.css:203-208` 的 ID 特异性规则钉死（`.master:has(#p-xxx:target) #r-xxx { display:block }`），所以 flex 切换必须用同特异性或更高（或 `!important`）的规则。
- **代码**：
  ```css
  .master { display: grid; grid-template-columns: 264px minmax(0,1fr); gap: 16px; align-items: normal; }
  .master > div:last-child { display: flex; flex-direction: column; }
  .master:has(#p-full_admin:target) #r-full_admin,
  .master:has(#p-sys_admin:target) #r-sys_admin,
  .master:has(#p-full_operator:target) #r-full_operator,
  .master:has(#p-joined_operator:target) #r-joined_operator,
  .master:has(#p-self_operator:target) #r-self_operator {
    display: flex; flex-direction: column; flex: 1;
  }
  .master > div:last-child > .pane > .card { flex: 0 0 auto; }
  .master > div:last-child > .pane > .card:last-child { flex: 1 1 auto; }
  ```
- **支持度**：同 S1 + flexbox（widely available）；`:has()` Baseline Widely available since Dec 2023（MDN）。
- **在「右栏高度变化」时的行为**（实测 A/B）：5 个角色下 master=365、左卡=365、末卡底=365，**齐底✓**；切换 10 次 master 行高序列全为 365（不跳变）。
- **失败模式**：
  1. `.pane` 的 display 被 ID 特异性规则钉死，必须用同特异性覆盖（实测 debug3：`.pane.on{display:flex}` 无 `!important` 会被 ID 规则覆盖，display 仍为 block）。
  2. flex item 默认 `flex-shrink:1` 会压扁卡片（debug2：末卡 `flex:1` 但 `flex-shrink` 默认 1，卡片被压到 132/198 不变）——必须给末卡 `flex: 1 1 auto` 或 `flex: 1 0 auto`。
  3. 右栏 wrapper 里除 `.pane` 外若还有其他常驻元素，flex 分配会不同。
- **来源**：MDN flexbox "Aligning items"（https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Flexible_box_layout/Aligning_items）；**实测** `probe-final.mjs` / `probe-comprehensive.mjs` A/B。

### 方案 S2 · `grid-template-rows: 1fr`（显式行轨）

- **原理**：显式把 grid 的单行设为 `1fr`，让行轨高度 = 容器高度的 1fr。但 `fr` 单位在 grid 里等价于 `minmax(auto, 1fr)`（Rachel Andrew / noti.st slides："If the track is sized with fr units then it is as if we have used `minmax(auto, 1fr)`. So the minimum size is auto"）。因此 `1fr` 行轨的**最小尺寸是 auto**——内容 taller 时行轨会按内容涨，不会被压扁；内容更矮时行轨被拉到容器高。MDN `grid-auto-rows`："specifies the size of an implicitly-created grid row track"。
- **代码**：
  ```css
  .master { display: grid; grid-template-columns: 264px minmax(0,1fr); grid-template-rows: 1fr; gap: 16px; }
  ```
- **支持度**：widely available。
- **在「右栏高度变化」时的行为**（实测 V3）：master 高 = max(左内容, 右内容) = 379/421；左右两栏**等高**（stretch 默认没关），但行轨最低 auto，master 高会随右栏内容涨到 421（比左栏 365 高 56px）。视觉上两栏仍等高，但整块布局会"随内容跳"——5 角色切换时 master 高在 365/379/421 之间跳，页面下方内容会抖动。
- **失败模式**：
  1. **行高会跳**：`1fr` 行轨 = max(auto, 1fr)，右栏内容 taller 时整块 master 高度跟随涨（实测 V3：305→421）。
  2. 若同时设 `align-items: start`，stretch 失效，`1fr` 行轨只拉高容器、子项不跟（实测 V3b：left=439 right=379，不等高）——`1fr` 与 `align-items:start` 是冲突组合。
  3. `grid-auto-rows: 1fr` 只作用于**隐式**创建的行；本项目 `.master` 只有一行且是显式行（`grid-template-columns` 定义列、行是隐式），所以 `grid-auto-rows: 1fr` 理论上也应生效——但实测 V3b（`grid-auto-rows:1fr` + `align-items:start`）left=439 right=379，**不等高**，因为 align-items:start 关闭了 stretch，item 不跟行轨。结论：`grid-auto-rows` 不是等高的魔法，等高靠的是 stretch。
- **来源**：
  - MDN `grid-auto-rows`（https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/grid-auto-rows）— **MDN 明确说明**（仅描述属性，不保证等高）。
  - Rachel Andrew slides "Unlocking the Power of CSS Grid"（noti.st）："fr units … minmax(auto, 1fr) … minimum size is auto" — **知名工程博客有代码验证**。
  - **实测** V3/V3b。

### 方案 S3 · Flexbox `align-items: stretch`（row 方向）

- **原理**：flex 容器默认 `align-items: stretch`（MDN Basic concepts："initial value … stretch and is why flex items …"）；row 方向时 cross axis 是块向，flex items 被拉到行内最高 item 的高度。CSS Flexbox 1 §8.3："stretch: … if the cross size property of the flex item computes to auto … its used cross size is the flex line's cross size"。
- **代码**：
  ```css
  .master { display: flex; gap: 16px; align-items: stretch; }
  .master > :first-child { flex: 0 0 264px; }
  .master > :last-child { flex: 1 1 auto; min-width: 0; }
  ```
- **支持度**：widely available。
- **在「右栏高度变化」时的行为**（实测 V5）：左右两栏等高（master=439），但**宽度语义变了**：flex row 不再有 `minmax(0,1fr)` 的防溢出保证，右栏 `flex:1` 在内容过宽时可能溢出（需 `min-width:0`）；且 flex 没有 grid 的二维放置能力，后续布局（如 `.grid2`、`.split`）无法复用。实测 V5b 证明：一旦误用 `flex-direction: column`，cross axis 变成 inline 方向，align-items:stretch 会把**所有子项宽度拉满**（leftW=rightW=1418），完全破坏左窄右宽。
- **失败模式**：
  1. `flex-direction: column` + `align-items: stretch` 会让子项宽度被拉满（实测 V5b）——本项目明确左 264 / 右自适应，不能用。
  2. flex 单行里，若某 item 设 `align-self: start` 或 `margin: auto`，stretch 失效。
  3. flex 的 `min-height: auto`（默认）会让 flex item 不低于内容高——作为等高容器的子项没问题，但作为内部滚动容器时需要 `min-height:0`（MDN flex item min-height auto）。
- **来源**：
  - MDN Basic concepts of flexbox："align-items … initial value stretch"（https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Flexible_box_layout/Basic_concepts）— **MDN 明确说明**。
  - CSS Flexbox 1 §8.3 cross-axis alignment（https://www.w3.org/TR/css-flexbox-1/#align-items-property）— **规范条文**。
  - **实测** V5/V5b。

### 方案 S4 · 子项 `height: 100%`

- **原理**：让子项高度 = 父容器高度的 100%。CSS 2.1 §10.5："If the height of the containing block is not specified explicitly (i.e., it depends on content height) … the value computes to `auto`"（MDN height Formal definition Percentages 同文）。所以 **`height: 100%` 在隐式高度的父容器里会退化成 `auto`**（实测 V7：outer 无 height=140，child height:100% 实际 20px）。
- **代码**：
  ```css
  .master { display: grid; grid-template-columns: 264px minmax(0,1fr); gap: 16px; align-items: start; }
  .master > :first-child { height: 100%; }   /* 失效：父 .master 高度是内容派生 */
  ```
- **支持度**：语法层面全支持，但**语义上在本场景必然失效**。
- **在「右栏高度变化」时的行为**（实测 V4）：左栏 height:100% 被解析为 auto → 左栏高度 = 内容高 365（ coincidentally 与期望一致，但不是因为 100% 生效）；右栏内容 305 时 master 高 = 365（左栏内容），右栏 wrapper 305，**不等高**。V4b（stretch + height:100%）左右等高，但那是 stretch 在起作用，height:100% 是冗余且无害的。
- **失败模式**：
  1. **核心失败**：父 `.master` 的高度由内容派生（无显式 height），`height:100%` 解析为 `auto`（MDN height Formal definition）。
  2. 即使父有高度，`height:100%` 也不含 gap/border/padding，容易溢出（MDN box-sizing）。
  3. 与 `align-items: stretch` 叠加时冗余；与 `align-items: start` 叠加时无效。
- **来源**：
  - MDN `height` Formal definition Percentages："If the height of the containing block is not specified explicitly … the value computes to `auto`"（https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/height）— **MDN 明确说明**。
  - CSS 2.1 §10.5（https://www.w3.org/TR/CSS2/visudet.html）— **规范条文**。
  - 456bereastreet "Height in percent when parent has min-height and no height"（https://www.456bereastreet.com/archive/201306/height_in_percent_when_parent_has_min-height_and_no_height/）— **知名工程博客**。
  - **实测** V4/V4b/V7。

### 方案 S5 · `min-height` vs `height`

- **原理**：`min-height` 设置下限，`height` 设置精确值；`min-height` 会覆盖 `height`（MDN height："The `min-height` and `max-height` properties override `height`"）。在等高场景：
  - 用 `height: 100%`：要求父有显式高度，否则失效（S4）。
  - 用 `min-height: 100%`：同样要求父有显式高度（百分比 min-height 的 containing block 高度规则与 height 相同，MDN min-height Formal definition Percentages）。
  - 用 `min-height: 0`：flex/grid item 的自动最小尺寸默认是内容高（flexbox `min-height: auto`），设 `min-height:0` 允许 item 被压到 0，是内部滚动容器的必备（MDN flex item min-height auto）。
- **取舍结论**（文档 + 实测）：
  - **等高容器的外层**：不用 `height`/`min-height` 百分比，靠 stretch 自然等高（S1）。
  - **等高容器内部要做滚动**：内层元素设 `min-height:0; overflow:auto`，否则 flex/grid item 的 auto min-size 会阻止收缩（MDN）。
  - **固定像素高度**（如本项目左栏 365）：用 `min-height` 而非 `height`，避免内容溢出时被裁剪（MDN Accessibility："Ensure that elements set with a `height` aren't truncated"）；但本项目左栏内容固定（1 卡头 + 5 行），用精确 `height` 或 `min-height` 均可，推荐 `min-height` 以留弹性。
- **来源**：MDN `height`/`min-height` Formal definition；MDN flex item min-height auto。

---

## 2. 内容高度变化时，等高应锚定到哪一侧

### 2.1 三种可能

| 锚定策略 | 含义 | 本项目后果 |
|---|---|---|
| 左栏跟着右栏长 | master 高 = 右内容高；左栏被拉伸 | 左栏 365 被拉到 305/347 → 左栏被压扁，5 行选项被截断/滚动，破坏密度 |
| 右栏跟着左栏长 | master 高 = 左栏 365；右栏被拉伸 | 右栏 wrapper 拉到 365，空隙吃进末卡 → **本项目采用** |
| 取两者最大值 | master 高 = max(365, 右内容) = 365（因为右内容永远 < 365） | 与"右栏跟着左栏长"在本项目等价；但语义上是"谁 taller 谁定" |

### 2.2 业界惯例（后台管理 master-detail）

- **Ant Design Layout**：Sider + Content 是 flex row，Sider 默认 `height: 100%` 相对 Layout（Layout 高度由内容决定或 viewport）；Content 高度 = 内容高，Sider 跟随 Content（"Sider filling whole available height" StackOverflow 47361608）。当 Content 比 Sider 长时，Sider 被拉到 Content 高；当 Sider 比 Content 长时，Layout 被 Sider 撑高，Content 反而被拉。**结论：Ant Design 也是"取 max，谁 taller 谁定"**（Layout 高 = max(Sider, Content)）。
- **常见后台模板**（AdminLTE、CoreUI 等）：左导航 sticky/fixed + 右内容自然高，**不做等高**——因为左栏是导航（固定项），右栏是主内容（可很长），等高没有意义，反而让左栏出现大段空白。
- **本项目**：左栏是"选项列表"（固定 5 项，365 高），右栏是"选中项详情"（305/347 高），两者都**短**且左栏更长 → "右栏跟着左栏长 / 取 max" 是唯一合理选择；"左栏跟着右栏长"会让左栏被压扁。

### 2.3 推荐锚定

**锚定到左栏（左栏 365 为下限，右栏 wrapper 被拉伸到 365，空隙吃进末卡）**。理由：
1. 左栏内容固定、高度稳定（365），是天然的"标尺"。
2. 右栏内容永远比左栏矮（305/347 < 365），所以"取 max"与"右栏跟着左栏"等价，且不会抖动。
3. 若未来右栏内容超过 365（例如加入时间线/表格），max 语义会让 master 自然涨高，左栏被 stretch 跟涨——这是期望行为，不需要改代码。

---

## 3. `position: sticky` 与等高的交互

### 3.1 sticky 的定义（MDN）

> "stickily positioned element is treated as relatively positioned until its containing block crosses a specified threshold … at which point it is treated as 'stuck' until meeting the opposite edge of its containing block."

关键约束：**sticky 元素的 containing block 是它的最近块级祖先**（不是视口）；sticky 只在 containing block 内部"粘"，离开 containing block 就松手。因此**containing block 必须比 sticky 元素高**，否则没有滚动空间，sticky 退化为 relative。

### 3.2 冲突情形（实测 `probe-sticky.mjs`）

| 容器对齐 | 左栏高度 | sticky 是否工作 |
|---|---|---|
| `align-items: start`（左栏自然高 365） | 365（< 容器 1200） | ✓ 滚动到 700 后 top=0 |
| `align-items: normal`（stretch，左栏被拉到 1200） | 1200（= 容器） | ✗ 滚动后 top=-340，sticky 失效（containing block 与元素等高，无位移空间） |
| `align-items: normal` + `align-self: start` | 365 | ✓ 工作 |
| `align-items: start` + `height: 100%` | 1200 | ✗ 失效（height:100% 把左栏拉满） |

**具体冲突**：`align-items: stretch`（或 `height:100%`）把 sticky 元素拉到 containing block 的高度 → containing block 不再比元素高 → sticky 失去滚动空间 → 退化为 relative，元素随页面滚动离开视口。**解法**：sticky 元素必须 `align-self: start`（或容器 `align-items: start`），保证元素高度 < 容器高度。

### 3.3 本项目要不要 sticky？

**原型阶段：不使用 sticky**。理由：
1. 本项目画布是固定 1440px 的"页面"，不是长滚动页；左栏 365 高，视口 1000 高，左栏完全在首屏，sticky 无意义。
2. 等高（stretch）与 sticky 互斥；若未来要做"左栏 sticky + 右栏长内容"，必须放弃等高，改为 `align-self: start` + 右栏自然高（常见后台模式）。
3. 本项目纪律"密度优先"，左栏固定 365 已经是密度最优，sticky 只会增加空白。

---

## 4. 纯 CSS + 动态内容（`:target` 切换）的坑

### 4.1 `1fr` 行高在内容变化时会不会跳

**会跳**（实测 V3：右栏 305→421 时 master 高 379→421）。原因是 `fr` = `minmax(auto, 1fr)`，auto 下限让行轨随内容涨。本项目若用 `grid-template-rows:1fr`，5 角色切换时 master 高会在 365/379/421 间跳动，页面抖动。**本项目应避免 `1fr` 行轨，靠 stretch + 固定左栏 365 即可**。

### 4.2 `:has()` 的兼容性与性能

- **兼容性**：Baseline Widely available since Dec 2023（MDN `:has()`）；Chrome/Edge 105+、Firefox 121+、Safari 15.4+。本项目原型在现代浏览器验证，无 IE 需求，可用。**（一手来源：MDN `:has()` 页面 "Baseline Widely available … since December 2023"）**
- **性能**（MDN Performance considerations）：
  - `:has()` 在 DOM 变化时需重新评估；本项目用 `.master:has(#p-xxx:target)` 形式，anchor 是 `.master`（只有 2 个子项），inner selector 用 ID + `:target`（ tightly constrained），性能开销可接受。
  - 避免把 `:has()` 锚定到 `body`/`:root`/`*`——本项目未这么做。
  - `:has()` 不能嵌套 `:has()`，且 pseudo-element 不能作为 anchor/inner selector——本项目未用。
- **一个隐藏坑**：`:has()` 选择器的特异性等于其参数中最具体的那个（MDN："takes on the specificity of the most specific selector in its arguments"）。本项目 `.master:has(#p-full_admin:target) #r-full_admin` 的特异性 = ID 选择器级别，因此覆盖 `.pane.on { display:block }` 时必须用同特异性或更高（实测 debug3）。

### 4.3 其他坑

1. **`.pane` 的 display 被 ID 规则钉死**（canon.css:203-208），flex 切换必须同特异性覆盖，否则无效（实测 debug3）。
2. **flex item 默认 `flex-shrink:1` 压扁卡片**（debug2），必须显式 `flex: 0 0 auto` / `flex: 1 1 auto`。
3. **`align-items: stretch` 关闭后无法"半 stretch"**：一旦设 `align-items: start`，所有子项都不 stretch；想要某一项 stretch 必须用 `align-self: stretch` 单独开。
4. **gap 计入 master 高**：master 高 = max(子项) + gap？实测 master=365 = 左卡 365（gap 在 cross 轴不算入 item 高度，因为 grid gap 是 track 之间）——本项目 gap 16px 是列间距，不影响行高。确认：实测 R1 master=365 = 左卡 365。

---

## 5. 对本项目的推荐

### 5.1 选择

**采用「S1+」：CSS Grid 默认 stretch + 右栏 wrapper flex column + 末卡 flex:1 + 用 ID 特异性规则把 `.pane` 切成 flex 列**，并把 `.master` 的 `align-items: start` **删掉**（回默认 stretch）。

等价的最小改动（只动 canon.css）：

```css
/* canon.css:186 原：.master{...;align-items:start} */
.master { display: grid; grid-template-columns: 264px minmax(0,1fr); gap: 16px; }   /* 删 align-items:start */

/* 右栏 wrapper 变 flex 列 */
.master > div:last-child { display: flex; flex-direction: column; }

/* 与 canon.css:203-208 同特异性，把被选中的 pane 切成 flex 列并占满 */
.master:has(#p-full_admin:target) #r-full_admin,
.master:has(#p-sys_admin:target) #r-sys_admin,
.master:has(#p-full_operator:target) #r-full_operator,
.master:has(#p-joined_operator:target) #r-joined_operator,
.master:has(#p-self_operator:target) #r-self_operator {
  display: flex; flex-direction: column; flex: 1;
}
.master > div:last-child > .pane > .card { flex: 0 0 auto; }
.master > div:last-child > .pane > .card:last-child { flex: 1 1 auto; }
```

### 5.2 为什么这个选择

1. **左右真正等高**（实测 R3：5 角色下 master=365、左卡=365、末卡底=365，齐底✓）。
2. **切换不跳动**（实测 B：10 次切换 master 行高序列全 365）。
3. **不破坏左窄右宽**：grid 列轨 `264px minmax(0,1fr)` 不变，flex 只在右栏 wrapper 内部。
4. **不引入 JS**：仅 CSS，符合纪律。
5. ** densities 优先**：空隙吃进末卡（成员表/空态），而不是凭空留白；左栏仍 365。
6. **颜色不作唯一通道**：未动颜色。

### 5.3 为什么其他方案不行

| 方案 | 排除理由 |
|---|---|
| S1 纯默认 stretch（不加 flex wrapper） | master 两栏等高，但右栏末卡底与左卡底差 18/60px，空隙落在 wrapper 里，视觉上"卡片底部不对齐"（实测 R1） |
| S2 `grid-template-rows:1fr` | 行高随右栏内容跳（365→421），页面抖动；且与 `align-items:start` 冲突（实测 V3/V3b） |
| S3 Flexbox row | 能等高，但失去 grid 的 `minmax(0,1fr)` 防溢出与二维放置；`flex-direction:column` 会把宽度拉满（实测 V5b），极易误用 |
| S4 `height:100%` | 父 `.master` 高度内容派生，`height:100%` 解析为 `auto`，无效（实测 V4/V7） |
| sticky + 等高 | 互斥：stretch 把左栏拉满 → sticky 失去滚动空间（实测 probe-sticky）；本项目也不需要 sticky |
| `min-height:100%` | 同 S4，父无显式高度则失效 |

### 5.4 实施注意事项

1. **不要**在 `.master` 上加 `align-items: start`（当前就是这个 bug）。
2. **不要**用 `!important` 覆盖 `.pane` display（用同特异性 ID 规则，保持可维护性）。
3. 末卡 `flex: 1 1 auto` 必须带 `flex-basis: auto`，否则卡片被压扁。
4. 若未来右栏内容超过 365px（如加入长表格/时间线），master 会自然涨高，左栏被 stretch 跟涨——这是期望的 max 语义，无需改代码；但此时若想"左栏 sticky"，必须放弃等高（见 §3）。
5. 目标态 Next.js + antd：antd `Layout` 的 Sider/Content 同样是 flex row、取 max 高度（§2.2）；迁移时直接映射，无需重新设计。

---

## 来源分级说明

- **规范条文**：CSS Align 3 §4.4（stretch 可缩可涨）、CSS 2.1 §10.5（height 百分比）、CSS Flexbox 1 §8.3（cross-axis stretch）、Selectors Level 4 §relational（`:has()`）。
- **MDN 明确说明**：`align-items` 默认 normal→stretch、`:has()` Baseline 与性能、`height` Formal definition Percentages、`min-height`/`max-height` override、flex item min-height auto、position sticky containing block。
- **知名工程博客（有代码验证）**：Rachel Andrew slides（fr = minmax(auto,1fr)）、456bereastreet（百分比 height 失效）、MDN Performance considerations（`:has()`）。
- **仅示例代码**：MDN 各属性的 Try-it 示例。
- **实测验证**：本报告所有 "实测" 标注均来自 Playwright（Chromium，viewport 1440×900）对 `roles.html` 与自建 fixture 的测量，脚本位于 `agent-work/tmp-eh/`（`probe-*.mjs`）。未实测的结论（如 Ant Design 内部实现）仅标来源级别，未在本项目代码中验证。
- **二手转述/AI 博客**：未采信。

---

*生成日期：2026-10-17；画布/数据以 `.impeccable/mocks/pages/roles.html` 与 `canon.css` 为准。*

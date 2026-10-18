---
name: MatterNest
description: 企业内部诉讼案件与事项台账 —— 「标准写法」：品类默认的后台形态，做到无可挑剔。
colors:
  signal-blue: "#2563EB"
  signal-blue-wash: "#EFF4FF"
  signal-blue-edge: "#BFD3FA"
  ledger-ink: "#111827"
  ledger-secondary: "#4B5563"
  ledger-muted: "#6A717D"
  ledger-line: "#E5E7EB"
  ledger-line-soft: "#F0F1F3"
  control-line: "#90959D"
  switch-off: "#D7DBE0"
  tag-edge-green: "#A7E3C7"
  tag-edge-red: "#F3C2C2"
  tag-edge-amber: "#F2D6A8"
  paper: "#F5F6F8"
  surface: "#FFFFFF"
  surface-sunken: "#FAFBFC"
  surface-hover: "#F7F8FA"
  nav-ink: "#374151"
  nav-on-ink: "#1D4ED8"
  resolved-green: "#008053"
  due-amber: "#B55300"
  overdue-red: "#DC2626"
  night-paper: "#101317"
  night-surface: "#161A1F"
  night-surface-sunken: "#191D22"
  night-ink: "#E7E9EC"
  night-secondary: "#A6ADB6"
  night-muted: "#8B929C"
  night-line: "#232830"
  night-line-soft: "#1C2126"
  night-control-line: "#60666E"
  night-switch-off: "#3A4048"
  night-hover: "#1B2026"
  night-signal-blue: "#4087FB"
  night-signal-blue-wash: "#17233A"
  night-signal-blue-edge: "#2B4670"
  night-on-signal-blue: "#0B1220"
  night-nav-surface: "#12161A"
  night-nav-ink: "#C3C8CE"
  night-nav-selected-surface: "#1B2735"
  night-nav-on-ink: "#8AB4F8"
  night-resolved-green: "#34D399"
  night-due-amber: "#FBBF24"
  night-overdue-red: "#F87171"
typography:
  display:
    fontFamily: '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  page-title:
    fontFamily: '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  topbar-title:
    fontFamily: '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    fontSize: "15px"
    fontWeight: 600
  card-title:
    fontFamily: '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 600
  body:
    fontFamily: '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    fontSize: "12px"
    fontWeight: 400
  numeric:
    fontFamily: "Consolas, \"DejaVu Sans Mono\", ui-monospace, monospace"
    fontSize: "13px"
    fontFeature: "tnum"
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  pill: "10px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "20px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ledger-ink}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 13px"
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 13px"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.overdue-red}"
    rounded: "{rounded.md}"
    height: "32px"
  button-small:
    height: "28px"
    padding: "0 10px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ledger-ink}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 10px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ledger-ink}"
    rounded: "{rounded.md}"
    padding: "16px"
  modal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ledger-ink}"
    rounded: "{rounded.md}"
    width: "780px"
  nav-item:
    textColor: "{colors.nav-ink}"
    rounded: "{rounded.md}"
    height: "32px"
  nav-item-selected:
    backgroundColor: "{colors.signal-blue-wash}"
    textColor: "{colors.nav-on-ink}"
    rounded: "{rounded.md}"
    height: "32px"
---

# Design System: MatterNest

## Overview

**North Star: The Quiet Ledger.** 一本内部法务台账。它的价值不在被看见，而在被信任：期限不会漏、数字不会飘、每一行都能回溯。视觉的任务是**退到内容后面**。

这个系统的世界名是「标准写法」——品类默认的后台形态，做到无可挑剔，**不加任何世界材料**。它不是一套需要被识别的审美，而是另一类野心：在一张每天被看很多遍的表上，把密度、对齐、对比度、状态表达都做到没有可指摘处。判定任何提案的第一句话是「这句文案 / 这个色块，能不能删？」——删不掉才留。

三条气质上的取舍，与 PRODUCT.md 的「信任 / 专业」对应：

- **克制而非个性**：没有插图、没有品牌色块、没有装饰性渐变、没有自造图标语言。唯一的强调色只出现在三处（当前位置 / 主操作 / 焦点）。
- **密度即秩序**：读表的人不需要呼吸感，需要对齐。行高比通用后台更紧（表格行 40px、控件 30px），列宽有预算（合计 ≤1100 @1366）。
- **词比色可靠**：状态、到期、危险度永远「形状/色 + 词」双通道。颜色是加速扫读的辅助，从不独自承担一个事实。

**反向参考（明确的 anti-reference）**：数据看板式的「大数 + 彩色卡墙」（用色块面积冒充信息量）、以及任何需要用户先学一遍才能读懂的自造符号系统。

## Colors

一个强调色 + 三档墨色 + 三个语义色，全部收敛在 `canon.css` 的 `:root` / `body.dark` 两处。

**Signal Blue `#2563EB`** —— 系统中唯一的强调色，只出三处：

| 落点 | 用法 |
|---|---|
| 当前位置 | 左导航选中项（`--nav-on` 底 + `--nav-on-ink` 字）；表格当前页签下划线 |
| 主操作 | 每屏**至多一个**实心主按钮（`.btn.pri`），其余为描边按钮或链接按钮 |
| 焦点 | 键盘焦点环、当前输入框描边 |

表格内部**不接受强调色**。这一条是这个系统最容易被顺手破坏的规则：一旦某列的数字或某行的背景变成蓝色，"临期"与"逾期"就会被淹在装饰里。

**Ledger Greys** —— 三档墨色，分工是一个刻度而不是三种灰：

- `ledger-ink #111827`（17.7:1）正文、标题、需要读的数字
- `ledger-secondary #4B5563`（7.6:1）表头、金额、需读但不抢焦点的词
- `ledger-muted #6A717D`（4.9:1）时间戳、占位、`—`、分组名

⚠ **三档都必须过 WCAG AA 正文线 4.5:1**，因为最弱那档承载的是「—」（"这个字段没有值"是一个事实，不是装饰）。代价是刻度必须拉开——曾经 `secondary` 与 `muted` 都挤在 4.8 附近，视觉上缩成同一级。改动任何一档前先跑 `agent-work/_chk/token-contrast.mjs`。

**`ledger-line` 与 `control-line` 是两个刻度，不是一件事**：

| 令牌 | 浅色 | 深色 | 要求 | 用途 |
|---|---|---|---|---|
| `ledger-line` | `#E5E7EB` | `#232830` | — | 分隔线（对白底 1.24:1，本来就该若有若无） |
| `control-line` | `#90959D` | `#60666E` | **≥3:1**（WCAG 1.4.11） | 勾选框、开关等**交互控件的边界** |

曾经用同一个 `#C9CED6` 同时干这两件事，结果控件描边只有 1.58:1——边界看不清，勾选框在弱视或强光下等于没有。分成两个刻度后，「分隔线淡、控件边界清」各自成立。

**三个语义色**，各自只有一种含义：

| 令牌 | 浅色 | 深色 | 含义 |
|---|---|---|---|
| `resolved-green` | `#008053` | `#34D399` | 达成 / 已开通 / 材料齐备 |
| `due-amber` | `#B55300` | `#FBBF24` | 临期 / 待开通 / 缺材料 |
| `overdue-red` | `#DC2626` | `#F87171` | 已逾期 / 高风险 / 不可逆操作 |

三者同样钉在 4.5:1（且要在**最差的浅色面** `paper #F5F6F8` 上仍有余量），因此它们的 tag 变体**不使用浅色底**——浅底会把前景压到 4.3 上下。色温由描边承担。

**深色是一等外观**，不是浅色的机械反转：`body.dark` 整块替换令牌，内容区同样变深（`night-paper #101317`），强调色提亮到 `#4087FB` 以在深底上保持 4.5:1。深色下 `--shadow: none`——投影在黑底上不可见，层级改由描边与面色差承担。

## Typography

系统字体栈，**不引任何外部字体**（私有化内网部署，构建机不一定有外网；`next/font/google` 是构建期取字体，会引入"构建时好、部署时炸"的失败模式）。

字号阶梯 10 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 14.5 / 15 / 17 / 19 / 22 / 26，全部是实测在使用中的档位：

| 角色 | 字号 | 字重 | 用处 |
|---|---|---|---|
| display-lg | 26px | 600 | 工作台指标带的读数（最大的数） |
| display | 22px | 600 | 建案/报备成功页回显的编号——那串码是那屏唯一主角 |
| brand | 14.5px | 600 | 左导航顶部的字标 `MatterNest` |
| figure | 17px | 600 | 登录页品牌名 |
| page-title | 19px | 600 | 页面 `h2`（`.pagehead h2`） |
| topbar-title | 15px | 600 | 顶栏页名 `h1` |
| card-title | 14px | 600 | 卡片头（`.card-h`） |
| lead | 13.5px | 400 | 页签、富文本正文 |
| body | 13px | 400 | 表格、正文、控件（全站基准） |
| small | 12.5px | 400 | 表头、`.pill`、`.field` 标签 |
| label | 12px | 400 | 字段标签、次级说明、`.tag` |
| caption | 11.5px | 400 | 分组名、`.moda-f` 说明 |
| micro | 10px | 400 | `.cb` 的勾、`.sel` 的三角——**控件内的字形细节，不是排版层级** |
| glyph | 16px | 400 | `.modal-h .x` 的关闭 ✕（同上，字形尺寸） |
| numeric | 13px | — | `.num`：等宽 + `tnum` |

**13px 是基准**，因为这张界面主要是一张表。字号阶梯扁平是特意的——层次由**字重与墨色**承担（600/500/400 三档字重 + 三档墨色），而不是靠不断放大的字号。

> 自动检测器会报 `flat-type-hierarchy`（body 13 → 卡头 14 → 顶栏 15，相邻仅 1.08×，低于它 1.25× 的启发式）。**这条不适用**：该阈值面向内容页（长文阅读要靠大字差拉开层级），而本系统主要是一张表，纵向预算是稀缺资源——把卡头从 14 抬到 18 会直接吃掉表格能多显示的行。层级由三重承担：字重（600 / 500 / 400）、墨色（`ink` / `secondary` / `muted` 本身就是完整的一级阶梯）、位置（顶栏 / 页头 / 卡头，各有固定容器与间距）。看 `config.html` 可验证：五个卡头全是 14px，没人会把它读成正文。

`.num` 是全站唯一保留的自定义工具类：金额与编号必须数位对齐，否则 `8,420,000.00 / 760,000.00` 这一列要靠字符宽度猜。

**标题标签规则**：顶栏页名 `h1`；页面主区块的卡片头 `h2`；嵌套区块（角色权限页里「全局管理」下的「成员」）`h3`。`.card-h` 同时接受 `h2` 与 `h3` 且**同貌**（14px / 600）——层级由标签承担，视觉不跟着变。新增页面后检查 `h1 → h2 → h3` 不跳级（`agent-work/_chk/check-headings.mjs`）。

## Layout

**画布 1440 宽**（原型定宽）；实际部署目标 1366–1920，窄屏与移动端列二期（P1-17）。

- **左导航 216px** 固定，`position: sticky`；内容区自适应。
- **顶栏 52px** 固定，只写当前页名加一个 `.back`（详情页）。**顶栏不放任何其他东西**——身份区在导航底角，数据范围不常驻。
- **页容器** `.page` padding `20px 24px 40px`。
- **内容区撑到视口**（`min-height: calc(100vh - 52px)`），**末元素吃掉余量**。
  这条针对的是一类具体的割裂：左导航是 `height:100vh` 从顶贴到底，而内容只到半屏就停，
  同一屏里两个高度基准。现在内容区与导航同底，**空白落在卡片内部**而不是页面背景上。
  传递链是逐层接力的：`.page` → 末元素（`.card` / `.stack` / `.master`）→ 卡内主体。
  **表格行高恒为 40px，不参与拉伸**——`<table>` 一旦被拉高，浏览器会把余高平均分给各行
  （实测 4 行数据被摊成每行 180px），那是「数据少就数据少」的反面。余量留在表格下方。
  ⚠ `.master` / `.split` **是 grid，别在这里写 `flex-direction`**——会把并排两栏压成上下堆叠。
  判据：任一页在 1440×900 下内容底边与视口底差 ≤40px（40 是 `.page` 的 padding-bottom），
  脚本 `agent-work/_chk/verify-fill-all.mjs`。
- **列宽预算 1100 @1366**：表格一律 `<colgroup>` 显式定列宽，可伸缩列补 `.ellip`。
- **垂直节奏 16px**：卡片之间、卡片与查询区之间一律 16（`.stack > * + *`、`.card + .card`）；行内元素 6 / 10 / 20。
- **功能配置页**用 `repeat(auto-fit, minmax(max(200px,(100% - 64px)/5), 1fr))` + `grid-auto-rows: 1fr`：横向最多 5 张、窄了往下挤、**所有行等高**（1 条细项的卡与 5 条的卡同高）。
- **主从布局**（角色权限页）`.master` = `264px + minmax(0,1fr)`，**两栏等高**。
  等高不是给个固定高度，而是让 grid 默认 stretch 生效 + 右栏内部 flex 传递：
  `.master` **不写 `align-items:start`**（写了就关掉 stretch，右栏只剩内容高、底部悬空）；
  右栏 wrapper 是 flex 列，选中的 `.pane` 用 `flex:1` 接住高度，pane 内**末张卡**用 `flex:1 1 auto` 吃余量。
  于是高度取两侧内容的较大者——任一侧变长另一侧跟涨，不写死数字（加第 6 个角色会自动从 365 涨到 424 且仍齐平）。
  研究底稿与失败方案清单：`agent-work/research-master-detail-equal-height.md`。

**弹层**（新建/编辑）`.modal` 默认 780 / `.narrow` 520 / `.wide` 900，`max-height: 86vh`，**头与底栏钉住、只滚 `.modal-b`**。表单用 `.fgrid` 12 列网格，**每行最多两个字段**——常规一律 `span6`，整行才用 `span12`；**不要用 `span4` 拼三格一行**（780 宽里三格会挤成十几个字宽）。

## Elevation & Depth

**Flat by design。** 不用投影堆深度，层级由三样东西承担：

1. **1px 描边**（`--line`）
2. **面色差**（paper `#F5F6F8` vs surface `#FFFFFF` vs sunken `#FAFBFC`）
3. **间距**

浅色保留唯一一层极淡的投影 `0 1px 2px rgba(16,24,40,.06)`，它的作用是让卡片从纸色底上"浮起一丝"，不是表达层级；深色 `--shadow: none`。

**唯一例外是弹层**：遮罩（`rgba(16,24,40,.45)`，深色 `.6`）+ 一层大投影，用来表明"浮在页面之上、需要先处理它"。这是这个系统里唯一被允许的重量。

## Shapes

`--radius: 6px` 是唯一的圆角档位（按钮、输入、卡片、弹层、导航项全部同值）。另外三档各有语义：

- `3px` (xs)：最小控件——勾选框 `.cb`、色块 `.swatch`
- `4px` (sm)：小控件——`.seg` 内的项、`.tag`
- `10px` (pill)：开关 `.sw`——它是唯一变形的控件
- `50%`：状态点（`.pill i`、`.tl li::before`）

**令牌只有一处源**：`canon.css` 的 `:root` / `body.dark`。画廊 `index.html` 自带一份样式块是合理的（它不是产品页），但它曾经留着一套旧值、成了整套原型里唯一带低对比度文字的文件。凡是有第二份 `:root` 的地方，都要与 canon 同值。

**没有大圆角、没有胶囊形按钮、没有圆角卡片墙**。方一点是刻意的：它读起来像表格与文书，不像消费产品。

## Components

- **Button** `.btn`：32px 高、6px 圆角、1px 描边。四个变体——默认（描边）、`.pri`（实心，每屏至多一个）、`.danger`（描边 + 红字，用于撤销归档/明文导出/并入这类不可逆动作）、`.link`（无描边无底，用于行内动作如「进展 / 状态 / 程序」）。`.sm` 28px。
- **Card** `.card`：surface 底 + 1px 描边 + 6px 圆角。`.card-h` 标题区 14px 600，`.card-b` 内容区 padding 16。
- **Table** `.tb`：行高 40px、表头 `--th` 底 + 12.5px `--ink2`、行分隔 `--line2`、悬停 `--hover`。数字列 `.num`，右对齐 `.r`，居中 `.c`，空值 `.ph`（写 `—`）。
- **Pill** `.pill`：`6px` 圆点 + 词，四档 `.over` / `.due` / `.ok` / `.gray`。**永远点与词同时出现**。
- **Tag** `.tag`：12px、4px 圆角、1px 描边。语义变体 `.green` / `.red` / `.amber` 的底是 `var(--card)`（不用浅底，见 Colors）；`.blue` 保留浅底。
- **Switch** `.sw`：34×20、10px 圆角，`.on` 时底变强调色、圆点右移。
- **Segmented** `.seg`：末读/全部分段，选中项白底 + 描边。
- **Tabs** `.tabs`：13.5px、选中项 2px 强调色下划线。
- **Definition list** `.dl`：104px 标签 + 内容的四列网格，用于详情页字段表。
- **Empty** `.empty`：46px padding 居中，文案 = 事实 + 动作（如「还没有人持有这个角色」+「去用户管理授予」）。

**交互态**：悬停用面色（`--hover`），焦点用强调色描边，禁用降低墨色（不降低对比度到不可读）。原型阶段一切"打开/切换"用纯 CSS `:target` 实现（不引脚本）。

## Do's and Don'ts

**Do**

- 每加一句界面文案，先问「它是事实还是动作」；两者都不是就删（《副标题纪律》）。
- 状态/到期/危险度用「词 + 形状/色」双通道；色觉障碍用户必须能只靠词读懂。
- 密度往紧里做：这张界面主要是一张表，行高与控件高度都是刻度，改之前先想清楚为什么。
- 改任何颜色前跑 `agent-work/_chk/token-contrast.mjs`（令牌配对）与 `contrast-all.mjs`（全站渲染实测）。**别凭肉眼**——`#9CA3AF` 曾经在这个项目里活了好几轮，实测只有 2.54:1。
- 弹层内部字段按「同一组事实挨着」配对，每行最多两个。

**Don't**

- **不要在表格内部使用强调色**。蓝色只属于当前位置/主操作/焦点。
- 不要给语义色加浅色底（会把前景压到 4.5 以下）；色温由描边承担。
- 不要引入第二套组件体系、第二个图标库、外部字体或任何 CDN 资源（禁令⑦ + 私有化部署）。
- 不要用投影表达层级；弹层是唯一例外。
- 不要写死颜色：`canon.css` 的令牌是唯一源，深色靠 `body.dark` 覆盖，不是两份手写值。
- 不要让 `span` 拼出三格一行的表单，也不要给功能卡定死宽度。
- 不要把角色/权限这类**事实**画成看起来能改的样子（角色页只读，授予在用户管理页做）。

---

## 落地状态（迁移中，读这份文件的人必看）

**这份契约目前住在原型里**（`.impeccable/mocks/pages/canon.css`），**`src/` 真页尚未迁移**。两者的落差是已知的、正在消除的：

| | 原型 canon（**本文件描述的目标态**） | `src/`（当前实现） |
|---|---|---|
| 主色 | `#2563EB` | `#2f5fe0` |
| 纸色 | `#F5F6F8` | `#f7f8fa` |
| 深色模式 | 一等外观（内容区也深） | **不存在**（`theme/antd.ts` 里还留着「深色内容区没需求（P1-17）」的注释） |
| 导航 | 3 组 9 项 | 8 项（`配置字典` / `用户与角色` 未拆） |
| 角色权限页 | 主从布局、只读 | **页面不存在** |
| 功能配置 | 5 卡 14 细项、弹层 CRUD | 只读字典页 |

落真页时的口径：**canon.css 的令牌值转写进 `src/app/theme/brand.ts`**（色值单源，禁令⑦），`theme/antd.ts` 映射 antd token，`globals.css` 只留 CSS 侧无法 import 的那几处。**本文件与 `brand.ts` 必须同值**——改一处就得改另一处，`brand.spec.ts` 是这道闸门。

施工细则（逐页内容要求、弹层与表单的写法）见 `.impeccable/mocks/canon-spec.md`。

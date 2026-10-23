import { theme as antdTheme, type MappingAlgorithm, type ThemeConfig } from "antd";

import { BRAND, INK, tokensOf, type Appearance } from "./brand";

/**
 * antd v6 主题与全站语义色（**唯一一处**决定"结案是什么颜色"）。
 *
 * 为什么这轮换到 antd：用户两次反馈 shadcn 那套观感不行，并明确定方向。
 * 记录两条一手事实，免得后面有人以为可以顺手把 Pro 装上：
 *   · `antd@6.6.5`，peer `react >= 18` ⇒ 与本仓 React 19 兼容；
 *   · `@ant-design/pro-components@2.8.10` 的 peer 是 **`antd ^4.24.15 || ^5.11.2`**，
 *     **不含 antd 6** ⇒ ProTable/ProForm 装不上。所以列表壳与表单弹窗自己写
 *     （`components/data-table/` 与几个 Modal 表单），Pro 那三件便利
 *     （查询区 / 工具栏 / 表单化弹窗）是薄封装，不是不可替代的能力。
 *
 * 五条口径：
 *   1. **组件内尺寸一律交给 antd token**，Tailwind 只管容器布局（flex/gap/间距），
 *      否则又回到"两套间距刻度"那个老问题上；密度靠 `controlHeightSM`/`fontSizeSM` 一处调。
 *      尺寸刻度**不随外观变**（撤销 P1-17 撤的只是"只要亮色"）。
 *   2. **主色只出现在三处**（当前页 / 主操作 / 焦点），表格内部保持安静——
 *      这条从 v5 那版主题继承下来，它解决的是"临期与逾期淹在装饰里"，跟用哪个库无关。
 *   3. 语义色（状态、到期、等级）**不给整块底色**：`SEMANTIC_TONE` / `DEADLINE_TONE`
 *      给的是 antd 的 `Tag`/`Badge` 前景与描边，词永远保持中性可读。
 *   4. **色值本身不在这里**：品牌色与墨阶在 `./brand.ts`（那个文件不 import antd，
 *      所以登录页那种 Server Component 也能用）。这一份只负责把它们映射成 antd token，
 *      按外观取哪一组由 `antdThemeConfig(appearance)` 决定。
 *   5. **`algorithm` 可切**（`defaultAlgorithm` ↔ `darkAlgorithm`）。原先这里钉死
 *      `defaultAlgorithm` 并写着「深色内容区没需求也没有验收（P1-17）」——
 *      那条裁定已被 `docs/adr/0006-dark-mode-first-class.md` 撤销：深色不是一种"主题选项"，
 *      而是长时读表场景的默认诉求，且 31 页 × 2 版的对比度实测已经把"没有验收"这一半补上了。
 *   6. **品牌语义色在算法之后钉回去**（`brandAlgorithm`，2026-10-19）。见那个函数的长注释：
 *      `darkAlgorithm` 会把种子色**重新派生**，`#4087FB` 会变成 `#3976d8`，对比度从 5.06 掉到 3.96。
 */

/**
 * 品牌语义色**钉在派生之后**的算法。
 *
 * ## 为什么需要它（2026-10-19 实测）
 *
 * antd 的算法是 `derivatives.reduce((r, fn) => fn(seed, r), undefined)`（cssinjs
 * `Theme.getDerivativeToken`），也就是说每个算法拿到的第一个参数是**种子**、
 * 第二个是**上一步的完整结果**。`darkAlgorithm` 会把 `colorPrimary` 重新走一遍
 * `generate(palette, {theme:'dark'})` 才产出 map token —— 所以我们传进去的
 * `#4087FB` 最终被派生成 **`#3976d8`**：
 *
 *   · `#4087FB`（令牌值）在深色卡片 `#161A1F` 上 **5.06:1** —— 达线；
 *   · `#3976d8`（派生物）在同一底上 **3.96:1** —— 不达线。
 *
 * 同一件事在实心按钮上更糟：深色下 `type="primary"` 的底色被派生、字色仍是 `#fff`，
 * 白字压 `#3976d8` 只有 **4.41:1**。这两条都是**渲染后**的事实，`pnpm verify`
 * （测源码）七道全绿也发现不了 —— 它们是真页视觉冒烟量出来的。
 *
 * ## 为什么之前没暴露
 *
 * 层序（`globals.css` 的 `@layer antd, base, components`）曾把 Tailwind preflight
 * 排在 antd 之上，那条 `*{padding:0}` 与 `a{color:inherit}` 把 antd 的组件样式整个压掉，
 * 于是"链接不是蓝的""按钮没有底色"——**对比度反而全绿**，代价是所有 antd 组件内边距归零
 * （`.ant-btn` 的 padding 实测 `0px`）。层序修正后这些派生色才真正露面。
 *
 * ## 为什么用"钉"而不是"改种子"
 *
 * 只改种子没用：`darkAlgorithm` 会再派一遍。所以顺序必须是
 * **`[原算法, 钉回]`** —— 先让它算完 hover/active/bg 那一整套派生（那些确实该由算法生成），
 * 再把**语义本身**（主色/链接/错误/成功/警告/实心字色）覆盖成令牌值。
 *
 * ⚠ 签名必须是 `(_seed, derived)`：展开**第二个**参数。写成 `(token) => ...` 会拿到种子、
 * 丢掉整份派生结果，`colorPrimaryHover` 之类会变成 `undefined`（实测踩过）。
 *
 * ⚠ **实心按钮的字色不在这里**（别顺手往 `pin` 里加 `colorTextLightSolid`，那是死代码）：
 * 算法链之后还有一道 `formatToken`（antd `theme/util/alias`），它用 `colorWhite`
 * 重算 `colorTextLightSolid`（`colorTextLightSolid: mergedToken.colorWhite`）。
 * 所以那条只能靠 `token.colorWhite` 改，见 `buildTheme`。
 */
function brandAlgorithm(appearance: Appearance): MappingAlgorithm[] {
  const t = tokensOf(appearance);
  /**
   * 类型上 `DerivativeFunc` 的第二个参数是**可选**的（`derivativeToken?`），
   * 所以直接展开会让每个属性都变成 `| undefined`，过不了 `MapToken`。
   * 运行时它一定有值：链上第一个是 antd 自己的算法，它总是返回完整 map。
   * 断言因此是这条现实服务的，别改成 `any`（那样会把拼错的 token 名一起放行）。
   */
  const pin = ((_seed: unknown, derived: object | undefined) => ({
    ...derived,
    colorPrimary: t.accent,
    colorLink: t.accent,
    colorInfo: t.accent,
    colorError: t.red,
    colorSuccess: t.green,
    colorWarning: t.amber,
  })) as unknown as MappingAlgorithm;
  return [appearance === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm, pin];
}

/**
 * 明暗两份主题配置，模块级只建一次。
 *
 * 为什么缓存而不是每次调用新建：`ConfigProvider` 拿到的 `theme` 只要换了引用，
 * cssinjs 就会重算一遍 token；外观在 React 状态里，每渲染一次新建对象等于每渲染重算一次。
 */
function buildTheme(appearance: Appearance): ThemeConfig {
  const t = tokensOf(appearance);
  return {
    algorithm: brandAlgorithm(appearance),
    token: {
      colorPrimary: t.accent,
      colorLink: t.accent,
      colorInfo: t.accent,
      /** 语义色同样从令牌来（浅色 `#DC2626` / 深色 `#F87171`），理由见 `brandAlgorithm` */
      colorError: t.red,
      colorSuccess: t.green,
      colorWarning: t.amber,
      /**
       * 实心按钮上的字。antd 的默认是 `#fff`，在**深色**的强调色 `#4087FB` 上只有
       * **3.46:1**（低于 4.5）——深色下必须换成 `accent-ink`(#0B1220)，5.42:1。
       * 这条同时盖住 `type="primary"` 与 `danger` 两种实心按钮：它们共用
       * `colorTextLightSolid`（`button/style/token.js` 的 `primaryColor`/`dangerColor`）。
       */
      colorWhite: t["accent-ink"],
      colorBgLayout: t.bg,
      colorBgContainer: t.card,
      // 文本色从 antd 默认的半透明黑（.65/.45/.25）改挂本仓墨阶：
      // 那三个默认值在纸色底分别约 8.0/4.1/2.4，后两档做 12–14px 正文/占位都低于 4.5:1，
      // 且与本仓"一个语义一个值"的墨阶打架（`type="secondary"` 会绕过墨阶走库默认）。
      colorText: t.ink,
      colorTextSecondary: t.ink2,
      colorTextTertiary: t.ink3,
      colorTextDescription: t.ink3,
      // 占位符 craft-floor 要求 ≥4.5:1：用 ink3 而不是库默认 .25
      colorTextQuaternary: t.ink3,
      colorSplit: t.line,
      /**
       * antd 的"卡片级"描边（`Card` 外框、`Tabs` 底槽、内嵌分隔）走这一个 token。
       * 库默认 `#f0f0f0` 与本仓的 `--line`（浅色 `#E5E7EB` / 深色 `#232830`）不是一份色，
       * 于是同一个页面上会出现两种卡边：canon 的 `.card` 走 `--line`，antd `Card` 走库默认。
       * 详情页按原型对齐时把这格补上（2026-10-21）：**分隔线一档，全站一个值**。
       * 交互控件的边界仍是 `--control-line`（WCAG 1.4.11 的 3:1 那一档），不跟着动。
       */
      colorBorderSecondary: t.line,
      borderRadius: 6,
      fontSize: 14,
      // 密集表格与筛选条靠这一档：默认 32 的控件在 10 列表格里显肿
      controlHeight: 30,
      controlHeightSM: 24,
      fontSizeSM: 12,
      wireframe: false,
    },
    components: {
      Table: {
        headerBg: t.th,
        headerColor: t.ink2,
        headerSplitColor: t.line,
        cellPaddingBlockSM: 5,
        cellPaddingInlineSM: 10,
        rowHoverBg: t.hover,
        borderColor: t.line,
        fontSize: 13,
      },
      /**
       * `Layout` / `Menu` 的映射自 2026-10-18 起**只剩兜底**：左导航外壳已换成
       * canon 的 `.nav`（见 `globals.css`），不再走 antd 的 `Sider`/`Menu`。
       * 留着是为了任何还在用 `Layout` 的地方不会掉回 antd 默认的深紫导航色，
       * 值全部指向 `nav-*` 令牌——真要再长出第二套导航壳时，这里会先不一样。
       */
      Layout: {
        siderBg: t["nav-bg"],
        headerBg: t.card,
        headerHeight: 48,
        headerPadding: "0 20px",
      },
      Menu: {
        darkItemBg: t["nav-bg"],
        darkItemColor: t["nav-ink"],
        darkItemSelectedBg: t["nav-on"],
        darkItemSelectedColor: t["nav-on-ink"],
        darkSubMenuItemBg: t["nav-bg"],
        itemHeight: 34,
      },
      Card: { paddingLG: 16 },
      Descriptions: { itemPaddingBottom: 8 },
      /**
       * `Listy`（2026-10-16 顶替已废弃的 `List`）。本仓的列表都是**卡片内小列表**，
       * 迁移前一律 `size="small"`：那套的内间距实测是 `8px 16px`
       * （`itemPaddingSM = paddingContentVerticalSM(paddingXS=8) × paddingContentHorizontal(16)`）。
       * `Listy` 的默认是 `paddingSM / padding`（12px 16px）—— 行高会比迁移前多 8px。
       *
       * 密度是一处可调的刻度，所以差别在这里抹平，而不是在每个 `<Listy>` 上写 `styles.item`
       * （工作台那两处**刻意更紧**的 8px/6px 仍走 `styles.item`，见 `workbench.tsx`）。
       * 想回到 antd 默认密度，把这一行删掉即可。
       */
      Listy: { itemPaddingBlock: 8 },
      Tabs: { horizontalItemPadding: "8px 2px", horizontalMargin: "0 0 12px 0" },
      Form: { itemMarginBottom: 12, verticalLabelPadding: "0 0 2px" },
      /**
       * `Badge`（侧栏通知的未读角标）。2026-10-20 live 裁定（变体 1：角标贴铃铛右上角）
       * 之后，角标**包住图标**而不是并排挂在图标后面——并排的那版会把 40px 的胶囊撑到 55px，
       * 用户原话「角标不要撑开原图标大小」。
       *
       * 三条都走 token、不在组件里写 `style`（密度契约第 2 条）：
       *   · `indicatorHeightSM: 16` / `textFontSizeSM: 10` —— 这一档同时定住
       *     角标的宽高、`line-height` 与圆角（antd 的 `-count-sm` 全部由这两个值派生），
       *     库默认的 14/12 在 15px 的铃铛上显重；
       *   · `colorTextLightSolid: t.card` —— 角标是**实心底**，字色必须随外观翻面：
       *     浅色是白字压 `--red` #DC2626（4.8:1），深色是墨字压提亮后的 `--red` #F87171
       *     （6.2:1）。留库默认的白字，深色下只有 2.6:1（这正是记忆里
       *     「深色重派生」那一条踩过的坑）；
       *   · `lineWidth: 2` —— 角标与铃铛笔画之间的那圈环，宽度由它定（`badgeShadowSize`），
       *     环色 `colorBorderBg` 已经从 `colorBgContainer` 派生成 `t.card`，与胶囊底色同源。
       *
       * 另一处 `Badge`（通知页的已读/未读）走的是 `status` 形态，用的是 `dotSize` /
       * `statusSize` / `colorText`，与这三个值无关，不会被带偏。
       */
      Badge: {
        // 2026-10-24 再收一档（用户批注「角标圆还要再小一点」）：16 高 + 8px 字，
        // 两位数仍放得下；宽度相等与 padding 归零见 globals.css 的同名规则。
        indicatorHeightSM: 16,
        textFontSizeSM: 8,
        // ⚠ 必须写字符串：antd 6 的 cssinjs 只给「维度类」token 换算数字，
        // `font-weight` 这种非维度值传数字会被**静默丢掉**（实测 `textFontWeight: 600`
        // 计算值仍是 400，改成 `"600"` 才生效）。
        textFontWeight: "600",
        colorTextLightSolid: t.card,
        lineWidth: 2,
      },
    },
  };
}

const THEMES: Record<Appearance, ThemeConfig> = {
  light: buildTheme("light"),
  dark: buildTheme("dark"),
};

/** 外观 → antd 主题配置。`ConfigProvider` 每渲染只取一次（模块级缓存，见上）。 */
export function antdThemeConfig(appearance: Appearance): ThemeConfig {
  return THEMES[appearance];
}

/** 状态语义 → 色。key 是 `mn_status_config.semantics`（配置驱动，不是 code） */
export const SEMANTIC_TONE: Record<string, { color: string; badge: string }> = {
  open: { color: "default", badge: "default" },
  in_progress: { color: "processing", badge: "processing" },
  closed: { color: "success", badge: "success" },
  archived: { color: "default", badge: "default" },
  custom: { color: "blue", badge: "blue" },
};

/**
 * 到期分档。阈值 3/7 天与节点提醒默认档 `{7,3,1}` 同源，但**这里不读那列**：
 * 列表要的是"这条现在危不危险"的一次性判断，每行再解析数组会让表格渲染变成 O(行×档)。
 * 真按节点档位发消息是 M5 扫描器的事。
 */
/**
 * 到期分档**只给色**，文案由 `DeadlineMark` 算（"逾期 N 天"/"剩 N 天"）。
 * 把文案放组件里而不是这里，是因为颜色与措辞的耦合点只有一处才不会出现
 * "标记写逾期、别处写过期"这种词汇分裂。
 *
 * 这一组随外观走：`BRAND` / `INK` 已改成**令牌引用**（`var(--red)` 一类），
 * 不再是浅色的十六进制副本。先前那版写着"只有浅色那一档、批量二之后再改用令牌"——
 * 那个"之后"就是现在（2026-10-18）。触发它的是真页视觉冒烟量出的三处：
 * 深色下逾期红 3.62、临期橙 3.50、计数灰 3.08，全低于正文 4.5 的地板，
 * 而 `pnpm verify` 那时是绿的（它测的是源码，不是渲染结果）。
 */
export const DEADLINE_TONE = {
  overdue: { color: BRAND.overdue },
  soon: { color: BRAND.soon },
  near: { color: BRAND.primary },
  later: { color: INK.secondary },
} as const;

/**
 * 原先这里还有 `SCOPE_HINT`（数据范围三档的一句话说明）。2026-10-12 随侧栏底部那块
 * 范围说明一起撤掉了——范围已经在 Header 标签上说过一遍，而那行散文把范围谓词
 * 复述成了第二份说法。范围的三档定义仍以 `shared/enums/targets.ts` 的
 * `DATA_SCOPE_LABELS` 为准，不需要第二处文案。
 */

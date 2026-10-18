import { theme as antdTheme, type ThemeConfig } from "antd";

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
 */

/**
 * 明暗两份主题配置，模块级只建一次。
 *
 * 为什么缓存而不是每次调用新建：`ConfigProvider` 拿到的 `theme` 只要换了引用，
 * cssinjs 就会重算一遍 token；外观在 React 状态里，每渲染一次新建对象等于每渲染重算一次。
 */
function buildTheme(appearance: Appearance): ThemeConfig {
  const t = tokensOf(appearance);
  return {
    algorithm: appearance === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: t.accent,
      colorLink: t.accent,
      colorInfo: t.accent,
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
 * ⚠ 这一组目前**只有浅色那一档**（`BRAND` 是迁移期别名）。批量二把页面换成 canon 类
 * 之后，这些位置改用 `var(--red)` 一类令牌，深色那一档随之成立——本批不迁页面，
 * 所以深色下它们仍按浅色值渲染。
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

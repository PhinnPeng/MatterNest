import { theme as antdTheme, type ThemeConfig } from "antd";

import { BRAND, INK, PAPER } from "./brand";

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
 * 三条口径：
 *   1. **组件内尺寸一律交给 antd token**，Tailwind 只管容器布局（flex/gap/间距），
 *      否则又回到"两套间距刻度"那个老问题上；密度靠 `controlHeightSM`/`fontSizeSM` 一处调。
 *   2. **主色只出现在三处**（当前页 / 主操作 / 焦点），表格内部保持安静——
 *      这条从 v5 那版主题继承下来，它解决的是"临期与逾期淹在装饰里"，跟用哪个库无关。
 *   3. 语义色（状态、到期、等级）**不给整块底色**：`SEMANTIC_TONE` / `DEADLINE_TONE`
 *      给的是 antd 的 `Tag`/`Badge` 前景与描边，词永远保持中性可读。
 *   4. **色值本身不在这里**：品牌色与墨阶在 `./brand.ts`（那个文件不 import antd，
 *      所以登录页那种 Server Component 也能用）。这一份只负责把它们映射成 antd token。
 */

export const antdThemeConfig: ThemeConfig = {
  // 明暗只用亮色：一期是内网宽屏 PC，深色内容区没需求也没有验收（P1-17）
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    colorPrimary: BRAND.primary,
    colorLink: BRAND.primary,
    colorInfo: BRAND.primary,
    colorBgLayout: PAPER,
    colorBgContainer: "#ffffff",
    // 文本色从 antd 默认的半透明黑（.65/.45/.25）改挂本仓墨阶：
    // 那三个默认值在纸色底分别约 8.0/4.1/2.4，后两档做 12–14px 正文/占位都低于 4.5:1，
    // 且与本仓"一个语义一个值"的墨阶打架（`type="secondary"` 会绕过 INK 走库默认）。
    colorText: INK.body,
    colorTextSecondary: INK.secondary,
    colorTextTertiary: INK.muted,
    colorTextDescription: INK.muted,
    // 占位符 craft-floor 要求 ≥4.5:1：用 muted（≈5:1）而不是库默认 .25
    colorTextQuaternary: INK.muted,
    borderRadius: 6,
    fontSize: 14,
    // 密集表格与筛选条靠这一档：默认 32 的控件在 10 列表格里显肿
    controlHeight: 30,
    controlHeightSM: 24,
    fontSizeSM: 12,
    colorSplit: "#e9ebf0",
    wireframe: false,
  },
  components: {
    Table: {
      headerBg: "#f2f4f8",
      headerColor: INK.secondary,
      headerSplitColor: "#e3e6ec",
      cellPaddingBlockSM: 5,
      cellPaddingInlineSM: 10,
      rowHoverBg: "rgba(47,95,224,0.045)",
      borderColor: INK.line,
      fontSize: 13,
    },
    Layout: {
      siderBg: BRAND.sider.bg,
      headerBg: "#ffffff",
      headerHeight: 48,
      headerPadding: "0 20px",
    },
    Menu: {
      darkItemBg: BRAND.sider.bg,
      darkItemColor: BRAND.sider.item,
      darkItemSelectedBg: BRAND.sider.accent,
      darkItemSelectedColor: BRAND.sider.active,
      darkSubMenuItemBg: BRAND.sider.bg,
      itemHeight: 34,
    },
    Card: { paddingLG: 16 },
    Descriptions: { itemPaddingBottom: 8 },
    Tabs: { horizontalItemPadding: "8px 2px", horizontalMargin: "0 0 12px 0" },
    Form: { itemMarginBottom: 12, verticalLabelPadding: "0 0 2px" },
  },
};

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
 */
export const DEADLINE_TONE = {
  overdue: { color: BRAND.overdue },
  soon: { color: BRAND.soon },
  near: { color: BRAND.primary },
  later: { color: INK.secondary },
} as const;

/** 数据范围三档的一句话说明（左侧菜单底部用） */
export const SCOPE_HINT: Record<string, string> = {
  all: "全公司：每一案件/事项",
  participating: "我参与：承办 ∪ 协办 ∪ 关注 ∪ 创建",
  owned: "我承办：承办 ∪ 创建（不含他人加给我的协办/关注）",
};

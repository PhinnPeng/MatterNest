"use client";

import type { ReactNode } from "react";
import { Button, Card } from "antd";

/**
 * 查询区（列表页顶部那一排筛选 + 查询/重置）。
 *
 * 两条刻意的口径：
 *   · **提交式而不是即输即查**：条件先落在调用方的草稿态里，「查询」或回车才写进 URL。
 *     上一版用 500ms 去抖，那是为了压住"每敲一个字发一次 LIKE"；提交式把这个压力
 *     从时间维度换成了意图维度——用户说查才查，比"猜他停了没有"更准，也让
 *     URL 历史里不会出现一串半截关键词。
 *   · **标题与控件同一行、按钮在右下**：六个筛选各是「label + 控件」的横排，
 *     按钮组右对齐底部（见下面的宽度推导）。
 *
 * ## 2026-10-19：外壳回到 antd
 *
 * 与 `DataTable` 同一次改判（用户要求"相关组件使用 AntD 开发，不要自开发"）。
 * 外壳用 `Card`，按钮用 `Button`。
 *
 * ## 2026-10-21：原生 Flex 布局 + 各筛选按“合适宽度”定档
 *
 * 原来用 antd `Row/Col` 做栅格，`Col flex="0 1 npx"` 意思是“基准 n、可缩”，
 * 在窄屏下各筛选会被压缩变形，label 与控件彼此挤。改成**纯原生 Flex**：
 *
 *   · 外层 `display: flex; flex-wrap: wrap; gap: 16px` —— 各筛选元素**不收缩**
 *     （`flex: 0 0 auto`），装不下就整体换到下一行，而不是把控件压成一条缝；
 *   · 每格内部 `display: flex; align-items: center` —— label 与控件同一行，
 *     label 右侧留 `8px` 间距；
 *   · 控件下限 100px：低于它，antd `Select` 的 placeholder（「全部」）会被裁掉一半；
 *   · 按钮组是这一行的**最后一个子项**并带 `margin-left: auto`：它于是永远落在
 *     所在那一行的最右下角；这一行放不下它时 flex 换行，它到下一行后仍然是
 *     最右下角（`margin-left: auto` 在换行后的新行同样成立）。
 *
 * ## 每格宽度推论（1366 视口，容器 1118px，`Card` body padding 16×2 ⇒ 内容 1086px）
 *
 * **`width` 是控件自己的宽，不含 label**：这一条曾经写反（当成了整格宽），
 * 于是四字标签（48px）从 130 里扣掉，控件只剩 74px，`Select` 被压扁变形。
 * 现在 `width` 只描述控件：
 *   · **关键词**（文本框，用户要打字）：`200`；
 *   · **其余五个下拉**（placeholder 只有「全部」两个字）：`120`；
 *   · 控件下限 100px：低于它，antd `Select` 的 placeholder 会被裁掉一半。
 *
 * 一格的实际占用 = label（12px 字号：关键词 36 / 四字标签 48）+ 8px + 控件。
 * 六个筛选在 1366 下需要 1192px（> 1086）⇒ **自动换到两行**；1920 下内容
 * 1368px，加按钮组 1340px 恰好一行排开。行数随屏幕宽度变，不是写死的。
 */
export function QueryFilter({
  children,
  onSearch,
  onReset,
  busy,
  actions,
  searchType = "primary",
}: {
  children: ReactNode;
  onSearch: () => void;
  onReset: () => void;
  busy?: boolean;
  /**
   * 紧跟「重置」之后的主动作（canon 事项页原型把「登记事项」放在查询行右端）。
   *
   * 只有需要它的页面才传：不传时这一行仍然是「查询 / 重置」，其余列表页的按钮组
   * 一个像素都不变。
   */
  actions?: ReactNode;
  /**
   * 「查询」的按钮形态。默认 `primary`（全站列表页一直如此）；某个页面把主色让给
   * 行内主动作时（原型里查询是次要按钮、登记事项才是主色）才降成 `default`。
   */
  searchType?: "primary" | "default";
}) {
  return (
    <Card size="small" styles={{ body: { padding: "14px 16px" } }}>
      {/*
        筛选行：纯 Flex，各筛选按各自宽度排列，窄屏自动换行，不互相压缩。
        按钮组是最后一个子项 + `margin-left: auto` ⇒ 永远落在所在行最右下角；
        这一行放不下它时它换到下一行，仍然靠右。
      */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "16px" }}>
        {children}
        <div style={{ display: "flex", marginLeft: "auto", flex: "0 0 auto" }}>
          <Button type={searchType} loading={busy} onClick={onSearch}>
            查询
          </Button>
          <Button style={{ marginLeft: 8 }} onClick={onReset}>
            重置
          </Button>
          {actions ? <div style={{ marginLeft: 8, display: "flex" }}>{actions}</div> : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * 查询区里的一个字段：**label 与控件同一行**。
 *
 * `htmlFor` 是给读屏与"点标签聚焦控件"用的；不给就只能靠控件自己的 `id` 猜。
 *
 * 宽度口径（推论见本文件顶部注释）：`width` 是**控件自己的宽**，不含 label。
 * 整格实际占用 = label（12px 字号，四字标签约 48px）+ 8px 间距 + 控件。
 * 调用方按实际内容给 `width`：
 *   · 关键词文本框：200px（要打字）；
 *   · 其余下拉：120px（placeholder 只有「全部」两个字）。
 *
 * 整格 `flex: 0 0 auto`：**不收缩**。宽度不够时换行，而不是把控件压扁变形。
 */
export function FilterField({
  label,
  htmlFor,
  width = 120,
  children,
}: {
  label: string;
  htmlFor?: string;
  width?: number;
  children: ReactNode;
}) {
  return (
    <div style={{ flex: "0 0 auto" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <label htmlFor={htmlFor} className="query-label" style={{ paddingRight: 8 }}>
          {label}
        </label>
        <div className="query-control" style={{ width, minWidth: 100 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

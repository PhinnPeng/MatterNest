"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeftOutlined } from "@ant-design/icons";

/**
 * 页面头：**名称 / 编号 / 状态**这类"必须在第一屏出现"的事实与操作。
 *
 * ## 为什么没有 `eyebrow` / `meta`
 *
 * 2026-10-12 撤掉了这两个 `ReactNode` 插槽（研究底稿：`docs/research-subtitle-discipline.md`）。
 * 它们是"第二行说明"这个**位置**的通用入口，于是每个新页面最自然的做法就是往里塞一句解释：
 * 清点出 75 处副标题，页面头占了 18 处，而"把紧邻的标题再说一遍"那种零信息量的写法
 * 正是从这里长出来的。删掉插槽不是审美偏好，是让**页面头第二行说明在类型上不可表达**——
 * 不需要新增 lint 规则，也不会有人"顺手加一句"，因为加它得先改这个组件的签名。
 *
 * 剩下这三个 prop 是按"它是不是标题之外的那个事实本身"分的，不是按位置：
 *   · `title` 名称；
 *   · `code` **与标题同行**的主键 —— 编号和名称是同一个名词的两个面，
 *     横排放是"主键 + 名称"，竖排放才是"标题 + 副标题"；
 *   · `status` 状态徽标、`flags` 与状态正交的第二个事实（已归档 / 已结案 / 已转案件）：
 *     它们不是对标题的解释。
 *
 * 要多说什么，落点只有四类：空态 / 错误态、字段说明（`Form.Item` 的 extra/help）、
 * tooltip、页面里已有的字段表（`.dl`）。见
 * `.trellis/spec/frontend/component-guidelines.md` 的「副标题纪律」。
 *
 * ## 2026-10-18（MATT-99）：换 canon
 *
 * 从 antd `Flex` + `Typography.Title level={1}` 换成 canon 的 `.pagehead` + `h2`。
 * 标题层级因此归位：**顶栏 `h1` 是页名**（`app-shell.tsx` 的 `.topbar h1`），
 * 页面内的主区块标题是 `h2`（`component-guidelines` 的 h1→h2→h3 不跳级）。
 * 换渲染器不丢任何 prop —— `code` / `status` / `flags` / `actions` 逐一同在。
 * ## 2026-10-23（用户裁定）：详情页的 `stacked` 布局
 *
 * 案件详情页要求第一行「返回 + 案号」、第二行「标题 + 状态」。这不是重新开放
 * 副标题插槽：新增的两个 prop 都**只承载导航与主键**——`back` 是一个返回链接的
 * 形状（`href` + `label`），塞不进一句解释；`stacked` 只决定这两行怎么排。
 * 列表页不传 `stacked`，仍是原来的单行。
 */
export function PageHeader({
  title,
  code,
  status,
  flags,
  actions,
  back,
  stacked = false,
}: {
  title: ReactNode;
  /** 与标题同行的主键（案件内部编号、事项编号）；用 `.num` 等宽字形 */
  code?: ReactNode;
  /** 状态徽标 —— 第一屏必须可见 */
  status?: ReactNode;
  /** 与状态正交的第二个事实（已归档 / 已结案 / 已转案件） */
  flags?: ReactNode;
  actions?: ReactNode;
  /** 详情页的返回入口：第一行最左，只能是导航，不能是说明文字 */
  back?: { href: string; label: string };
  /** 第一行 返回 + 编号，第二行 标题 + 状态；默认单行 */
  stacked?: boolean;
}) {
  const codeNode = code ? (
    <span className="num mut3" style={{ fontSize: 12 }}>
      {code}
    </span>
  ) : null;

  if (stacked) {
    return (
      <div className="pagehead">
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <div className="rowflex" style={{ alignItems: "center", gap: 8 }}>
            {back ? (
              <Link href={back.href} className="backlink">
                <ArrowLeftOutlined style={{ fontSize: 11 }} /> {back.label}
              </Link>
            ) : null}
            {codeNode}
          </div>
          <div className="rowflex" style={{ flexWrap: "wrap", gap: 8 }}>
            <h2>{title}</h2>
            {status}
            {flags}
          </div>
        </div>
        <span className="sp" />
        {actions ? <div className="rowflex">{actions}</div> : null}
      </div>
    );
  }

  return (
    <div className="pagehead">
      <div style={{ minWidth: 0 }}>
        <div className="rowflex" style={{ flexWrap: "wrap", gap: 8 }}>
          <h2>{title}</h2>
          {/* 编号是主键不是副标题，所以与标题同行；灰 12px 让它在读过一遍后自动退到次位 */}
          {codeNode}
          {status}
          {flags}
        </div>
      </div>
      <span className="sp" />
      {actions ? <div className="rowflex">{actions}</div> : null}
    </div>
  );
}

/**
 * 卡片小节标题（详情 Tab 内部分区、详情页内嵌表用）。
 *
 * 层级归位：这是**卡片内的嵌套区块**，用 `h3`（canon 的 `.card-h h2/h3` 同貌，14px/600）。
 * 从 antd `Typography.Text` 换成真实的 `h3` 标签——嵌套区块的层级该由标签承担，
 * 否则读屏拿到的是"一段加粗的字"，与视觉上的分区对不上。
 */
export function SectionTitle({
  children,
  count,
  extra,
}: {
  children: ReactNode;
  count?: number;
  extra?: ReactNode;
}) {
  return (
    <div className="rowflex" style={{ justifyContent: "space-between", marginBottom: 6 }}>
      <h3 style={{ fontSize: 13, fontWeight: 600 }}>
        {children}
        {count !== undefined ? (
          <span className="num mut3" style={{ fontWeight: 400, marginLeft: 6 }}>
            {count}
          </span>
        ) : null}
      </h3>
      {extra}
    </div>
  );
}

"use client";

import { INK } from "@/app/theme/brand";
import type { ReactNode } from "react";
import { Flex, Typography } from "antd";

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
 * tooltip、页面里已有的字段表（`Descriptions` / `MetaLine`）。见
 * `.trellis/spec/frontend/component-guidelines.md` 的「副标题纪律」。
 */
export function PageHeader({
  title,
  code,
  status,
  flags,
  actions,
}: {
  title: ReactNode;
  /** 与标题同行的主键（案件内部编号、事项编号）；用 `.num` 等宽字形 */
  code?: ReactNode;
  /** 状态徽标 —— 第一屏必须可见 */
  status?: ReactNode;
  /** 与状态正交的第二个事实（已归档 / 已结案 / 已转案件） */
  flags?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Flex align="flex-start" justify="space-between" gap={16} wrap style={{ marginBottom: 12 }}>
      <div style={{ minWidth: 0 }}>
        <Flex align="center" gap={8} wrap>
          {/* 语义上这是每页唯一的 h1（登录页也是 h1，全站标题层级才有唯一的根），
              但视觉尺寸仍钉在原 h4 的 16px：读屏结构要修，成熟观感不能跟着一起动。 */}
          <Typography.Title
            level={1}
            style={{ margin: 0, lineHeight: "28px", fontSize: 16, fontWeight: 600 }}
          >
            {title}
          </Typography.Title>
          {/* 编号是主键不是副标题，所以与标题同行；灰 12px 让它在读过一遍后自动退到次位 */}
          {code ? (
            <span className="num" style={{ color: INK.muted, fontSize: 12 }}>
              {code}
            </span>
          ) : null}
          {status}
          {flags}
        </Flex>
      </div>
      {actions ? <Flex gap={8}>{actions}</Flex> : null}
    </Flex>
  );
}

/** 卡片小节标题（详情 Tab 内部分区用） */
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
    <Flex align="center" justify="space-between" gap={12} style={{ marginBottom: 6 }}>
      <Typography.Text strong style={{ fontSize: 13 }}>
        {children}
        {count !== undefined ? (
          <span className="num" style={{ color: INK.muted, fontWeight: 400, marginLeft: 6 }}>
            {count}
          </span>
        ) : null}
      </Typography.Text>
      {extra}
    </Flex>
  );
}

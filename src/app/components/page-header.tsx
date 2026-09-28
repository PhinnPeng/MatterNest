"use client";

import { INK } from "@/app/theme/brand";
import type { ReactNode } from "react";
import { Card, Divider, Flex, Typography } from "antd";

/**
 * 页面头：**编号 / 名称 / 状态**这类"必须在第一屏出现"的信息放这里，操作靠右。
 * 列表页与详情页共用一个形状，是为了让"标题占多宽、副信息第几行"在全站只有一个答案。
 */
export function PageHeader({
  eyebrow,
  title,
  meta,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Flex align="flex-start" justify="space-between" gap={16} wrap style={{ marginBottom: 12 }}>
      <div style={{ minWidth: 0 }}>
        {eyebrow ? (
          <Flex align="center" gap={8} wrap style={{ marginBottom: 2 }}>
            {eyebrow}
          </Flex>
        ) : null}
        <Typography.Title level={4} style={{ margin: 0, lineHeight: "28px" }}>
          {title}
        </Typography.Title>
        {meta ? (
          <Flex
            align="center"
            gap={12}
            wrap
            style={{ marginTop: 4, fontSize: 12, color: INK.muted }}
          >
            {meta}
          </Flex>
        ) : null}
      </div>
      {actions ? <Flex gap={8}>{actions}</Flex> : null}
    </Flex>
  );
}

/** 详情页顶栏下方的"键 : 值"一行（刻意不做等宽网格：字段重要性差别很大） */
export function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Flex gap={6} align="baseline">
      <span style={{ color: INK.muted, fontSize: 12 }}>{label}</span>
      <span style={{ fontSize: 13 }}>{children}</span>
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

/** 详情 Tab 里的分区卡片 */
export function Section({
  title,
  count,
  extra,
  children,
}: {
  title: ReactNode;
  count?: number;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card
      size="small"
      title={<SectionTitle count={count}>{title}</SectionTitle>}
      extra={extra}
      styles={{ body: { padding: 12 } }}
    >
      {children}
    </Card>
  );
}

export const VDivider = () => <Divider type="vertical" style={{ margin: "0 2px" }} />;

"use client";

import { Button, Card, Flex, Space } from "antd";
import type { ReactNode } from "react";

import { INK } from "@/app/theme/brand";

/**
 * 查询区（ProTable 的"查询表单"那一段）。
 *
 * 两条刻意的口径：
 *   · **提交式而不是即输即查**：条件先落在本组件的草稿里，「查询」或回车才写进 URL。
 *     上一版用 500ms 去抖，那是为了压住"每敲一个字发一次 LIKE"；提交式把这个压力
 *     从时间维度换成了意图维度——用户说查才查，比"猜他停了没有"更准，也让
 *     URL 历史里不会出现一串半截关键词。
 *   · **条件与动作同一行、动作靠右**：这是 Pro 查询区最识别得出的形态，
 *     也是"左边选什么、右边执行"这条阅读顺序的落点。
 */
export function QueryFilter({
  children,
  onSearch,
  onReset,
  busy,
}: {
  children: ReactNode;
  onSearch: () => void;
  onReset: () => void;
  busy?: boolean;
}) {
  return (
    <Card
      size="small"
      variant="outlined"
      styles={{ body: { padding: 16 } }}
      style={{ marginBottom: 12 }}
    >
      <Flex wrap gap={16} align="flex-end" justify="space-between">
        <Flex wrap gap={16} align="flex-end" style={{ minWidth: 0 }}>
          {children}
        </Flex>
        <Space size={8}>
          <Button onClick={onReset}>重置</Button>
          <Button type="primary" loading={busy} onClick={onSearch}>
            查询
          </Button>
        </Space>
      </Flex>
    </Card>
  );
}

/**
 * 查询区里的一个字段：标签在上、控件在下。
 * 标签用 `<label>` 而不是 span，控件才能被读屏正确关联（点标签也能聚焦控件）。
 */
export function FilterField({
  label,
  htmlFor,
  width = 200,
  children,
}: {
  label: string;
  htmlFor?: string;
  width?: number;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: width,
        flex: `0 1 ${width}px`,
      }}
    >
      <label htmlFor={htmlFor} style={{ fontSize: 12, color: INK.muted }}>
        {label}
      </label>
      {children}
    </div>
  );
}

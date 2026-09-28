"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, Checkbox, Flex, Input, Select, Space, Tooltip, Typography } from "antd";
import { ArrowDownOutlined, ArrowUpOutlined, SearchOutlined } from "@ant-design/icons";

import { INK } from "@/app/theme/brand";

/**
 * 列表筛选条（自己写的那层"ProTable 查询区"）。
 *
 * 三条口径没随换库变：
 *   · 关键词 **500ms 去抖**：每敲一个字就发一次带 LIKE 的查询，在内网那种小机上
 *     比慢查询更糟的是分页条闪个不停，看起来像结果在漂；
 *   · 所有条件写进 **URL**（由调用方的 `useListState` 负责），所以这里不持有任何状态；
 *   · 值域一律从 `/api/meta` 传进来（`statusOptions`），组件不收硬编码取值——
 *     W0-3 那条"枚举单一出处"在前端的落点就是这里。
 */
export type ToolbarProps = {
  keyword: string;
  onKeyword: (v: string) => void;
  status: string;
  onStatus: (v: string) => void;
  statusOptions: { value: string; label: string }[];
  sortBy: string;
  sortDir: "asc" | "desc";
  onSort: (key: string, dir: "asc" | "desc") => void;
  sortOptions: { value: string; label: string }[];
  includeArchived?: boolean;
  onIncludeArchived?: (v: boolean) => void;
  actions?: React.ReactNode;
  busy?: boolean;
};

export function ListToolbar({
  keyword,
  onKeyword,
  status,
  onStatus,
  statusOptions,
  sortBy,
  sortDir,
  onSort,
  sortOptions,
  includeArchived,
  onIncludeArchived,
  actions,
  busy,
}: ToolbarProps) {
  const [text, setText] = useState(keyword);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * 外部改了关键词（浏览器后退、URL 被清）要跟着回显。
   * 写成 effect 而不是在 render 里 `setText`——渲染期 setState 会再多走一轮渲染，
   * 这种写法在 React 19 下不报错，但会让人觉得"输入框偶尔慢半拍"。
   */
  useEffect(() => setText(keyword), [keyword]);

  function commit(next: string) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onKeyword(next.trim()), 500);
  }

  const dir = sortDir;

  return (
    <Card size="small" styles={{ body: { padding: "10px 12px" } }} style={{ marginBottom: 12 }}>
      <Flex wrap gap={8} align="center">
        <Input
          allowClear
          style={{ width: 240 }}
          prefix={<SearchOutlined style={{ color: INK.faint }} />}
          value={text}
          placeholder="案号 / 名称 / 案由"
          aria-label="关键词"
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value);
          }}
          onPressEnter={() => {
            // 回车立即提交：去抖是便利，不该拦住"我就是现在要搜"
            if (timer.current) clearTimeout(timer.current);
            onKeyword(text.trim());
          }}
        />

        <Select
          style={{ width: 132 }}
          aria-label="状态"
          placeholder="全部状态"
          allowClear
          value={status || undefined}
          options={statusOptions}
          onChange={(v) => onStatus(v ?? "")}
        />

        <Space.Compact>
          <Select
            style={{ width: 128 }}
            aria-label="排序列"
            value={sortBy}
            options={sortOptions}
            onChange={(v) => onSort(v, dir)}
          />
          <Tooltip title={dir === "asc" ? "当前升序，点切降序" : "当前降序，点切升序"}>
            <Button
              icon={dir === "asc" ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
              onClick={() => onSort(sortBy, dir === "asc" ? "desc" : "asc")}
            />
          </Tooltip>
        </Space.Compact>

        {onIncludeArchived ? (
          <Checkbox
            checked={Boolean(includeArchived)}
            onChange={(e) => onIncludeArchived(e.target.checked)}
          >
            <span style={{ fontSize: 13 }}>含已归档</span>
          </Checkbox>
        ) : null}

        {busy ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            查询中…
          </Typography.Text>
        ) : null}

        <div style={{ marginInlineStart: "auto" }}>{actions}</div>
      </Flex>
    </Card>
  );
}

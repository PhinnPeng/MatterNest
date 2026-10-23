"use client";

import { useState, type ReactNode } from "react";
import { Select, Spin } from "antd";

export type InlineOption = { value: string; label: string };

/**
 * 表格里的行内下拉（2026-10-22 用户要求：点单元格里的当前值就地切换）。
 *
 * 读态与普通单元格逐字相同，点下去那一格才长出 `Select`——一屏 20 行 × 3 个可编辑列，
 * 常驻下拉就是 60 个带边框的控件，读表变成读表单。
 *
 * 两处细节不是装饰：
 *   · 点击一律 `stopPropagation`：整行点击是"进详情"，改字段不该顺带跳页；
 *   · 选回同一个值时**不回调**（`onPick` 只在真变了才触发），否则服务端回 `empty`、
 *     界面上是一次没来由的报错。
 */
export function InlineSelect({
  value,
  display,
  options,
  onPick,
  disabled,
  title,
  loading,
  onOpen,
}: {
  /** 当前值（和 `options` 的 value 同一套编码） */
  value: string;
  /** 读态显示什么；不传就显示 `value`。状态胶囊这类富展示从这里进 */
  display?: ReactNode;
  options: InlineOption[];
  onPick: (next: string) => void;
  /** 不可改的行（已归档）仍显示值，只是点不开 */
  disabled?: boolean;
  /** 悬停提示，说明"为什么点不开"或"点了会做什么" */
  title?: string;
  /** 选项是异步取的（经办人候选按行取），取的时候给个转圈 */
  loading?: boolean;
  /** 第一次展开时回调：候选集按行取，不展开就不该发请求 */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (disabled) return <span title={title}>{display ?? value}</span>;

  if (!open) {
    return (
      <button
        type="button"
        className="cell-edit"
        title={title ?? "点击修改"}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
          onOpen?.();
        }}
      >
        {display ?? value}
      </button>
    );
  }

  return (
    <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-block", minWidth: 90 }}>
      <Select
        size="small"
        autoFocus
        open
        // 失焦即收起：点别处等于放弃这次修改，不弹二次确认
        onOpenChange={(v) => {
          if (!v) setOpen(false);
        }}
        value={value || undefined}
        options={options}
        loading={loading}
        notFoundContent={loading ? <Spin size="small" /> : "没有可选的值"}
        popupMatchSelectWidth={false}
        style={{ width: "100%", minWidth: 90 }}
        onSelect={(v) => {
          setOpen(false);
          if (v !== value) onPick(v);
        }}
      />
    </span>
  );
}

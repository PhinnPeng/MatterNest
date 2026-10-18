"use client";

import type { ReactNode } from "react";

/**
 * 查询区（canon 的 `.query` 那一行）。
 *
 * 两条刻意的口径：
 *   · **提交式而不是即输即查**：条件先落在本组件的草稿里，「查询」或回车才写进 URL。
 *     上一版用 500ms 去抖，那是为了压住"每敲一个字发一次 LIKE"；提交式把这个压力
 *     从时间维度换成了意图维度——用户说查才查，比"猜他停了没有"更准，也让
 *     URL 历史里不会出现一串半截关键词。
 *   · **条件与动作同一行、动作靠右**：canon 原型 `matters.html` 的查询区就是
 *     `.query` 里一排 `.field` + 右端「查询」「重置」两个按钮（`.btn.pri` / `.btn`）。
 *
 * 2026-10-18（MATT-99）：外壳从 antd `Card`+`Flex` 换成 canon 的 `.query`；
 * 字段容器换成 `.field`；动作按钮换成 `.btn`。子控件仍是 antd 的输入件（行为不变），
 * 密度由 `theme/antd.ts` 的 token 对齐 canon 的控件高 32。
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
    <div className="query">
      {children}
      <button
        type="button"
        className="btn pri"
        disabled={busy}
        style={{ marginLeft: "auto" }}
        onClick={onSearch}
      >
        查询
      </button>
      <button type="button" className="btn" onClick={onReset}>
        重置
      </button>
    </div>
  );
}

/**
 * 查询区里的一个字段：标签在上、控件在下（canon `.field`）。
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
    <div className="field" style={{ minWidth: width, flex: `0 1 ${width}px` }}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

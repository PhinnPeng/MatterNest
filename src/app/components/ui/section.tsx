import type { CSSProperties, ReactNode } from "react";

/**
 * 详情页的内容区段（2026-10-24「文档流 + 对话栏」）。
 *
 * 替代 Tabs 内一层层 Card：区段用**标题 + 分隔线 + 间距**建立层级，
 * 不再给每块内容加边框与卡头。卡片只留给右栏评论（它需要独立滚动与输入区）。
 *
 * 规则：
 *   · 区段之间 20px + 1px `--line2`；首段去掉顶边与额外上边距；
 *   · 标题 13px/600，动作放右端；
 *   · 内容直接铺，字段表 / 表格 / 列表不再套容器。
 */
export function Section({
  title,
  count,
  extra,
  children,
  style,
}: {
  title?: ReactNode;
  count?: number;
  extra?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section className="section" style={style}>
      {title ? (
        <div className="section-h">
          <h3>
            {title}
            {count !== undefined ? <span className="num mut3">{count}</span> : null}
          </h3>
          <span className="sp" />
          {extra}
        </div>
      ) : null}
      {children}
    </section>
  );
}

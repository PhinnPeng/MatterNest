import type { ReactNode } from "react";

/**
 * 空态、错误态、不可见态。这三种状态在内部系统里出现频率极高（范围收窄、筛太窄、会话过期），
 * 规则没随换库变：**说清下一步能干什么**，而不是留一句"暂无数据"。
 *
 * 分开两种语气是有依据的：
 *   · `denied` 用 warning 而不是 error——"打不开"多半是数据范围，不是系统坏了；
 *     权限草案 §1 元规则 3 让不可见与不存在都回 404，界面措辞也得保持这个不区分。
 *   · `error` 才用红色，并且要能把原文错误带出来（排查时"读取出错"四个字没有价值）。
 *
 * 2026-10-18（MATT-99）：换成 canon 的类。空态是 `.empty`（46px 居中、事实 + 动作）；
 * 错误/不可见态没有专用类，用 `--red` / `--amber` 的**描边 + 词头**表达语气
 * （canon 不用色块面积表达状态，色只做辅助）。两处都不再引 antd。
 */
export function StateBlock({
  title,
  hint,
  action,
  tone = "empty",
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  tone?: "empty" | "error" | "denied";
}) {
  if (tone === "empty") {
    return (
      <div className="empty">
        <div>{title}</div>
        {hint ? (
          <div className="mut3" style={{ fontSize: 12, maxWidth: 460, margin: "4px auto 0" }}>
            {hint}
          </div>
        ) : null}
        {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
      </div>
    );
  }

  const color = tone === "error" ? "var(--red)" : "var(--amber)";
  return (
    <div
      role="alert"
      style={{
        border: `1px solid ${color}`,
        borderRadius: "var(--radius)",
        padding: "12px 14px",
        fontSize: 13,
      }}
    >
      <div style={{ color }}>{title}</div>
      {hint ? (
        <div className="mut" style={{ fontSize: 12, marginTop: 4 }}>
          {hint}
        </div>
      ) : null}
      {action ? <div style={{ marginTop: 10 }}>{action}</div> : null}
    </div>
  );
}

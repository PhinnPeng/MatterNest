import { INK } from "@/app/theme/brand";
import type { ReactNode } from "react";
import { Alert, Empty, Flex } from "antd";

/**
 * 空态、错误态、不可见态。这三种状态在内部系统里出现频率极高（范围收窄、筛太窄、会话过期），
 * 规则没随换库变：**说清下一步能干什么**，而不是留一句"暂无数据"。
 *
 * 分开两种语气是有依据的：
 *   · `denied` 用 warning 而不是 error——"打不开"多半是数据范围，不是系统坏了；
 *     权限草案 §1 元规则 3 让不可见与不存在都回 404，界面措辞也得保持这个不区分。
 *   · `error` 才用红色，并且要能把原文错误带出来（排查时"读取出错"四个字没有价值）。
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
  if (tone === "error" || tone === "denied") {
    return (
      <Alert
        type={tone === "error" ? "error" : "warning"}
        showIcon
        message={title}
        description={
          hint || action ? (
            <Flex vertical gap={8} style={{ marginTop: 4 }}>
              {hint ? <span style={{ fontSize: 12 }}>{hint}</span> : null}
              {action}
            </Flex>
          ) : null
        }
      />
    );
  }

  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <Flex vertical gap={4} align="center">
          <span style={{ fontSize: 13 }}>{title}</span>
          {hint ? (
            <span style={{ fontSize: 12, color: INK.muted, maxWidth: 460 }}>{hint}</span>
          ) : null}
        </Flex>
      }
    >
      {action}
    </Empty>
  );
}

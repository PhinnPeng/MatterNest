"use client";

import Link from "next/link";
import { Button } from "antd";

import { StateBlock } from "@/app/components/ui/state-block";
import { ErrorArt } from "@/app/components/ui/error-art";

/**
 * 根级错误边界（Next App Router 约定）。
 *
 * 在它之前，页面渲染抛错会落到 Next 的默认错误页——白底、英文、和本仓视觉无关。
 * 这份兜底只做一件事：把"整页失败"画成与空态/读取出错同一套语言（`StateBlock layout=page`），
 * 并给两个出口：重试（`reset`）与回工作台。
 *
 * 注意它**没有 AppShell**（根 layout 只有 Providers）：错误边界本身必须比导航更可靠，
 * 导航若也依赖出错的数据，就会二次崩。
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 720 }}>
        <StateBlock
          layout="page"
          art={<ErrorArt variant="error" />}
          tone="error"
          title="页面出错了"
          hint={error.message || "渲染这段内容时发生了异常，可以重试一次。"}
          action={
            <div className="rowflex" style={{ gap: 8, justifyContent: "center" }}>
              <Button size="small" onClick={reset}>
                重试
              </Button>
              <Link href="/">
                <Button size="small">回工作台</Button>
              </Link>
            </div>
          }
        />
      </div>
    </div>
  );
}

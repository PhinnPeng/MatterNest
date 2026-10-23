import Link from "next/link";

import { StateBlock } from "@/app/components/ui/state-block";
import { ErrorArt } from "@/app/components/ui/error-art";

/**
 * 根级 404（Next App Router 约定）：未知路由落到这里，而不是 Next 默认的英文白页。
 *
 * 与详情页的 404 同一套语气（`denied`）：地址写错与记录不可见对用户是同一件事——
 * 这一页都打不开。区别只在文案不必再提"数据范围"。
 */
export default function NotFound() {
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
          art={<ErrorArt variant="not-found" />}
          tone="denied"
          title="页面不存在"
          hint="地址可能写错了，或这条记录已经被删除。"
          action={
            <Link href="/" className="btn">
              回工作台
            </Link>
          }
        />
      </div>
    </div>
  );
}

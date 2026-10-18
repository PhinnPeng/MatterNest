import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "登录 · MatterNest" };

/**
 * 登录页。**server component 空壳**（禁令⑥）：这里不 import 任何 `lib/server/**`，
 * 认证只经 `/api/auth/login`（禁令⑤ —— 鉴权必须在 handler 内；middleware 会跳过未匹配路径，
 * 而且 Server Function 会绕过 middleware）。
 *
 * ⚠ 这个文件里**一个 antd 组件都不能出现**：antd 的组件全都带 hook，
 * 在 Server Component 里渲染会直接抛错（`Typography.Title` 也不行）。
 * 所以外壳用原生标签 + canon 类写死，所有交互与 antd 都在 `login-form.tsx` 那侧。
 *
 * 构图（2026-10-18，MATT-99）：换成 canon 的目标态——`.login` 整页居中一张 400px `.card`
 * （`globals.css` 的 `.login`），品牌名 + 副行「内网办公系统」+ 字段 + 主按钮 + 「仅限内网访问」。
 * 上一版那套"左墨蓝满幅分栏 + 右白栏"随原型一起撤掉：canon 的登录页就是一张卡，
 * 品牌只需出现一次（两处并列会让人以为是两个东西）。
 */
export default function LoginPage() {
  return (
    <div className="login">
      <div className="card">
        <div className="card-b">
          <div className="brand" style={{ fontSize: 17, padding: "0 0 4px" }}>
            MatterNest
          </div>
          <div className="mut" style={{ fontSize: 13, marginBottom: 22 }}>
            内网办公系统
          </div>
          <LoginForm />
        </div>
      </div>
    </div>
  );
}

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
 * 构图（2026-10-20 两次采纳）：
 * ① 无壳——没有卡片容器，品牌名下面直接是表单，层级靠输入框描边与实心主按钮；
 * ② 品牌名居中并放大到 20px——居中之后它承担的是标题，不是摆在表单上方的标签。
 * 页面里不再有说明性小字：「内网办公系统」「仅限内网访问」这类复述紧邻信息的句子已撤除。
 */
export default function LoginPage() {
  return (
    <main className="login">
      <div className="login-stack">
        <h1 className="login-brand">MatterNest</h1>
        <LoginForm />
      </div>
    </main>
  );
}

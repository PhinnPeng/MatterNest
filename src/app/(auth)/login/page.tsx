import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "登录 · MatterNest" };

/**
 * 登录页。**server component 空壳**（禁令⑥）：这里不 import 任何 `lib/server/**`，
 * 认证只经 `/api/auth/login`（禁令⑤ —— 鉴权必须在 handler 内，middleware 会跳过未匹配路径，
 * 而且 Server Function 会绕过 middleware）。
 */
export default function LoginPage() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_26rem]">
      <aside className="relative hidden flex-col justify-between bg-sidebar px-10 py-9 text-sidebar-foreground lg:flex">
        <div>
          <p className="text-[0.95rem] font-semibold tracking-tight">MatterNest</p>
          <p className="mt-1 text-xs text-sidebar-foreground/55">律所内部系统</p>
        </div>
        <div className="max-w-md">
          <h1 className="text-2xl leading-9 font-medium">
            风险事项从报备到转案件，
            <br />
            一条链子上都有人看得见。
          </h1>
          <ul className="mt-5 space-y-2 text-sm text-sidebar-foreground/70">
            <li>案件与事项两套宿主，同一套节点、参与人、活动记录结构。</li>
            <li>可见范围按"全所 / 我参与 / 我承办"三档，服务端逐条请求判定。</li>
            <li>归档是终态：默认从列表消失，撤销归档要专门权限并留原因。</li>
          </ul>
        </div>
        <p className="text-xs text-sidebar-foreground/40">
          数据留在本所内网，不外发（技术选型 §6）。
        </p>
      </aside>

      <main className="flex items-center justify-center px-6 py-12">
        <LoginForm />
      </main>
    </div>
  );
}

import { BRAND } from "@/app/theme/brand";
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
 * 所以左侧面板用原生标签 + 内联样式写死，所有交互与 antd 都在 `login-form.tsx` 那侧。
 * 这条与"页面壳不许预取数据"是两回事：一个是渲染边界，一个是数据边界。
 */
export default function LoginPage() {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside
        style={{
          flex: "1 1 auto",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "36px 44px",
          background: `linear-gradient(160deg,${BRAND.sider.bg} 0%,${BRAND.sider.gradient} 100%)`,
          color: BRAND.sider.item,
        }}
      >
        <div>
          <div style={{ color: "#fff", fontSize: 16, fontWeight: 600, letterSpacing: 0.2 }}>
            MatterNest
          </div>
          <div style={{ fontSize: 11, opacity: 0.62, marginTop: 2 }}>律所内部系统</div>
        </div>
        <div style={{ maxWidth: 520 }}>
          <h1
            style={{ color: "#fff", fontSize: 24, lineHeight: "36px", fontWeight: 600, margin: 0 }}
          >
            风险事项从报备到转案件，
            <br />
            一条链子上都有人看得见。
          </h1>
          <ul
            style={{
              padding: 0,
              margin: "18px 0 0",
              listStyle: "none",
              fontSize: 13,
              lineHeight: "24px",
            }}
          >
            <li>· 案件与事项两套宿主，共用同一套节点、参与人、活动记录结构。</li>
            <li>· 可见范围按「全所 / 我参与 / 我承办」三档，服务端逐条请求判定。</li>
            <li>· 归档是终态：默认从列表消失，撤销归档要专门权限并留原因。</li>
          </ul>
        </div>
        <div style={{ fontSize: 11, opacity: 0.5 }}>数据留在本所内网，不外发（技术选型 §6）。</div>
      </aside>

      <main
        style={{
          flex: "0 0 400px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "48px 24px",
          background: "#fff",
        }}
      >
        <LoginForm />
      </main>
    </div>
  );
}

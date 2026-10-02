import { alpha, BRAND, INK, PAPER } from "@/app/theme/brand";
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
 * 所以外壳用原生标签 + 内联样式写死，所有交互与 antd 都在 `login-form.tsx` 那侧。
 * 色值仍然走唯一源 `theme/brand.ts`——那个文件不 import antd，就是为了让这里也能用。
 *
 * 构图（2026-10-03 改）：**整页纸色底 + 居中一张双栏卡片**，而不是左右满幅分栏。
 * 原因是量出来的：满幅分栏下窗口越宽越空——1892 视口时墨蓝栏占 1492px（79%）而它的文字
 * 只有 520px 宽，白栏 400px 里飘着一个 233px 的表单、上下各 456px 空白。
 * 卡片高度由内容决定，两栏各自承重，1366 与 1920 都不再有空场。
 * 一期只做 PC 宽屏（技术选型 §7 假设 G），所以窄屏只保证不溢出，不做重排。
 */
export default function LoginPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 24px",
        background: PAPER,
      }}
    >
      <div
        style={{
          width: "min(1080px, 100%)",
          minHeight: 420,
          display: "flex",
          alignItems: "stretch",
          borderRadius: 8,
          overflow: "hidden",
          // 高度只声明一次：这层用阴影，不再叠 1px 描边（描边 + 大软阴影会糊成"幽灵卡片"）
          boxShadow: `0 24px 48px -24px ${alpha(INK.body, 0.28)}, 0 2px 6px -2px ${alpha(INK.body, 0.1)}`,
        }}
      >
        <aside
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            gap: 36,
            padding: "34px 40px 30px",
            background: `linear-gradient(160deg,${BRAND.sider.bg} 0%,${BRAND.sider.gradient} 100%)`,
            color: BRAND.sider.item,
          }}
        >
          {/* 字标：与全站状态标记同一套"点 + 词"语法，不另起一种品牌表达 */}
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: BRAND.primary,
                flex: "0 0 auto",
              }}
            />
            <span style={{ color: "#fff", fontSize: 15, fontWeight: 600, letterSpacing: 0.2 }}>
              MatterNest
            </span>
            <span style={{ fontSize: 11, color: alpha(BRAND.sider.item, 0.62) }}>律所内部系统</span>
          </div>

          <div style={{ maxWidth: 520 }}>
            <h1
              style={{
                color: "#fff",
                fontSize: 26,
                lineHeight: "38px",
                fontWeight: 600,
                margin: "0 0 16px",
              }}
            >
              风险事项从报备到转案件，
              <br />
              一条链子上都有人看得见。
            </h1>
            <ul
              style={{
                padding: 0,
                margin: 0,
                listStyle: "none",
                fontSize: 13,
                lineHeight: "25px",
              }}
            >
              <li>· 案件与事项两套宿主，共用同一套节点、参与人、活动记录结构。</li>
              <li>· 可见范围按「全所 / 我参与 / 我承办」三档，服务端逐条请求判定。</li>
              <li>· 归档是终态：默认从列表消失，撤销归档要专门权限并留原因。</li>
            </ul>
          </div>

          <div style={{ fontSize: 11, color: alpha(BRAND.sider.item, 0.72) }}>
            数据留在本所内网，不外发。
          </div>
        </aside>

        <main
          style={{
            flex: "0 0 420px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "40px 44px",
            background: "#fff",
          }}
        >
          <LoginForm />
        </main>
      </div>
    </div>
  );
}

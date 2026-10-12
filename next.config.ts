import type { NextConfig } from "next";
import { xrayPlugin } from "@stinsky/xray/plugin";

/**
 * 部署形态：自托管 Docker，`output: 'standalone'`（技术选型 §13.1）。
 * 多副本必须共配 NEXT_SERVER_ACTIONS_ENCRYPTION_KEY 与 deploymentId（§13.3-3 / 部署级 a），
 * 那两个变量在运行时注入，不在这里写。
 *
 * `turbopack.rules` 挂的是 @stinsky/xray 的开发期源码定位插件：编译期往 DOM 注 `data-insp-path`，
 * 悬停即见「组件名 + 项目内源文件路径」，点击跳编辑器。它绕开了 React 19 删掉 `fiber._debugSource`
 * 的问题（LocatorJS / react-dev-inspector 那批 fiber 式工具在 R19 下全废）。
 *
 * ⚠ 只在非生产启用：本系统是内网私有化部署，生产 HTML 里带上源码路径是白给的信息泄露面。
 * 生产构建不注入属性，配套的 `<Xray/>` 组件本身也被 bundler tree-shake（零字节进包）。
 */
const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  /**
   * 允许的开发期来源。
   *
   * 这一条不是为了好看，是为了让**浏览器里能看见界面**。之前一直有个现象查不出根因：
   * 用 `http://127.0.0.1:3777` 打开页面，SSR 的 HTML 完整正确，但客户端**完全没水合**——
   * DOM 上没有 React fiber、浏览器一个 `/api/` 请求都没发、整个应用停在 loading 骨架，
   * 控制台除了 HMR WebSocket 连不上之外**没有任何报错**。同一个页面换 `localhost` 打开
   * 就一切正常。
   *
   * Next 的开发期资源（尤其 HMR 客户端）会校验来源，`127.0.0.1` 与 `localhost` 是两个不同
   * 来源，不登记就被拒。症状是"静默地不工作"，极难定位——所以写在这里。
   *
   * `127.0.0.1` 必须留着：它就是冒烟与门禁脚本用的那个地址。
   */
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  ...(isProd ? {} : { turbopack: { rules: xrayPlugin({ bundler: "turbopack", editor: "code" }) } }),
};

export default nextConfig;

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
  ...(isProd ? {} : { turbopack: { rules: xrayPlugin({ bundler: "turbopack", editor: "code" }) } }),
};

export default nextConfig;

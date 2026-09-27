import type { NextConfig } from "next";

/**
 * 部署形态：自托管 Docker，`output: 'standalone'`（技术选型 §13.1）。
 * 多副本必须共配 NEXT_SERVER_ACTIONS_ENCRYPTION_KEY 与 deploymentId（§13.3-3 / 部署级 a），
 * 那两个变量在运行时注入，不在这里写。
 */
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
};

export default nextConfig;

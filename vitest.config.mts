import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * N7 spike 踩到的一条：`@/...` 别名由 `tsconfig.paths` 提供，**vitest 不读它**。
 * 之前没有测试用到 `@/` 所以没暴露（W0-1 的漏网）。这里显式配上，
 * 否则任何"用别名 import 的模块"在测试里都会 `Cannot find package '@/shared/...'`。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    /**
     * `tools/**` 也收（2026-10-15，MATT-36）：`tools/keys.mjs` 的护栏
     * （拒绝覆盖已填的 env、核对校验值）是要保数据的，不该只靠手工跑一次。
     *
     * ⚠ 它必须留在 `tools/` 而不是搬进 `src/` —— 那是部署当天在**目标机器上**
     * 执行的工具（目标机器上只有仓库、没有构建产物）。放进 `src/` 会让它
     * 看起来像应用代码，而它其实不参与任何构建。
     *
     * `agent-work/**` 也收（2026-10-15，MATT-88）：冒烟脚本的**进程契约**是门禁的一部分 ——
     * 「环境不对时必须退出 3 且不产出任何断言」这件事，靠人记是记不住的，
     * 2026-10-15 那次 CI 红就是 `smoke-import.mjs` 把 `MN_OWN_COMPANY_NAMES` 静默降级成空串，
     * 于是那条 IQ-7 防呆断言**带着错误的前提**跑完了。
     */
    include: [
      "src/**/*.spec.ts",
      "worker/**/*.spec.ts",
      "tools/**/*.spec.ts",
      "agent-work/**/*.spec.ts",
    ],
    environment: "node",
  },
});

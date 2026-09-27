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
    include: ["src/**/*.spec.ts", "worker/**/*.spec.ts"],
    environment: "node",
  },
});
